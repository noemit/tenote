import Foundation

public struct NoteMeta: Equatable {
    public var id: String?
    public var created: String?
    public var updated: String?
    public var tags: [String]
    public init(id: String? = nil, created: String? = nil, updated: String? = nil, tags: [String] = []) {
        self.id = id; self.created = created; self.updated = updated; self.tags = tags
    }
}

/// Plain-Markdown note storage in ~/Documents/Tenote Notes. File format:
///
///     ---
///     id: 2026-08-09_14-32-05
///     created: 2026-08-09T14:32:05.000Z
///     updated: 2026-08-09T14:34:12.000Z
///     tags: [idea, work]
///     ---
///
///     Buy milk
public final class NoteStore {
    public static let maxNoteChars = 4 * 1024 * 1024
    public static let maxImageBytes = 15 * 1024 * 1024
    public static let sweepMinAge: TimeInterval = 7 * 24 * 60 * 60

    public let notesDir: URL
    public var imagesDir: URL { notesDir.appendingPathComponent("images", isDirectory: true) }
    let logger: Logger
    public var now: () -> Date = Date.init

    public init(notesDir: URL, logger: Logger) {
        self.notesDir = notesDir
        self.logger = logger
    }

    // MARK: format

    public static func serialize(_ meta: NoteMeta, body: String) -> String {
        let tags = meta.tags.joined(separator: ", ")
        return "---\nid: \(meta.id ?? "")\ncreated: \(meta.created ?? "")\nupdated: \(meta.updated ?? "")\ntags: [\(tags)]\n---\n\n\(trimTrailingWhitespace(body))\n"
    }

    public static func parse(_ raw: String) -> (meta: NoteMeta, body: String) {
        var meta = NoteMeta()
        var body = raw
        let fm = try! NSRegularExpression(pattern: "^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?")
        let ns = raw as NSString
        if let m = fm.firstMatch(in: raw, range: NSRange(location: 0, length: ns.length)) {
            body = ns.substring(from: m.range.length)
            let header = ns.substring(with: m.range(at: 1))
            let kvRe = try! NSRegularExpression(pattern: "^([A-Za-z]+):\\s*(.*)$")
            for line in header.components(separatedBy: "\n") {
                let l = line.hasSuffix("\r") ? String(line.dropLast()) : line
                let ln = l as NSString
                guard let kv = kvRe.firstMatch(in: l, range: NSRange(location: 0, length: ln.length)) else { continue }
                let k = ln.substring(with: kv.range(at: 1))
                let v = ln.substring(with: kv.range(at: 2)).trimmingCharacters(in: .whitespaces)
                switch k {
                case "tags":
                    var inner = v
                    if inner.hasPrefix("[") { inner.removeFirst() }
                    if inner.hasSuffix("]") { inner.removeLast() }
                    meta.tags = inner.split(separator: ",", omittingEmptySubsequences: false)
                        .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                case "id": meta.id = unquote(v)
                case "created": meta.created = unquote(v)
                case "updated": meta.updated = unquote(v)
                default: break
                }
            }
        }
        let leading = try! NSRegularExpression(pattern: "^[ \\t\\r\\n\\f\\v]*\\n")
        let b = body as NSString
        if let m = leading.firstMatch(in: body, range: NSRange(location: 0, length: b.length)) {
            body = b.substring(from: m.range.length)
        }
        return (meta, body)
    }

    public static func safeId(_ id: String?) -> String? {
        guard let id = id, !id.isEmpty, id.count <= 80 else { return nil }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.:")
        return id.unicodeScalars.allSatisfy { allowed.contains($0) } ? id : nil
    }

    public static func sanitizeTags(_ tags: [Any]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for t in tags {
            var s = (t as? String) ?? String(describing: t)
            if s.hasPrefix("#") { s.removeFirst() }
            s = String(String.UnicodeScalarView(s.unicodeScalars.filter(isTagScalar)))
            if s.utf16.count > 24 { s = String(decoding: Array(s.utf16.prefix(24)), as: UTF16.self) }
            if !s.isEmpty && !seen.contains(s) { seen.insert(s); out.append(s) }
            if out.count >= 8 { break }
        }
        return out
    }

    private static func isTagScalar(_ u: Unicode.Scalar) -> Bool {
        let v = u.value
        if (0x30...0x39).contains(v) || (0x41...0x5A).contains(v) || (0x61...0x7A).contains(v) { return true }
        if v == 0x5F || v == 0x2D || v == 0x2B { return true }
        return v >= 0xC0
    }

    public static func formatTimestamp(_ d: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: d)
        func p(_ n: Int?) -> String { String(format: "%02d", n ?? 0) }
        return "\(c.year ?? 0)-\(p(c.month))-\(p(c.day))_\(p(c.hour))-\(p(c.minute))-\(p(c.second))"
    }

    public static func iso(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC")
        return f.string(from: d)
    }

    public static func title(of body: String) -> String {
        for line in body.components(separatedBy: "\n") {
            var t = line.trimmingCharacters(in: .whitespacesAndNewlines)
            while t.hasPrefix("#") { t.removeFirst() }
            t = t.trimmingCharacters(in: .whitespaces)
            if !t.isEmpty { return t.count > 70 ? String(t.prefix(70)) + "…" : t }
        }
        return "Untitled"
    }

    public static func snippet(of body: String) -> String {
        let lines = body.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        var s = lines.dropFirst().joined(separator: " ")
        if s.isEmpty { s = lines.first ?? "" }
        return s.count > 140 ? String(s.prefix(140)) + "…" : s
    }

    static func trimTrailingWhitespace(_ s: String) -> String {
        var out = Substring(s)
        while let last = out.last, last.isWhitespace { out.removeLast() }
        return String(out)
    }

    static func unquote(_ v: String) -> String {
        var s = Substring(v)
        if let f = s.first, f == "'" || f == "\"" { s.removeFirst() }
        if let l = s.last, l == "'" || l == "\"" { s.removeLast() }
        return String(s)
    }

    // MARK: storage

    public func file(for id: String) -> URL { notesDir.appendingPathComponent(id + ".md") }

    private func mdFiles() -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: notesDir.path)) ?? []).filter { $0.hasSuffix(".md") }
    }

    /// Writes (or deletes, when empty) a note. `payload` is already through the
    /// plugin `note:before-save` pipeline. `onSaved` receives the event payload.
    public func save(id rawId: Any?, text: String, tags: [Any], onSaved: ([String: Any]) -> Void = { _ in }) -> [String: Any] {
        if text.utf16.count > NoteStore.maxNoteChars {
            return ["ok": false, "error": "note is too large (max 4 MB) — split it up"]
        }
        let fm = FileManager.default
        var created: String?
        var id: String
        if let clean = NoteStore.safeId(rawId as? String) {
            id = clean
            if let raw = try? String(contentsOf: file(for: clean), encoding: .utf8) {
                created = NoteStore.parse(raw).meta.created
            }
        } else {
            let base = NoteStore.formatTimestamp(now())
            id = base
            var n = 2
            while fm.fileExists(atPath: file(for: id).path) { id = "\(base)-\(n)"; n += 1 }
        }
        let f = file(for: id)
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if fm.fileExists(atPath: f.path) {
                do {
                    try fm.removeItem(at: f)
                    logger.info("note", "deleted empty note", ["id": id])
                    onSaved(["id": id, "deleted": true])
                } catch {
                    return ["ok": false, "error": error.localizedDescription]
                }
            }
            return ["ok": true, "id": id, "deleted": true]
        }
        do {
            try fm.createDirectory(at: notesDir, withIntermediateDirectories: true)
            let stamp = NoteStore.iso(now())
            let meta = NoteMeta(id: id, created: created ?? stamp, updated: stamp, tags: NoteStore.sanitizeTags(tags))
            try NoteStore.serialize(meta, body: text).write(to: f, atomically: true, encoding: .utf8)
            logger.debug("note", "saved", ["id": id, "length": text.count, "tags": meta.tags])
            onSaved(["id": id, "deleted": false, "updated": stamp])
            return ["ok": true, "id": id, "created": meta.created ?? stamp, "updated": stamp, "path": f.path, "deleted": false]
        } catch {
            logger.error("note", "save failed", ["id": id, "error": error.localizedDescription])
            return ["ok": false, "error": error.localizedDescription]
        }
    }

    public func list() -> [[String: Any]] {
        var notes: [[String: Any]] = []
        for f in mdFiles() {
            guard let raw = readHead(notesDir.appendingPathComponent(f), bytes: 2048) else { continue }
            let (meta, body) = NoteStore.parse(raw)
            notes.append([
                "id": meta.id ?? String(f.dropLast(3)),
                "created": meta.created ?? NSNull(),
                "updated": meta.updated ?? NSNull(),
                "tags": meta.tags,
                "title": NoteStore.title(of: body),
                "snippet": NoteStore.snippet(of: body),
            ])
        }
        notes.sort { (($0["updated"] as? String) ?? "") > (($1["updated"] as? String) ?? "") }
        logger.debug("note", "listed", ["count": notes.count])
        return notes
    }

    public func read(_ id: Any?) -> [String: Any]? {
        guard let clean = NoteStore.safeId(id as? String) else { return nil }
        do {
            let raw = try String(contentsOf: file(for: clean), encoding: .utf8)
            let (meta, body) = NoteStore.parse(raw)
            return ["id": clean, "created": meta.created ?? NSNull(), "updated": meta.updated ?? NSNull(), "tags": meta.tags, "body": body]
        } catch {
            logger.warn("note", "read failed", ["id": clean, "error": error.localizedDescription])
            return nil
        }
    }

    /// Most recent notes by file mtime; `total` drives the "+N more" card.
    public func recent(_ limit: Any?) -> [String: Any] {
        let requested = (limit as? NSNumber)?.intValue ?? Int((limit as? String) ?? "") ?? 3
        let n = max(1, min(requested == 0 ? 3 : requested, 8))
        let files = mdFiles()
        let fm = FileManager.default
        let stamped: [(String, Date)] = files.compactMap { f in
            guard let d = (try? fm.attributesOfItem(atPath: notesDir.appendingPathComponent(f).path))?[.modificationDate] as? Date else { return nil }
            return (f, d)
        }
        let top = stamped.sorted { $0.1 > $1.1 }.prefix(n)
        var notes: [[String: Any]] = []
        for (f, _) in top {
            guard let raw = try? String(contentsOf: notesDir.appendingPathComponent(f), encoding: .utf8) else { continue }
            let (meta, body) = NoteStore.parse(raw)
            notes.append([
                "id": meta.id ?? String(f.dropLast(3)),
                "updated": meta.updated ?? NSNull(),
                "title": NoteStore.title(of: body),
                "snippet": NoteStore.snippet(of: body),
                "tags": meta.tags,
            ])
        }
        return ["notes": notes, "total": files.count]
    }

    public func attachImage(mime rawMime: String, base64: String) -> [String: Any] {
        let mime = rawMime.lowercased()
        let exts = ["image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"]
        guard let ext = exts[mime] else { return ["ok": false, "error": "unsupported image type: " + mime] }
        guard !base64.isEmpty else { return ["ok": false, "error": "no image data"] }
        guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else { return ["ok": false, "error": "bad image data"] }
        guard !data.isEmpty, data.count <= NoteStore.maxImageBytes else { return ["ok": false, "error": "image too large (max 15MB)"] }
        do {
            try FileManager.default.createDirectory(at: imagesDir, withIntermediateDirectories: true)
            let ms = Int64(now().timeIntervalSince1970 * 1000)
            let chars = Array("abcdefghijklmnopqrstuvwxyz0123456789")
            let rand = String((0..<4).map { _ in chars[Int.random(in: 0..<chars.count)] })
            let name = "img-\(String(ms, radix: 36))-\(rand).\(ext)"
            try data.write(to: imagesDir.appendingPathComponent(name), options: .atomic)
            logger.info("note", "image attached", ["name": name, "bytes": data.count, "mime": mime])
            return ["ok": true, "path": "images/" + name]
        } catch {
            logger.error("note", "attach failed", ["error": error.localizedDescription])
            return ["ok": false, "error": error.localizedDescription]
        }
    }

    /// Deletes Tenote-created images no note references anymore. Only files
    /// matching our own naming pattern, and only once older than a week (a
    /// synced note that references it may not have arrived yet).
    @discardableResult
    public func sweepOrphanImages() -> Int {
        let fm = FileManager.default
        guard fm.fileExists(atPath: imagesDir.path) else { return 0 }
        var refs = Set<String>()
        let refRe = try! NSRegularExpression(pattern: "!\\[[^\\]]*\\]\\((images/[^)\\s]+)\\)")
        for f in mdFiles() {
            guard let raw = try? String(contentsOf: notesDir.appendingPathComponent(f), encoding: .utf8) else { continue }
            let ns = raw as NSString
            for m in refRe.matches(in: raw, range: NSRange(location: 0, length: ns.length)) {
                refs.insert(ns.substring(with: m.range(at: 1)))
            }
        }
        let own = try! NSRegularExpression(pattern: "^img-[a-z0-9]+-[a-z0-9]{4}\\.(png|jpe?g|gif|webp)$", options: .caseInsensitive)
        var removed = 0
        for f in (try? fm.contentsOfDirectory(atPath: imagesDir.path)) ?? [] {
            let ns = f as NSString
            guard own.firstMatch(in: f, range: NSRange(location: 0, length: ns.length)) != nil else { continue }
            if refs.contains("images/" + f) { continue }
            let p = imagesDir.appendingPathComponent(f)
            guard let mtime = (try? fm.attributesOfItem(atPath: p.path))?[.modificationDate] as? Date,
                  now().timeIntervalSince(mtime) >= NoteStore.sweepMinAge else { continue }
            if (try? fm.removeItem(at: p)) != nil { removed += 1 }
        }
        if removed > 0 { logger.info("note", "swept \(removed) orphaned image(s)") }
        return removed
    }

    /// Resolves a `timg://file/<base64url relative path>` payload to a file
    /// inside images/, or nil if it points anywhere else.
    public func imageFile(forEncodedPath b64url: String) -> URL? {
        var b64 = b64url.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64), let rel = String(data: data, encoding: .utf8),
              rel.hasPrefix("images/") else { return nil }
        let abs = notesDir.appendingPathComponent(rel).standardizedFileURL
        guard abs.path.hasPrefix(notesDir.standardizedFileURL.path + "/") else { return nil }
        return abs
    }

    private func readHead(_ url: URL, bytes: Int) -> String? {
        guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? h.close() }
        guard let data = try? h.read(upToCount: bytes) else { return nil }
        if let s = String(data: data, encoding: .utf8) { return s }
        // A multi-byte character may be cut at the boundary; trim and retry.
        for cut in 1...3 where data.count > cut {
            if let s = String(data: data.dropLast(cut), encoding: .utf8) { return s }
        }
        return String(decoding: data, as: UTF8.self)
    }
}
