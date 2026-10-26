import AppKit
import Foundation
import TenoteCore

/// Mac App Store builds are sandboxed, so `~/Documents` is not ours to use until
/// the user picks it. This resolves a security-scoped bookmark on launch and
/// shows the folder picker once when there isn't one yet.
///
/// The bookmark lives in the MAS container (`userDataDir`), so it never leaks
/// into the direct build's settings.
enum NotesLocation {
    private static var accessed: URL?

    static func resolve(userDataDir: URL, logger: Logger) -> URL? {
        let bookmarkFile = userDataDir.appendingPathComponent("notes.bookmark")

        if let data = try? Data(contentsOf: bookmarkFile) {
            var stale = false
            if let url = try? URL(resolvingBookmarkData: data,
                                  options: [.withSecurityScope],
                                  relativeTo: nil,
                                  bookmarkDataIsStale: &stale) {
                if url.startAccessingSecurityScopedResource() {
                    accessed = url
                    if stale { save(url, to: bookmarkFile, logger: logger) }
                    logger.info("app", "notes bookmark resolved", ["path": url.path, "stale": stale])
                    return url
                }
                logger.warn("app", "notes bookmark access denied", ["path": url.path])
            } else {
                logger.warn("app", "notes bookmark could not be resolved")
            }
        }

        guard let url = prompt(logger: logger) else { return nil }
        save(url, to: bookmarkFile, logger: logger)
        accessed = url
        return url
    }

    static func stopAccess() {
        accessed?.stopAccessingSecurityScopedResource()
        accessed = nil
    }

    private static func prompt(logger: Logger) -> URL? {
        let panel = NSOpenPanel()
        panel.title = "Where should Tenote keep your notes?"
        panel.message = "Tenote saves every note as a plain Markdown file. Choose a folder you can see in Finder — for example Documents/Tenote Notes. Your existing notes stay where they are."
        panel.prompt = "Use This Folder"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        let documents = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Documents", isDirectory: true)
        panel.directoryURL = documents

        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else {
            logger.info("app", "notes folder selection cancelled")
            return nil
        }
        guard url.startAccessingSecurityScopedResource() else {
            logger.warn("app", "notes folder access denied", ["path": url.path])
            return nil
        }
        logger.info("app", "notes folder selected", ["path": url.path])
        return url
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
