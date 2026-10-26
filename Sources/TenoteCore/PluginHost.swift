import Foundation
import JavaScriptCore

/// What plugins can reach through `tenote.notes/window/app/system`.
public protocol PluginKernel: AnyObject {
    var notesDir: String { get }
    func notesList() -> Any
    func notesRead(_ id: Any?) -> Any?
    func notesSave(_ payload: [String: Any]) -> Any
    func notesRecent(_ limit: Any?) -> Any
    func windowToggle()
    func windowShow()
    func windowHide()
    func appQuit()
    func systemStatus() -> Any
}

/// Insertion-ordered dictionary (plugin/theme order is user-visible).
struct OrderedMap<Value> {
    private(set) var keys: [String] = []
    private var storage: [String: Value] = [:]
    subscript(key: String) -> Value? {
        get { storage[key] }
        set {
            if let v = newValue {
                if storage[key] == nil { keys.append(key) }
                storage[key] = v
            } else if storage.removeValue(forKey: key) != nil {
                keys.removeAll { $0 == key }
            }
        }
    }
    var values: [Value] { keys.compactMap { storage[$0] } }
    func has(_ key: String) -> Bool { storage[key] != nil }
}

/// Discovers, activates and brokers plugins. Mirrors the contract documented
/// in docs/PLUGINS.md: layered discovery (builtin → user → settings paths →
/// TENOTE_PLUGINS), first-wins names, isolated failures, three-strike hook
/// suspension, live enable/disable.
public final class PluginHost {
    public static let strikeLimit = 3

    public struct Layer {
        public let name: String
        public let dir: URL?
        public let files: [String]
        public init(name: String, dir: URL) { self.name = name; self.dir = dir; self.files = [] }
        public init(name: String, files: [String]) { self.name = name; self.dir = nil; self.files = files }
    }

    public enum State: String { case disabled, loaded, ok, failed }

    public final class Theme {
        public let id: String
        public let name: String
        public let cssPath: URL
        public let swatch: [String]?
        public var owner: String?
        init(id: String, name: String, cssPath: URL, swatch: [String]?) {
            self.id = id; self.name = name; self.cssPath = cssPath; self.swatch = swatch
        }
    }

    public final class Record {
        public let layer: String
        public let dirName: String
        public let dir: URL
        public let isDir: Bool
        public var mainPath: URL?
        public var rendererPath: URL?
        public var themes: [Theme] = []
        public var name: String = ""
        public var version: String?
        public var description: String?
        public var state: State = .disabled
        public var error: String?
        init(layer: String, dirName: String, dir: URL, isDir: Bool) {
            self.layer = layer; self.dirName = dirName; self.dir = dir; self.isDir = isDir
        }
    }

    final class Hook {
        let fn: JSValue
        let owner: String
        var fails = 0
        init(fn: JSValue, owner: String) { self.fn = fn; self.owner = owner }
    }

    public struct TrayItem {
        public let label: String
        public let type: String
        public let checked: Bool
        public let owner: String
        let click: JSValue
    }

    public let runtime: JSRuntime
    public let settings: Settings
    let logger: Logger
    let layers: [Layer]
    let envFiles: [String]
    let pluginDataRoot: URL?
    public weak var kernel: PluginKernel?
    public var persist: () -> Void
    public var onTrayDirty: (() -> Void)?
    /// (accelerator, owner, fire) → registered?
    public var onShortcut: ((String, String, @escaping () -> Void) -> Bool)?
    public var onEmit: ((String, Any?) -> Void)?

    private var plugins = OrderedMap<Record>()
    private var commands: [String: (fn: JSValue, owner: String)] = [:]
    private var services: [String: JSValue] = [:]
    public private(set) var trayItems: [TrayItem] = []
    private var themes = OrderedMap<Theme>()
    private var hooks: [String: [Hook]] = [:]
    private var cssCache: [String: (css: String, mtime: Date?)] = [:]
    private var ready = false
    private lazy var bridge: JSValue = makeBridge()

    public init(logger: Logger, settings: Settings, layers: [Layer], envFiles: [String] = [],
                pluginDataRoot: URL?, kernel: PluginKernel? = nil, runtime: JSRuntime? = nil,
                persist: @escaping () -> Void = {}) {
        self.logger = logger
        self.settings = settings
        self.layers = layers
        self.envFiles = envFiles
        self.pluginDataRoot = pluginDataRoot
        self.kernel = kernel
        self.persist = persist
        self.runtime = runtime ?? JSRuntime(logger: logger)
    }

    // MARK: validation

    private static let slugRe = try! NSRegularExpression(pattern: "^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$")
    private static let eventRe = try! NSRegularExpression(pattern: "^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$")

    static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
    }
    public static func slug(_ s: Any?) -> String? {
        guard let s = s as? String, matches(slugRe, s) else { return nil }
        return s
    }
    public static func isEventName(_ s: String) -> Bool { matches(eventRe, s) }

    // MARK: discovery

    private struct Entry { let name: String; let dir: URL; let isDir: Bool }

    private func layerEntries(_ dir: URL) -> [Entry] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return [] }
        return names.filter { !$0.hasPrefix(".") && !$0.hasPrefix("_") }.map { n in
            let url = dir.appendingPathComponent(n)
            var isDir: ObjCBool = false
            _ = fm.fileExists(atPath: url.path, isDirectory: &isDir)
            return Entry(name: n, dir: url, isDir: isDir.boolValue)
        }.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }

    private func explicitEntries(_ files: [String]) -> [Entry] {
        let fm = FileManager.default
        return files.filter { !$0.isEmpty }.compactMap { f -> Entry? in
            let abs = URL(fileURLWithPath: (f as NSString).expandingTildeInPath).standardizedFileURL
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: abs.path, isDirectory: &isDir) else { return nil }
            var name = abs.lastPathComponent
            if !isDir.boolValue && name.hasSuffix(".js") && name != ".js" { name = String(name.dropLast(3)) }
            return Entry(name: name, dir: abs, isDir: isDir.boolValue)
        }.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }

    private static func readManifest(_ dir: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("plugin.json")) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private static func isScript(_ s: String) -> Bool { s.hasSuffix(".js") || s.hasSuffix(".mjs") }

    private func scan(_ layer: Layer, _ entry: Entry) {
        let fm = FileManager.default
        let manifest = entry.isDir ? PluginHost.readManifest(entry.dir) : nil
        let idx = entry.dir.appendingPathComponent("index.js")
        if entry.isDir && manifest == nil && !fm.fileExists(atPath: idx.path) { return }
        let rec = Record(layer: layer.name, dirName: entry.name, dir: entry.dir, isDir: entry.isDir)
        var name: String?
        if let m = manifest {
            name = PluginHost.slug(m["name"])
            rec.version = m["version"] as? String
            rec.description = m["description"] as? String
            if let main = m["main"] as? String, PluginHost.isScript(main) {
                let p = entry.dir.appendingPathComponent(main)
                if fm.fileExists(atPath: p.path) { rec.mainPath = p }
            }
            if let r = m["renderer"] as? String, PluginHost.isScript(r) {
                let p = entry.dir.appendingPathComponent(r)
                if fm.fileExists(atPath: p.path) { rec.rendererPath = p }
            }
            for t in (m["themes"] as? [Any]) ?? [] {
                guard let t = t as? [String: Any], let id = PluginHost.slug(t["id"]), let css = t["css"] as? String else { continue }
                let cssPath = entry.dir.appendingPathComponent(css)
                guard fm.fileExists(atPath: cssPath.path) else { continue }
                let swatch = (t["swatch"] as? [Any]).map { Array($0.prefix(2)).map { "\($0)" } }
                let label = (t["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? id
                rec.themes.append(Theme(id: id, name: label, cssPath: cssPath, swatch: swatch))
            }
        }
        if rec.mainPath == nil && fm.fileExists(atPath: idx.path) { rec.mainPath = idx }
        if rec.mainPath == nil && !entry.isDir && entry.dir.path.hasSuffix(".js") { rec.mainPath = entry.dir }
        rec.name = name ?? entry.name
        guard add(rec) else { return }
        for def in rec.themes {
            if themes.has(def.id) { logger.warn("plugins", "theme id collision: \"\(def.id)\" skipped"); continue }
            themes[def.id] = def
        }
    }

    private func add(_ rec: Record) -> Bool {
        if rec.mainPath == nil && rec.rendererPath == nil && rec.themes.isEmpty {
            logger.warn("plugins", "skipping \"\(rec.dirName)\" — nothing to load")
            return false
        }
        if let existing = plugins[rec.name] {
            logger.warn("plugins", "name collision: \"\(rec.name)\" from layer \"\(rec.layer)\" skipped (\(existing.layer) wins)")
            return false
        }
        plugins[rec.name] = rec
        return true
    }

    public func discover() {
        var all = layers
        if !settings.pluginPaths.isEmpty { all.append(Layer(name: "paths", files: settings.pluginPaths)) }
        if !envFiles.isEmpty { all.append(Layer(name: "env", files: envFiles)) }
        for layer in all {
            let entries = layer.dir.map(layerEntries) ?? explicitEntries(layer.files)
            for e in entries { scan(layer, e) }
        }
        let disabled = Set(settings.disabledPlugins)
        for rec in plugins.values { rec.state = disabled.contains(rec.name) ? .disabled : .loaded }
        for def in themes.values {
            let owner = plugins.values.first { def.cssPath.path.hasPrefix($0.dir.path + "/") }
            def.owner = owner?.name
            if let o = owner, o.state == .disabled { themes[def.id] = nil }
        }
    }

    // MARK: activation

    public func activateAll() {
        for rec in plugins.values where rec.state != .disabled { activate(rec) }
        ready = true
        emit("ready", [String: Any]())
    }

    public func activate(_ rec: Record) {
        guard let main = rec.mainPath else { rec.state = .ok; return }
        do {
            let mod = try runtime.load(module: main.path).get()
            var fn: JSValue?
            if runtime.isFunction(mod) { fn = mod }
            else if mod.isObject, let a = mod.forProperty("activate"), runtime.isFunction(a) { fn = a }
            guard let entry = fn else { throw JSRuntime.JSError(message: "no exported function") }
            if rec.version == nil, mod.isObject, let v = mod.forProperty("version"), v.isString { rec.version = v.toString() }
            guard let api = runtime.makeApi(bridge: bridge, name: rec.name, version: rec.version, notesDir: kernel?.notesDir ?? "") else {
                throw JSRuntime.JSError(message: "could not build plugin api")
            }
            _ = try runtime.call(entry, [api]).get()
            rec.state = .ok
            logger.info("plugins", "activated \"\(rec.name)\" (\(rec.layer))")
        } catch {
            let msg = (error as? JSRuntime.JSError)?.message ?? "\(error)"
            rec.state = .failed
            rec.error = msg.components(separatedBy: "\n").first ?? msg
            logger.error("plugins", "activation failed for \"\(rec.dirName)\"", ["error": msg])
            teardown(rec.name, hooksToo: false)
        }
    }

    private func teardown(_ name: String, hooksToo: Bool) {
        commands = commands.filter { $0.value.owner != name }
        services[name] = nil
        trayItems.removeAll { $0.owner == name }
        if hooksToo {
            for (event, subs) in hooks {
                let kept = subs.filter { $0.owner != name }
                hooks[event] = kept.isEmpty ? nil : kept
            }
        }
    }

    // MARK: events

    @discardableResult
    private func guarded(_ fn: JSValue, _ args: [Any], label: String, owner: String) -> JSValue? {
        switch runtime.call(fn, args) {
        case .success(let v): return v
        case .failure(let e):
            logger.error("plugins", "\(label) threw (\(owner))", ["error": e.message])
            return nil
        }
    }

    private func strike(_ sub: Hook, event: String, suspended: inout [Hook]) {
        sub.fails += 1
        if sub.fails >= PluginHost.strikeLimit {
            suspended.append(sub)
            logger.warn("plugins", "subscription suspended after \(PluginHost.strikeLimit) failures: \(sub.owner) on \(event)")
        }
    }

    private func dropSuspended(_ event: String, _ suspended: [Hook]) {
        guard !suspended.isEmpty, let subs = hooks[event] else { return }
        let kept = subs.filter { s in !suspended.contains { $0 === s } }
        hooks[event] = kept
    }

    public func emit(_ event: String, _ payload: Any?) {
        emitValue(event, runtime.value(payload ?? [String: Any]()))
    }

    private func emitValue(_ event: String, _ payload: JSValue) {
        if let subs = hooks[event], !subs.isEmpty {
            var suspended: [Hook] = []
            for sub in subs where guarded(sub.fn, [payload], label: "hook \(event)", owner: sub.owner) == nil {
                strike(sub, event: event, suspended: &suspended)
            }
            dropSuspended(event, suspended)
        }
        onEmit?(event, JSRuntime.foundation(payload))
    }

    public func applyBeforeSave(_ payload: [String: Any]) -> [String: Any] {
        let event = "note:before-save"
        guard let subs = hooks[event], !subs.isEmpty else { return payload }
        var current = runtime.value(payload)
        var suspended: [Hook] = []
        for sub in subs {
            guard let r = guarded(sub.fn, [current], label: event, owner: sub.owner) else {
                strike(sub, event: event, suspended: &suspended)
                continue
            }
            if r.isObject, let t = r.forProperty("text"), t.isString { current = r }
        }
        dropSuspended(event, suspended)
        return (JSRuntime.foundation(current) as? [String: Any]) ?? payload
    }

    // MARK: services / commands

    public func invoke(_ name: String, _ method: String, _ args: Any?, _ done: @escaping (Result<Any?, JSRuntime.JSError>) -> Void) {
        guard let svc = services[name], runtime.isFunction(svc.forProperty(method)) else {
            done(.failure(JSRuntime.JSError(message: "no service method: \(name).\(method)")))
            return
        }
        let arg: JSValue = args.map { runtime.value($0) } ?? JSValue(undefinedIn: runtime.context)
        switch runtime.call(svc, [arg], this: svc, method: method) {
        case .failure(let e): done(.failure(e))
        case .success(let v): runtime.settle(v, done)
        }
    }

    public func hasCommand(_ cmd: String) -> Bool { commands[cmd] != nil }

    /// nil when no such command; the raw (possibly thenable) result otherwise.
    public func runCommand(_ cmd: String) -> JSValue? {
        guard let entry = commands[cmd] else { return nil }
        return guarded(entry.fn, [], label: "command \(cmd)", owner: entry.owner)
            ?? JSValue(object: "error: \(cmd) failed", in: runtime.context)
    }

    public func clickTrayItem(at index: Int) {
        guard trayItems.indices.contains(index) else { return }
        let it = trayItems[index]
        guarded(it.click, [], label: "tray item", owner: it.owner)
    }

    // MARK: themes

    public func hasTheme(_ id: String) -> Bool { themes.has(id) }

    public func themeList() -> [[String: Any]] {
        themes.values.map { t in
            var d: [String: Any] = ["id": t.id, "name": t.name]
            d["swatch"] = t.swatch ?? NSNull()
            return d
        }
    }

    public func themeCss(_ id: String) -> String? {
        guard let def = themes[id] else { return nil }
        let mtime = (try? FileManager.default.attributesOfItem(atPath: def.cssPath.path))?[.modificationDate] as? Date
        if let c = cssCache[id], c.mtime == mtime { return c.css }
        guard let css = try? String(contentsOf: def.cssPath, encoding: .utf8) else {
            logger.warn("plugins", "theme css unreadable: \(id)")
            return nil
        }
        cssCache[id] = (css, mtime)
        return css
    }

    // MARK: listings

    public func record(named name: String) -> Record? { plugins[name] }

    public func status() -> [String: Any] {
        [
            "plugins": plugins.values.map { r -> [String: Any] in
                ["name": r.name, "version": r.version ?? NSNull(), "layer": r.layer, "state": r.state.rawValue]
            },
            "commands": commands.keys.sorted(),
            "themes": themes.keys,
        ]
    }

    public func publicList() -> [[String: Any]] {
        plugins.values.map { r in
            [
                "name": r.name,
                "version": r.version ?? NSNull(),
                "description": r.description ?? NSNull(),
                "layer": r.layer,
                "state": r.state.rawValue,
                "hasRenderer": r.rendererPath != nil,
                "themes": r.themes.map { $0.id },
            ]
        }
    }

    public func rendererEntries() -> [(id: String, path: URL)] {
        plugins.values.compactMap { r in
            guard r.state == .ok, let p = r.rendererPath else { return nil }
            return (r.name, p)
        }
    }

    public func fileAllowlist() -> [String: (dir: URL, files: Set<String>)] {
        var map: [String: (dir: URL, files: Set<String>)] = [:]
        for rec in plugins.values where rec.state != .disabled {
            var files = Set<String>()
            if let m = rec.mainPath { files.insert(m.lastPathComponent) }
            if let r = rec.rendererPath { files.insert(r.lastPathComponent) }
            for t in rec.themes { files.insert(t.cssPath.lastPathComponent) }
            for f in (try? FileManager.default.contentsOfDirectory(atPath: rec.dir.path)) ?? []
            where f.hasSuffix(".json") && f != "plugin.json" { files.insert(f) }
            map[rec.name] = (rec.dir, files)
        }
        return map
    }

    // MARK: enable / disable

    public func setEnabled(_ name: String, _ enabled: Bool) {
        var set = Set(settings.disabledPlugins)
        if enabled { set.remove(name) } else { set.insert(name) }
        settings.disabledPlugins = set.sorted()
        persist()
    }

    /// Live enable: activate now, fire `ready` only to this plugin's hooks.
    @discardableResult
    public func enable(_ name: String) -> Bool {
        guard let rec = plugins[name] else { return false }
        setEnabled(name, true)
        if rec.state != .disabled { return rec.state == .ok }
        rec.state = .loaded
        for t in rec.themes where !themes.has(t.id) { themes[t.id] = t }
        activate(rec)
        if ready, let subs = hooks["ready"] {
            for sub in subs where sub.owner == name {
                guarded(sub.fn, [runtime.value([String: Any]())], label: "hook ready", owner: sub.owner)
            }
        }
        onTrayDirty?()
        return rec.state == .ok
    }

    /// Live disable: drop everything the plugin registered. Timers it started
    /// keep running until relaunch (best-effort teardown).
    @discardableResult
    public func disable(_ name: String) -> Bool {
        guard let rec = plugins[name] else { return false }
        setEnabled(name, false)
        teardown(name, hooksToo: true)
        for t in rec.themes where themes[t.id] === t { themes[t.id] = nil }
        rec.state = .disabled
        onTrayDirty?()
        return true
    }

    public func shutdown() {
        guard ready else { return }
        emit("app:before-quit", [String: Any]())
    }

    // MARK: JS bridge

    private func put(_ obj: JSValue, _ name: String, _ block: AnyObject) {
        obj.setObject(block, forKeyedSubscript: name as NSString)
    }

    private func makeBridge() -> JSValue {
        let ctx = runtime.context
        let h: JSValue = JSValue(newObjectIn: ctx)
        let log = logger

        let dataDir: @convention(block) (String) -> String = { [weak self] owner in
            let base = self?.pluginDataRoot ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            let dir = base.appendingPathComponent(owner, isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            return dir.path
        }
        put(h, "dataDir", unsafeBitCast(dataDir, to: AnyObject.self))

        let on: @convention(block) (String, String, JSValue) -> Bool = { [weak self] owner, event, fn in
            guard let self = self, PluginHost.isEventName(event) else { return false }
            self.hooks[event, default: []].append(Hook(fn: fn, owner: owner))
            return true
        }
        put(h, "on", unsafeBitCast(on, to: AnyObject.self))

        let emit: @convention(block) (String, String, JSValue) -> Bool = { [weak self] _, event, payload in
            guard let self = self, PluginHost.isEventName(event) else { return false }
            self.emitValue(event, payload)
            return true
        }
        put(h, "emit", unsafeBitCast(emit, to: AnyObject.self))

        let registerCommand: @convention(block) (String, String, JSValue) -> Void = { [weak self] owner, name, fn in
            guard let self = self else { return }
            guard let key = PluginHost.slug(name) else { log.warn("[\(owner)]", "rejected command", ["name": name]); return }
            if self.commands[key] != nil { log.warn("[\(owner)]", "command exists: \(key)"); return }
            self.commands[key] = (fn, owner)
        }
        put(h, "registerCommand", unsafeBitCast(registerCommand, to: AnyObject.self))

        let registerService: @convention(block) (String, JSValue) -> Void = { [weak self] owner, methods in
            guard let self = self else { return }
            if self.services[owner] != nil { log.warn("[\(owner)]", "service already registered"); return }
            self.services[owner] = methods
        }
        put(h, "registerService", unsafeBitCast(registerService, to: AnyObject.self))

        let registerTray: @convention(block) (String, String, String, Bool, JSValue) -> Void = { [weak self] owner, label, type, checked, click in
            guard let self = self else { return }
            self.trayItems.append(TrayItem(label: label, type: type, checked: checked, owner: owner, click: click))
            self.onTrayDirty?()
        }
        put(h, "registerTrayItem", unsafeBitCast(registerTray, to: AnyObject.self))

        let registerShortcut: @convention(block) (String, String, JSValue) -> Bool = { [weak self] owner, accel, fn in
            guard let self = self else { return false }
            guard let cb = self.onShortcut else { return true }
            return cb(accel, owner) { [weak self] in
                self?.guarded(fn, [], label: "shortcut", owner: accel)
            }
        }
        put(h, "registerGlobalShortcut", unsafeBitCast(registerShortcut, to: AnyObject.self))

        let settingsGet: @convention(block) (String, String) -> JSValue = { [weak self] owner, key in
            let c: JSContext = JSContext.current() ?? ctx
            let out: JSValue = JSValue(newObjectIn: c)
            if let store = self?.settings.pluginValues[owner], let v = store[key] {
                out.setValue(true, forProperty: "has")
                out.setValue(v is NSNull ? JSValue(nullIn: c) : JSValue(object: v, in: c), forProperty: "value")
            } else {
                out.setValue(false, forProperty: "has")
            }
            return out
        }
        put(h, "settingsGet", unsafeBitCast(settingsGet, to: AnyObject.self))

        let settingsSet: @convention(block) (String, String, JSValue) -> Void = { [weak self] owner, key, value in
            guard let self = self else { return }
            let v = JSONCompat.sanitize(JSRuntime.foundation(value) ?? NSNull())
            self.settings.pluginValues[owner, default: [:]][key] = v
            self.persist()
        }
        put(h, "settingsSet", unsafeBitCast(settingsSet, to: AnyObject.self))

        let notesList: @convention(block) () -> JSValue = { [weak self] in
            self?.runtime.value(self?.kernel?.notesList() ?? [Any]()) ?? JSValue(nullIn: ctx)
        }
        put(h, "notesList", unsafeBitCast(notesList, to: AnyObject.self))

        let notesRead: @convention(block) (JSValue) -> JSValue = { [weak self] id in
            self?.runtime.value(self?.kernel?.notesRead(JSRuntime.foundation(id))) ?? JSValue(nullIn: ctx)
        }
        put(h, "notesRead", unsafeBitCast(notesRead, to: AnyObject.self))

        let notesSave: @convention(block) (JSValue) -> JSValue = { [weak self] payload in
            let p = (JSRuntime.foundation(payload) as? [String: Any]) ?? [:]
            return self?.runtime.value(self?.kernel?.notesSave(p)) ?? JSValue(nullIn: ctx)
        }
        put(h, "notesSave", unsafeBitCast(notesSave, to: AnyObject.self))

        let notesRecent: @convention(block) (JSValue) -> JSValue = { [weak self] limit in
            self?.runtime.value(self?.kernel?.notesRecent(JSRuntime.foundation(limit))) ?? JSValue(nullIn: ctx)
        }
        put(h, "notesRecent", unsafeBitCast(notesRecent, to: AnyObject.self))

        let toggle: @convention(block) () -> Void = { [weak self] in self?.kernel?.windowToggle() }
        put(h, "windowToggle", unsafeBitCast(toggle, to: AnyObject.self))
        let show: @convention(block) () -> Void = { [weak self] in self?.kernel?.windowShow() }
        put(h, "windowShow", unsafeBitCast(show, to: AnyObject.self))
        let hide: @convention(block) () -> Void = { [weak self] in self?.kernel?.windowHide() }
        put(h, "windowHide", unsafeBitCast(hide, to: AnyObject.self))
        let quit: @convention(block) () -> Void = { [weak self] in self?.kernel?.appQuit() }
        put(h, "appQuit", unsafeBitCast(quit, to: AnyObject.self))
        let status: @convention(block) () -> JSValue = { [weak self] in
            self?.runtime.value(self?.kernel?.systemStatus()) ?? JSValue(nullIn: ctx)
        }
        put(h, "systemStatus", unsafeBitCast(status, to: AnyObject.self))
        return h
    }
}
