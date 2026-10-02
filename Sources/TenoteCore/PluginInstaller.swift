import Foundation

/// Installing plugins from Settings → Plugins, and seeding the bundled examples.
public enum PluginInstaller {
    public struct InstallError: LocalizedError {
        public let message: String
        public init(_ m: String) { message = m }
        public var errorDescription: String? { message }
    }

    public static func install(from src: URL, into userDir: URL) throws -> String {
        if src.pathExtension.lowercased() == "zip" { return try installZip(src, into: userDir) }
        return try place(src, into: userDir)
    }

    static func installZip(_ zip: URL, into userDir: URL) throws -> String {
        let fm = FileManager.default
        let staging = fm.temporaryDirectory.appendingPathComponent("tenote-plugin-" + UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: staging, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: staging) }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        p.arguments = ["-x", "-k", zip.path, staging.path]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { throw InstallError("could not unpack the zip") }
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { throw InstallError("could not unpack the zip") }
        return try place(try findPluginRoot(staging), into: userDir)
    }

    static func looksLikeRoot(_ dir: URL) -> Bool {
        let fm = FileManager.default
        return fm.fileExists(atPath: dir.appendingPathComponent("plugin.json").path)
            || fm.fileExists(atPath: dir.appendingPathComponent("index.js").path)
    }

    public static func findPluginRoot(_ dir: URL) throws -> URL {
        if looksLikeRoot(dir) { return dir }
        let fm = FileManager.default
        let subs = ((try? fm.contentsOfDirectory(atPath: dir.path)) ?? []).sorted().map { dir.appendingPathComponent($0) }
        for sub in subs {
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: sub.path, isDirectory: &isDir), isDir.boolValue, looksLikeRoot(sub) { return sub }
        }
        throw InstallError("no plugin found in the zip (looking for plugin.json or index.js)")
    }

    public static func place(_ src: URL, into userDir: URL) throws -> String {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: src.path, isDirectory: &isDir) else { throw InstallError("file not found") }
        var base = src.lastPathComponent
        if !isDir.boolValue && base.hasSuffix(".js") { base = String(base.dropLast(3)) }
        var manifestName: String?
        if isDir.boolValue,
           let data = try? Data(contentsOf: src.appendingPathComponent("plugin.json")),
           let m = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            manifestName = m["name"] as? String
        }
        let name = manifestName ?? base
        guard PluginHost.slug(name) != nil else { throw InstallError("invalid plugin name: \(name)") }
        if isDir.boolValue {
            let files = (try? fm.contentsOfDirectory(atPath: src.path)) ?? []
            guard looksLikeRoot(src) || files.contains(where: { $0.hasSuffix(".js") }) else {
                throw InstallError("that folder does not look like a Tenote plugin")
            }
        }
        let dest = userDir.appendingPathComponent(name, isDirectory: true)
        guard dest.standardizedFileURL.path.hasPrefix(userDir.standardizedFileURL.path + "/") else { throw InstallError("bad destination") }
        if fm.fileExists(atPath: dest.path) {
            throw InstallError("\"\(name)\" is already installed — remove it first (Open plugins folder)")
        }
        try fm.createDirectory(at: userDir, withIntermediateDirectories: true)
        if isDir.boolValue {
            try fm.copyItem(at: src, to: dest)
        } else {
            try fm.createDirectory(at: dest, withIntermediateDirectories: true)
            try fm.copyItem(at: src, to: dest.appendingPathComponent("index.js"))
        }
        return name
    }

    /// Copies bundled examples into the user plugins dir once, disabled.
    @discardableResult
    public static func seedExamples(from examples: URL, into userDir: URL, settings: Settings, logger: Logger) -> Int {
        guard !settings.examplesSeeded else { return 0 }
        let fm = FileManager.default
        var disabled = Set(settings.disabledPlugins)
        var copied = 0
        for entry in ((try? fm.contentsOfDirectory(atPath: examples.path)) ?? []).sorted() {
            if entry.hasPrefix(".") || entry.hasPrefix("_") { continue }
            let from = examples.appendingPathComponent(entry)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: from.path, isDirectory: &isDir), isDir.boolValue else { continue }
            var name = entry
            if let data = try? Data(contentsOf: from.appendingPathComponent("plugin.json")),
               let m = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let n = PluginHost.slug(m["name"]) {
                name = n
            }
            let to = userDir.appendingPathComponent(entry)
            do {
                if !fm.fileExists(atPath: to.path) {
                    try fm.createDirectory(at: userDir, withIntermediateDirectories: true)
                    try fm.copyItem(at: from, to: to)
                    copied += 1
                }
                disabled.insert(name)
            } catch {
                logger.warn("plugins", "seed failed for example \"\(entry)\"", ["error": error.localizedDescription])
            }
        }
        settings.disabledPlugins = disabled.sorted()
        settings.examplesSeeded = true
        settings.save()
        logger.info("plugins", "seeded \(copied) example plugins (disabled)")
        return copied
    }
}
