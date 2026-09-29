import Foundation
@testable import TenoteCore
import XCTest

final class NoteStoreTests: XCTestCase {
    private func store() -> NoteStore {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("tenote-notes-" + UUID().uuidString)
        return NoteStore(notesDir: d, logger: Logger.silent())
    }

    func testSerializeParseRoundTrip() {
        let meta = NoteMeta(id: "2026-08-09_14-32-05", created: "2026-08-09T14:32:05.000Z", updated: "2026-08-09T14:34:12.000Z", tags: ["idea", "work"])
        let raw = NoteStore.serialize(meta, body: "Buy milk\n\n")
        XCTAssertEqual(raw, "---\nid: 2026-08-09_14-32-05\ncreated: 2026-08-09T14:32:05.000Z\nupdated: 2026-08-09T14:34:12.000Z\ntags: [idea, work]\n---\n\nBuy milk\n")
        let parsed = NoteStore.parse(raw)
        XCTAssertEqual(parsed.meta, meta)
        XCTAssertEqual(parsed.body.trimmingCharacters(in: .whitespacesAndNewlines), "Buy milk")
    }

    func testSafeId() {
        XCTAssertEqual(NoteStore.safeId("2026-01-01_00-00-00"), "2026-01-01_00-00-00")
        XCTAssertNil(NoteStore.safeId("../etc/passwd"))
        XCTAssertNil(NoteStore.safeId(String(repeating: "a", count: 81)))
    }

    func testSaveReadListAndDeleteEmpty() {
        let s = store()
        let r = s.save(id: nil, text: "# Hello\nworld", tags: ["x"])
        XCTAssertEqual(r["ok"] as? Bool, true)
        let id = r["id"] as? String
        XCTAssertNotNil(id)
        XCTAssertEqual(s.read(id)?["body"] as? String, "# Hello\nworld\n")
        XCTAssertEqual(s.list().count, 1)
        _ = s.save(id: id, text: "   ", tags: [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: s.file(for: id!).path))
    }

    func testNewNotesInSameSecondDoNotCollide() {
        let s = store()
        let fixed = Date(timeIntervalSince1970: 1_800_000_000)
        s.now = { fixed }
        let a = s.save(id: nil, text: "a", tags: [])["id"] as? String
        let b = s.save(id: nil, text: "b", tags: [])["id"] as? String
        XCTAssertNotEqual(a, b)
    }

    func testRejectsHugeNote() {
        let s = store()
        let r = s.save(id: nil, text: String(repeating: "x", count: NoteStore.maxNoteChars + 1), tags: [])
        XCTAssertEqual(r["ok"] as? Bool, false)
    }

    func testAttachImageAndResolve() {
        let s = store()
        let r = s.attachImage(mime: "image/png", base64: Data([0x89, 0x50, 0x4E, 0x47]).base64EncodedString())
        XCTAssertEqual(r["ok"] as? Bool, true)
        let rel = r["path"] as? String ?? ""
        XCTAssertTrue(rel.hasPrefix("images/img-"))
        let b64 = Data(rel.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        XCTAssertNotNil(s.imageFile(forEncodedPath: b64))
        XCTAssertEqual(s.attachImage(mime: "image/tiff", base64: "AAAA")["ok"] as? Bool, false)
        let evil = Data("images/../../x".utf8).base64EncodedString()
        XCTAssertNil(s.imageFile(forEncodedPath: evil))
    }

    func testAcceleratorParsing() {
        let a = Accelerator("Alt+.")
        XCTAssertEqual(a?.keyCode, 47)
        XCTAssertEqual(a?.modifiers, Accelerator.optionKey)
        XCTAssertEqual(Accelerator("Alt+Shift+.")?.modifiers, Accelerator.optionKey | Accelerator.shiftKey)
        XCTAssertNil(Accelerator("Hyper+Q"))
        XCTAssertEqual(Accelerator.label("Alt+Shift+."), "⌥⇧.")
    }

    func testSettingsPreserveUnknownKeys() {
        let s = Settings(dictionary: ["theme": "mocha", "futureKey": 3, "plugins": ["disabled": ["a"], "extra": true]])
        XCTAssertEqual(s.theme, "mocha")
        XCTAssertEqual(s.disabledPlugins, ["a"])
        let d = s.dictionary()
        XCTAssertEqual(d["futureKey"] as? Int, 3)
        XCTAssertEqual((d["plugins"] as? [String: Any])?["extra"] as? Bool, true)
    }
}
