import Foundation

/// Tiny structured file logger: ~/Library/Logs/Tenote/main.log, rotated at 5 MB.
/// Line format matches the Electron build so `npm run logs`-era tooling still reads it.
public final class Logger {
    public enum Level: Int, Comparable {
        case debug = 10, info = 20, warn = 30, error = 40
        public static func < (a: Level, b: Level) -> Bool { a.rawValue < b.rawValue }
        public init?(name: String) {
            switch name.lowercased() {
            case "debug": self = .debug
            case "info": self = .info
            case "warn", "warning": self = .warn
            case "error": self = .error
            default: return nil
            }
        }
        var label: String {
            switch self {
            case .debug: return "DEBUG"
            case .info: return "INFO"
            case .warn: return "WARN"
            case .error: return "ERROR"
            }
        }
    }

    public static let maxSize: UInt64 = 5 * 1024 * 1024

    public let logDir: URL
    public var logFile: URL { logDir.appendingPathComponent("main.log") }
    public var minLevel: Level
    /// Receives every line that passes the level filter (tests use this).
    public var sink: ((Level, String) -> Void)?
    private let queue = DispatchQueue(label: "tenote.logger")
    private var handle: FileHandle?
    private var approxSize: UInt64 = 0
    private let writesToDisk: Bool
    private let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    public init(logDir: URL, minLevel: Level = .info, writesToDisk: Bool = true) {
        self.logDir = logDir
        self.minLevel = minLevel
        self.writesToDisk = writesToDisk
        if writesToDisk {
            try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
            rotateIfNeeded()
        }
    }

    public static func silent() -> Logger {
        Logger(logDir: URL(fileURLWithPath: NSTemporaryDirectory()), minLevel: .debug, writesToDisk: false)
    }

    public func debug(_ tag: String, _ msg: String, _ data: [String: Any]? = nil) { log(.debug, tag, msg, data) }
    public func info(_ tag: String, _ msg: String, _ data: [String: Any]? = nil) { log(.info, tag, msg, data) }
    public func warn(_ tag: String, _ msg: String, _ data: [String: Any]? = nil) { log(.warn, tag, msg, data) }
    public func error(_ tag: String, _ msg: String, _ data: [String: Any]? = nil) { log(.error, tag, msg, data) }

    public func log(_ level: Level, _ tag: String, _ msg: String, _ data: [String: Any]? = nil) {
        guard level >= minLevel else { return }
        var extra: String?
        if let data = data {
            extra = JSONCompat.string(data) ?? String(describing: data)
        }
        log(level, tag, msg, extraJSON: extra)
    }

    /// `extraJSON` is appended verbatim (already-serialized data from JS plugins).
    public func log(_ level: Level, _ tag: String, _ msg: String, extraJSON: String?) {
        guard level >= minLevel else { return }
        let extra = extraJSON.map { " " + $0 } ?? ""
        let line = "\(isoFormatter.string(from: Date())) [\(level.label)] [\(tag)] \(msg)\(extra)"
        sink?(level, line)
        if level >= .warn { FileHandle.standardError.write((line + "\n").data(using: .utf8) ?? Data()) }
        guard writesToDisk else { return }
        queue.async { [weak self] in self?.write(line + "\n") }
    }

    public func flush() {
        guard writesToDisk else { return }
        queue.sync { try? handle?.synchronize() }
    }

    private func rotateIfNeeded() {
        let fm = FileManager.default
        guard let attrs = try? fm.attributesOfItem(atPath: logFile.path),
              let size = attrs[.size] as? UInt64, size > Logger.maxSize else { return }
        let rotated = logDir.appendingPathComponent("main.log.1")
        try? fm.removeItem(at: rotated)
        try? fm.moveItem(at: logFile, to: rotated)
    }

    private func write(_ line: String) {
        let fm = FileManager.default
        if handle == nil {
            try? fm.createDirectory(at: logDir, withIntermediateDirectories: true)
            if !fm.fileExists(atPath: logFile.path) { fm.createFile(atPath: logFile.path, contents: nil) }
            handle = try? FileHandle(forWritingTo: logFile)
            _ = try? handle?.seekToEnd()
            approxSize = (try? fm.attributesOfItem(atPath: logFile.path)[.size] as? UInt64) ?? 0
        }
        guard let h = handle, let data = line.data(using: .utf8) else { return }
        h.write(data)
        approxSize += UInt64(data.count)
        if approxSize > Logger.maxSize {
            approxSize = 0
            try? h.close()
            handle = nil
            rotateIfNeeded()
        }
    }
}
