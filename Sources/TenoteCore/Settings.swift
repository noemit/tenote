import Foundation

/// settings.json, same shape and location as the Electron build:
/// ~/Library/Application Support/Tenote/settings.json
public final class Settings {
    public var hideOnBlur = false
    public var launchAtLogin = false
    public var hideBrand = false
    public var hideRecents = false
    public var showDockIcon = false
    public var firstRunDone = false
    public var theme = "latte"
    public var lastImageSweep: Double = 0
    public var disabledPlugins: [String] = []
    public var pluginPaths: [String] = []
    public var examplesSeeded = false
    /// Per-plugin key/value store (JSON-compatible Foundation values).
    public var pluginValues: [String: [String: Any]] = [:]

    public let file: URL?
    private var extra: [String: Any] = [:]
    private var extraPlugins: [String: Any] = [:]

    public init(file: URL?) {
        self.file = file
        guard let file = file,
              let data = try? Data(contentsOf: file),
              let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        apply(raw)
    }

    public convenience init(dictionary: [String: Any]) {
        self.init(file: nil)
        apply(dictionary)
    }

    private func apply(_ raw: [String: Any]) {
        var rest = raw
        hideOnBlur = (rest.removeValue(forKey: "hideOnBlur") as? Bool) ?? hideOnBlur
        launchAtLogin = (rest.removeValue(forKey: "launchAtLogin") as? Bool) ?? launchAtLogin
        hideBrand = (rest.removeValue(forKey: "hideBrand") as? Bool) ?? hideBrand
        hideRecents = (rest.removeValue(forKey: "hideRecents") as? Bool) ?? hideRecents
        showDockIcon = (rest.removeValue(forKey: "showDockIcon") as? Bool) ?? showDockIcon
        firstRunDone = (rest.removeValue(forKey: "firstRunDone") as? Bool) ?? firstRunDone
        theme = (rest.removeValue(forKey: "theme") as? String) ?? theme
        lastImageSweep = (rest.removeValue(forKey: "lastImageSweep") as? NSNumber)?.doubleValue ?? lastImageSweep
        if var p = rest.removeValue(forKey: "plugins") as? [String: Any] {
            disabledPlugins = (p.removeValue(forKey: "disabled") as? [Any])?.compactMap { $0 as? String } ?? []
            pluginPaths = (p.removeValue(forKey: "paths") as? [Any])?.compactMap { $0 as? String } ?? []
            examplesSeeded = (p.removeValue(forKey: "examplesSeeded") as? Bool) ?? false
            if let values = p.removeValue(forKey: "values") as? [String: Any] {
                var out: [String: [String: Any]] = [:]
                for (k, v) in values { if let d = v as? [String: Any] { out[k] = d } }
                pluginValues = out
            }
            extraPlugins = p
        }
        extra = rest
    }

    public func dictionary() -> [String: Any] {
        var d = extra
        d["hideOnBlur"] = hideOnBlur
        d["launchAtLogin"] = launchAtLogin
        d["hideBrand"] = hideBrand
        d["hideRecents"] = hideRecents
        d["showDockIcon"] = showDockIcon
        d["firstRunDone"] = firstRunDone
        d["theme"] = theme
        d["lastImageSweep"] = lastImageSweep
        var p = extraPlugins
        p["disabled"] = disabledPlugins
        p["paths"] = pluginPaths
        p["values"] = pluginValues
        p["examplesSeeded"] = examplesSeeded
        d["plugins"] = p
        return d
    }

    /// Write-then-rename so a crash mid-write can't leave a truncated file.
    @discardableResult
    public func save() -> Error? {
        guard let file = file else { return nil }
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            let obj = JSONCompat.sanitize(dictionary())
            let data = try JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: file, options: .atomic)
            return nil
        } catch {
            return error
        }
    }
}

/// Helpers for Foundation values that cross the JS boundary.
public enum JSONCompat {
    /// Drops anything JSONSerialization cannot encode (NaN, functions, dates…).
    public static func sanitize(_ value: Any) -> Any {
        switch value {
        case let d as [String: Any]:
            var out: [String: Any] = [:]
            for (k, v) in d { out[k] = sanitize(v) }
            return out
        case let a as [Any]:
            return a.map { sanitize($0) }
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return n }
            return n.doubleValue.isFinite ? n : NSNull()
        case is String, is NSNull:
            return value
        case let date as Date:
            return ISO8601DateFormatter().string(from: date)
        default:
            return NSNull()
        }
    }

    public static func string(_ value: Any) -> String? {
        let obj = sanitize(value)
        if let s = obj as? String {
            if let d = try? JSONSerialization.data(withJSONObject: [s], options: [.fragmentsAllowed]),
               let str = String(data: d, encoding: .utf8) { return String(str.dropFirst().dropLast()) }
            return nil
        }
        guard let d = try? JSONSerialization.data(withJSONObject: obj, options: [.fragmentsAllowed]) else { return nil }
        return String(data: d, encoding: .utf8)
    }
}
