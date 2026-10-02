import Foundation

/// Every on-disk location Tenote uses. Kept identical to the Electron build so
/// existing notes, settings and plugins carry over untouched.
public struct TenotePaths {
    public let notesDir: URL
    public let userDataDir: URL
    public let settingsFile: URL
    public let pluginsUserDir: URL
    public let pluginDataRoot: URL
    public let logDir: URL
    public let socketPath: String

    public init(environment env: [String: String] = ProcessInfo.processInfo.environment) {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser
        let documents = fm.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? home.appendingPathComponent("Documents")
        let appSupport = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? home.appendingPathComponent("Library/Application Support")
        notesDir = documents.appendingPathComponent("Tenote Notes", isDirectory: true)
        userDataDir = appSupport.appendingPathComponent("Tenote", isDirectory: true)
        settingsFile = userDataDir.appendingPathComponent("settings.json")
        pluginsUserDir = userDataDir.appendingPathComponent("plugins", isDirectory: true)
        pluginDataRoot = userDataDir.appendingPathComponent("plugin-data", isDirectory: true)
        if let dir = env["TENOTE_LOG_DIR"], !dir.isEmpty {
            logDir = URL(fileURLWithPath: dir, isDirectory: true)
        } else {
            logDir = home.appendingPathComponent("Library/Logs/Tenote", isDirectory: true)
        }
        socketPath = TenotePaths.defaultSocketPath(environment: env)
    }

    /// Must match between the app and tenotectl (and any skhd binding).
    public static func defaultSocketPath(environment env: [String: String] = ProcessInfo.processInfo.environment) -> String {
        if let s = env["TENOTE_SOCKET"], !s.isEmpty { return s }
        let tmp = env["TMPDIR"].flatMap { $0.isEmpty ? nil : $0 } ?? NSTemporaryDirectory()
        return URL(fileURLWithPath: tmp).appendingPathComponent("tenote-\(getuid()).sock").path
    }
}

/// Locates the bundled web UI, builtin plugins, examples and assets: inside
/// Tenote.app they live in Contents/Resources; during `swift run` they are
/// found by walking up from the executable to the repository root.
public enum ResourceLocator {
    public static func root(environment env: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        let fm = FileManager.default
        if let r = env["TENOTE_RESOURCES"], !r.isEmpty { return URL(fileURLWithPath: r, isDirectory: true) }
        if let res = Bundle.main.resourceURL,
           fm.fileExists(atPath: res.appendingPathComponent("renderer/index.html").path) {
            return res
        }
        var dir = URL(fileURLWithPath: CommandLine.arguments.first ?? ".").resolvingSymlinksInPath().deletingLastPathComponent()
        for _ in 0..<8 {
            if fm.fileExists(atPath: dir.appendingPathComponent("renderer/index.html").path) { return dir }
            dir.deleteLastPathComponent()
        }
        return URL(fileURLWithPath: fm.currentDirectoryPath, isDirectory: true)
    }
}
