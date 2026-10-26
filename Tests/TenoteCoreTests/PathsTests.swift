import XCTest
@testable import TenoteCore

final class PathsTests: XCTestCase {
    func testNotesDirOverrideWins() {
        let custom = URL(fileURLWithPath: "/tmp/tenote-notes-test", isDirectory: true)
        let paths = TenotePaths(environment: [:], notesDirOverride: custom)
        XCTAssertEqual(paths.notesDir.standardizedFileURL, custom.standardizedFileURL)
    }

    func testDefaultNotesDirIsTenoteNotes() {
        let paths = TenotePaths(environment: [:])
        XCTAssertEqual(paths.notesDir.lastPathComponent, "Tenote Notes")
    }
}
