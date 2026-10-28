import AppKit
import Foundation
import TenoteCore

/// Mac App Store builds are sandboxed, so `~/Documents` is not ours to use until
/// the user picks it. This owns the security-scoped bookmark and never falls
/// back to the container: `resolve` reports what is wrong, and the app decides
/// whether to re-prompt or quit.
enum NotesLocation {
    enum Resolution {
        case resolved(URL)
        case needsFolder(String)
        case unavailable(String)
    }

    private static var accessed: Set<URL> = []

    static func resolve(userDataDir: URL, logger: Logger) -> Resolution {
        let bookmarkFile = userDataDir.appendingPathComponent("notes.bookmark")
        guard let data = try? Data(contentsOf: bookmarkFile) else {
            return .needsFolder(
                "Tenote saves every note as a plain Markdown file. Choose a folder you can see in Finder — for example Documents/Tenote Notes. Your existing notes stay where they are."
            )
        }

        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data,
                                 options: [.withSecurityScope],
                                 relativeTo: nil,
                                 bookmarkDataIsStale: &stale) else {
            logger.warn("app", "notes bookmark could not be resolved")
            return .unavailable("Tenote can't read the saved notes folder. Choose it again, or pick a different folder.")
        }

        guard startAccess(url) else {
            logger.warn("app", "notes bookmark access denied", ["path": url.path])
            return .unavailable("Tenote can't open the notes folder. If it's on an external drive, reconnect it, or choose another folder.")
        }

        guard isDirectory(url) else {
            stop(url)
            logger.warn("app", "notes folder is missing", ["path": url.path])
            return .unavailable("The notes folder is missing — it may be on a disconnected drive. Reconnect it, or choose another folder.")
        }

        if stale { save(url, to: bookmarkFile, logger: logger) }
        logger.info("app", "notes bookmark resolved", ["path": url.path, "stale": stale])
        return .resolved(url)
    }

    /// Shows the folder picker and persists the chosen bookmark. Returns nil
    /// only when the user cancels; the caller must not fall back to the container.
    static func choose(userDataDir: URL, logger: Logger, startAt: URL? = nil) -> URL? {
        let bookmarkFile = userDataDir.appendingPathComponent("notes.bookmark")
        let panel = NSOpenPanel()
        panel.title = "Where should Tenote keep your notes?"
        panel.message = "Tenote saves every note as a plain Markdown file. Choose a folder you can see in Finder — for example Documents/Tenote Notes. Your existing notes stay where they are."
        panel.prompt = "Use This Folder"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = startAt ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Documents", isDirectory: true)

        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else {
            logger.info("app", "notes folder selection cancelled")
            return nil
        }
        guard isDirectory(url), startAccess(url) else {
            logger.warn("app", "notes folder access denied", ["path": url.path])
            return nil
        }
        save(url, to: bookmarkFile, logger: logger)
        logger.info("app", "notes folder selected", ["path": url.path])
        return url
    }

    static func stopAccess() {
        for url in accessed { url.stopAccessingSecurityScopedResource() }
        accessed.removeAll()
    }

    private static func startAccess(_ url: URL) -> Bool {
        if accessed.contains(url) { return true }
        guard url.startAccessingSecurityScopedResource() else { return false }
        accessed.insert(url)
        return true
    }

    private static func stop(_ url: URL) {
        url.stopAccessingSecurityScopedResource()
        accessed.remove(url)
    }

    private static func isDirectory(_ url: URL) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) && isDir.boolValue
    }

    private static func save(_ url: URL, to file: URL, logger: Logger) {
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            let data = try url.bookmarkData(options: [.withSecurityScope],
                                            includingResourceValuesForKeys: nil,
                                            relativeTo: nil)
            try data.write(to: file, options: .atomic)
        } catch {
            logger.warn("app", "could not save notes bookmark", ["error": error.localizedDescription])
        }
    }
}
