import AppKit
import ServiceManagement
import TenoteCore
import WebKit

/// Owns every subsystem: settings, notes, plugin host, card window, tray,
/// hotkeys and the control socket. Everything here runs on the main thread;
/// note I/O is pushed to `io`.
final class AppController: NSObject, NSApplicationDelegate, NSMenuDelegate, PluginKernel {
    static let blurHideDelay: TimeInterval = 0.16
    static let toggleCoalesce: TimeInterval = 0.25

    let env = ProcessInfo.processInfo.environment
    let paths: TenotePaths
    let resources: URL
    let logger: Logger
    let settings: Settings
    let store: NoteStore
    let io = DispatchQueue(label: "tenote.io", qos: .userInitiated)
    let version: String
    let builtinShortcut: String?

    private(set) var host: PluginHost!
    private var card: CardWindow!
    private var statusItem: NSStatusItem?
    private let hotKeys = HotKeys()
    private var socket: SocketServer?
    private var lastToggleAt = Date.distantPast
    private var trayMenuOpen = false
    private var isFirstSession = false
    private var activeShortcut: String?
    private var pluginShortcuts: [String: Set<String>] = [:]
    private let ipc = IpcBridge()

    override init() {
        paths = TenotePaths()
        resources = ResourceLocator.root()
        logger = Logger(logDir: paths.logDir, minLevel: ProcessInfo.processInfo.environment["TENOTE_LOG_LEVEL"] == "debug" ? .debug : .info)
        settings = Settings(file: paths.settingsFile)
        store = NoteStore(notesDir: paths.notesDir, logger: logger)
        let bundled = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        let file = try? String(contentsOf: ResourceLocator.root().appendingPathComponent("VERSION"), encoding: .utf8)
        version = bundled ?? file?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "0.0.0"
        let s = ProcessInfo.processInfo.environment["TENOTE_SHORTCUT"]
        builtinShortcut = s == "0" ? nil : (s.flatMap { $0.isEmpty ? nil : $0 } ?? "Alt+.")
        super.init()
    }

    var notesDir: String { paths.notesDir.path }

    // MARK: lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        if SocketServer.send("show", to: paths.socketPath, timeout: 1) != nil {
            logger.info("app", "another instance is running; quitting")
            exit(0)
        }
        logger.info("app", "bootstrap", [
            "version": version, "platform": "darwin", "shortcut": builtinShortcut ?? NSNull(),
            "notesDir": notesDir, "socket": paths.socketPath, "logFile": logger.logFile.path,
            "hideOnBlur": settings.hideOnBlur, "launchAtLogin": settings.launchAtLogin,
        ])
        installMainMenu()
        applyDockIcon()
        PluginInstaller.seedExamples(from: resources.appendingPathComponent("examples"), into: paths.pluginsUserDir,
                                     settings: settings, logger: logger)
        setupHost()
        host.discover()
        if env["TENOTE_NO_PLUGINS"].map({ !$0.isEmpty }) == true {
            logger.warn("plugins", "TENOTE_NO_PLUGINS=1 — skipping activation")
        } else {
            host.activateAll()
        }
        startSocket()
        createWindow()
        setupTray()
        applyLoginItem()
        if !settings.firstRunDone {
            isFirstSession = true
            settings.firstRunDone = true
            saveSettings()
            logger.info("app", "first run — showing window to greet")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.showWindow() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in self?.maybeSweepImages() }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        logger.info("app", "will-quit")
        host?.shutdown()
        hotKeys.unregisterAll()
        socket?.stop()
        logger.flush()
    }

    func saveSettings() {
        if let e = settings.save() { logger.error("settings", "save failed", ["error": e.localizedDescription]) }
    }

    private func installMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Hide Tenote", action: #selector(hideFromMenu), keyEquivalent: "w").target = self
        appMenu.addItem(withTitle: "Quit Tenote", action: #selector(quitFromMenu), keyEquivalent: "q").target = self
        appItem.submenu = appMenu
        main.addItem(appItem)
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)
        NSApp.mainMenu = main
    }

    @objc private func hideFromMenu() { hideWindow() }
    @objc private func quitFromMenu() { quitApp() }

    private func applyDockIcon() {
        if settings.showDockIcon {
            NSApp.setActivationPolicy(.regular)
            if let icon = NSImage(contentsOf: resources.appendingPathComponent("assets/icon.png")) { NSApp.applicationIconImage = icon }
        } else {
            NSApp.setActivationPolicy(.accessory)
        }
    }

    private func applyLoginItem() {
        guard Bundle.main.bundleURL.pathExtension == "app" else { return }
        do {
            if settings.launchAtLogin {
                if SMAppService.mainApp.status != .enabled { try SMAppService.mainApp.register() }
            } else if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            }
            logger.info("settings", "login item applied", ["openAtLogin": settings.launchAtLogin])
        } catch {
            logger.warn("settings", "login item failed", ["error": error.localizedDescription])
        }
    }

    // MARK: plugin host

    private func setupHost() {
        let builtin = resources.appendingPathComponent("plugins/builtin", isDirectory: true)
        let envFiles = (env["TENOTE_PLUGINS"] ?? "").split(separator: ":").map(String.init)
        let h = PluginHost(logger: logger, settings: settings,
                           layers: [PluginHost.Layer(name: "builtin", dir: builtin), PluginHost.Layer(name: "user", dir: paths.pluginsUserDir)],
                           envFiles: envFiles, pluginDataRoot: paths.pluginDataRoot, kernel: self,
                           runtime: JSRuntime(logger: logger, version: version))
        h.persist = { [weak self] in self?.saveSettings() }
        h.onTrayDirty = { [weak self] in self?.rebuildTrayMenu() }
        h.onShortcut = { [weak self] accel, owner, fire in self?.registerPluginShortcut(accel, owner: owner, fire: fire) ?? false }
        h.onEmit = { [weak self] event, payload in
            self?.sendToRenderer("plugin", ["event": event, "payload": payload ?? NSNull()])
        }
        host = h
    }

    private func registerPluginShortcut(_ accel: String, owner: String, fire: @escaping () -> Void) -> Bool {
        guard hotKeys.register(accel, fire: fire) else {
            logger.warn("shortcut", "register failed", ["shortcut": accel])
            return false
        }
        if owner == "core-shortcuts" || activeShortcut == nil { activeShortcut = accel }
        pluginShortcuts[owner, default: []].insert(accel)
        logger.info("shortcut", "registered", ["shortcut": accel])
        rebuildTrayMenu()
        return true
    }

    private func unregisterPluginShortcuts(_ owner: String) {
        guard let accs = pluginShortcuts.removeValue(forKey: owner) else { return }
        for a in accs { hotKeys.unregister(a) }
        if let a = activeShortcut, accs.contains(a) { activeShortcut = nil }
    }

    private var shortcutLabel: String {
        guard let s = activeShortcut ?? builtinShortcut else { return "via skhd" }
        return Accelerator.label(s)
    }

    private var shortcutHintLabel: String {
        guard activeShortcut ?? builtinShortcut != nil else { return "Toggle with your skhd binding" }
        return "Press \(shortcutLabel) anywhere to show/hide Tenote"
    }

    // MARK: kernel (tenote.notes / window / app / system)

    func notesList() -> Any { io.sync { store.list() } }
    func notesRead(_ id: Any?) -> Any? { io.sync { store.read(id) } }
    func notesRecent(_ limit: Any?) -> Any { io.sync { store.recent(limit) } }

    func notesSave(_ payload: [String: Any]) -> Any {
        let piped = host.applyBeforeSave([
            "id": NoteStore.safeId(payload["id"] as? String) ?? NSNull(),
            "text": (payload["text"] as? String) ?? "",
            "tags": (payload["tags"] as? [Any]) ?? [],
        ])
        var saved: [String: Any]?
        let result = io.sync {
            store.save(id: piped["id"], text: (piped["text"] as? String) ?? "", tags: (piped["tags"] as? [Any]) ?? []) { saved = $0 }
        }
        if let s = saved { host.emit("note:saved", s) }
        return result
    }

    func windowToggle() { toggleWindow() }
    func windowShow() { showWindow() }
    func windowHide() { hideWindow() }
    func appQuit() { quitApp() }

    func systemStatus() -> Any {
        ["running": true, "visible": card?.isVisible ?? false, "shortcut": shortcutLabel, "version": version,
         "plugins": host.publicList()]
    }

    // MARK: window

    private func createWindow() {
        let config = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        if let src = try? String(contentsOf: resources.appendingPathComponent("renderer/native-bridge.js"), encoding: .utf8) {
            ucc.addUserScript(WKUserScript(source: src, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        } else {
            logger.error("window", "native-bridge.js missing", ["resources": resources.path])
        }
        ipc.controller = self
        ucc.addScriptMessageHandler(ipc, contentWorld: .page, name: "tenote")
        config.userContentController = ucc
        let rendererDir = resources.appendingPathComponent("renderer", isDirectory: true).standardizedFileURL
        config.setURLSchemeHandler(SchemeHandler { url in
            let rel = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
            guard url.host == "app", !rel.contains(".."), !rel.isEmpty else { return (403, Data(), "text/plain") }
            let r = SchemeHandler.file(rendererDir.appendingPathComponent(rel))
            return (r.0, r.1, r.2)
        }, forURLScheme: "tenote")
        config.setURLSchemeHandler(SchemeHandler { [weak self] url in
            let b64 = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
            guard let file = self?.store.imageFile(forEncodedPath: b64) else { return (403, Data(), "text/plain") }
            let r = SchemeHandler.file(file)
            return (r.0, r.1, r.2)
        }, forURLScheme: "timg")
        config.setURLSchemeHandler(SchemeHandler { [weak self] url in
            let parts = (url.path.removingPercentEncoding ?? "").split(separator: "/").map(String.init)
            guard let self = self, url.host == "p", parts.count == 2 else { return (403, Data(), "text/plain") }
            let (name, file) = (parts[0], parts[1])
            guard let entry = self.host.fileAllowlist()[name], entry.files.contains(file), !file.contains(".."),
                  ["js", "css", "json"].contains((file as NSString).pathExtension) else { return (403, Data(), "text/plain") }
            let r = SchemeHandler.file(entry.dir.appendingPathComponent(file))
            return (r.0, r.1, r.2)
        }, forURLScheme: "tnplug")

        card = CardWindow(logger: logger, config: config)
        card.onBlur = { [weak self] in self?.handleBlur() }
        card.onDidFinishLoad = { [weak self] in self?.injectRendererPlugins() }
        card.webView.onDropPaths = { [weak self] paths in
            self?.evalInRenderer("window.__tenoteNative && window.__tenoteNative.setDroppedPaths(\(JSONCompat.string(paths) ?? "[]"))")
        }
        if let u = URL(string: "tenote://app/index.html") { card.webView.load(URLRequest(url: u)) }
    }

    private func handleBlur() {
        guard settings.hideOnBlur, !trayMenuOpen, card.isVisible else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + AppController.blurHideDelay) { [weak self] in
            guard let self = self, self.card.isVisible, !self.card.panel.isKeyWindow, !self.trayMenuOpen else { return }
            self.logger.debug("window", "blur -> hide")
            self.hideWindow()
        }
    }

    func showWindow() {
        guard let card = card else { return }
        card.show()
        sendToRenderer("shown", NSNull())
        host.emit("window:shown", [String: Any]())
    }

    func hideWindow() {
        guard let card = card, card.isVisible else { return }
        card.hide()
        host.emit("window:hidden", [String: Any]())
    }

    func toggleWindow() {
        let now = Date()
        if now.timeIntervalSince(lastToggleAt) < AppController.toggleCoalesce {
            logger.debug("window", "toggle coalesced (skhd + built-in shortcut double fire)")
            return
        }
        lastToggleAt = now
        if card?.isVisible == true { hideWindow() } else { showWindow() }
    }

    func quitApp() { NSApp.terminate(nil) }

    private func evalInRenderer(_ js: String) {
        card?.webView.evaluateJavaScript(js) { [weak self] _, err in
            if let e = err as NSError?, e.code != WKError.javaScriptResultTypeIsUnsupported.rawValue {
                self?.logger.debug("window", "evaluateJavaScript failed", ["error": e.localizedDescription])
            }
        }
    }

    private func sendToRenderer(_ kind: String, _ data: Any) {
        guard let json = JSONCompat.string(data) else { return }
        evalInRenderer("window.__tenoteNative && window.__tenoteNative.emit(\(JSONCompat.string(kind) ?? "\"\""), \(json)); void 0")
    }

    // MARK: renderer plugins

    private static let jsonRequireRe = try! NSRegularExpression(pattern: #"require\(\s*['"]\./([^'"]+\.json)['"]\s*\)"#)

    private func localJsonRequires(_ src: String, dir: URL) -> [String: Any] {
        var map: [String: Any] = [:]
        let ns = src as NSString
        for m in AppController.jsonRequireRe.matches(in: src, range: NSRange(location: 0, length: ns.length)) {
            let rel = ns.substring(with: m.range(at: 1))
            if rel.contains("/") || rel.contains("\\") || rel.contains("..") { continue }
            do {
                let data = try Data(contentsOf: dir.appendingPathComponent(rel))
                map[rel] = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
            } catch {
                logger.warn("plugins", "json require failed: \(rel)", ["error": error.localizedDescription])
            }
        }
        return map
    }

    private func injectRendererEntry(id: String, path: URL) {
        guard let src = try? String(contentsOf: path, encoding: .utf8) else {
            logger.error("plugins", "renderer injection failed: \(id)", ["error": "unreadable"]); return
        }
        let jsonMap = JSONCompat.string(localJsonRequires(src, dir: path.deletingLastPathComponent())) ?? "{}"
        let idJSON = JSONCompat.string(id) ?? "\"\""
        let wrapped = "(function(){var module={exports:{}};var exports=module.exports;"
            + "var require=function(p){p=String(p).replace(/^\\.\\//,'');var m=\(jsonMap);"
            + "if(!Object.prototype.hasOwnProperty.call(m,p))throw new Error('cannot require '+p);return m[p];};"
            + "(function(){\n\(src)\n})();"
            + "var e=module.exports;if(typeof e!==\"function\"&&e&&typeof e.activate===\"function\")e=e.activate;"
            + "if(typeof e!==\"function\")throw new Error(\"renderer export must be a function\");"
            + "window.__tenoteReady(\(idJSON),e);})(); void 0"
        card.webView.evaluateJavaScript(wrapped) { [weak self] _, err in
            if let e = err as NSError?, e.code != WKError.javaScriptResultTypeIsUnsupported.rawValue {
                let detail = (e.userInfo["WKJavaScriptExceptionMessage"] as? String) ?? e.localizedDescription
                self?.logger.error("plugins", "renderer injection failed: \(id)", ["error": detail])
            } else {
                self?.logger.info("plugins", "renderer part activated: \(id)")
            }
        }
    }

    private func injectRendererPlugins() {
        for e in host.rendererEntries() { injectRendererEntry(id: e.id, path: e.path) }
    }

    // MARK: IPC from the web UI

    private func settingsDict() -> [String: Any] { settings.dictionary() }

    func handleIpc(_ method: String, _ args: Any?, _ reply: @escaping (Any?) -> Void) {
        let a = args as? [String: Any] ?? [:]
        switch method {
        case "log":
            let lvl = Logger.Level(name: (a["level"] as? String) ?? "") ?? .info
            logger.log(lvl, "renderer", String(((a["message"] as? String) ?? "").prefix(2000)))
            reply(nil)
        case "window:toggle": toggleWindow(); reply(["visible": card.isVisible])
        case "window:hide": hideWindow(); reply(true)
        case "window:resizeStart": card.startResize((args as? String) ?? ""); reply(true)
        case "window:resizeEnd": card.stopResize(); reply(true)
        case "window:dragStart": card.startDrag(); reply(true)
        case "window:dragEnd": card.stopDrag(); reply(true)
        case "window:ensureSize": reply(card.ensureSize(a))
        case "state:get":
            reply(["notesDir": notesDir, "shortcut": shortcutLabel, "windowVisible": card.isVisible, "firstRun": isFirstSession])
        case "settings:get": reply(settingsDict())
        case "settings:setHideOnBlur":
            settings.hideOnBlur = (args as? Bool) ?? false; saveSettings(); rebuildTrayMenu()
            logger.info("settings", "hideOnBlur (from ui)", ["value": settings.hideOnBlur]); reply(settingsDict())
        case "settings:setLaunchAtLogin":
            settings.launchAtLogin = (args as? Bool) ?? false; saveSettings(); applyLoginItem(); rebuildTrayMenu()
            logger.info("settings", "launchAtLogin (from ui)", ["value": settings.launchAtLogin]); reply(settingsDict())
        case "settings:setTheme":
            let t = (args as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "latte"
            settings.theme = host.hasTheme(t) ? t : "latte"; saveSettings()
            logger.info("settings", "theme (from ui)", ["value": settings.theme])
            host.emit("theme:changed", ["theme": settings.theme]); reply(settingsDict())
        case "settings:setHideBrand":
            settings.hideBrand = (args as? Bool) ?? false; saveSettings(); reply(settingsDict())
        case "settings:setHideRecents":
            settings.hideRecents = (args as? Bool) ?? false; saveSettings(); reply(settingsDict())
        case "logs:openFolder": openFolder(logger.logDir); reply("")
        case "notes:openFolder": openFolder(paths.notesDir); reply("")
        case "app:quit": reply(true); DispatchQueue.main.async { self.quitApp() }
        case "note:save": reply(notesSave(a))
        case "note:list": async(reply) { $0.store.list() }
        case "note:recent": async(reply) { $0.store.recent(args) }
        case "note:read":
            io.async { [weak self] in
                let note = self?.store.read(args)
                DispatchQueue.main.async {
                    if let n = note, let id = n["id"] { self?.host.emit("note:opened", ["id": id]) }
                    reply(note ?? NSNull())
                }
            }
        case "note:attach":
            let mime = (a["mime"] as? String) ?? "", b64 = (a["base64"] as? String) ?? ""
            async(reply) { $0.store.attachImage(mime: mime, base64: b64) }
        case "plugin:invoke":
            let name = (a["plugin"] as? String) ?? "", m = (a["method"] as? String) ?? ""
            let finish: (Result<Any?, JSRuntime.JSError>) -> Void = { [weak self] r in
                switch r {
                case .success(let v): reply(["ok": true, "result": v ?? NSNull()])
                case .failure(let e):
                    self?.logger.warn("plugins", "invoke failed", ["error": e.message])
                    reply(["ok": false, "error": e.message.components(separatedBy: "\n").first ?? e.message])
                }
            }
            if name == "__host" { hostService(m, a["args"] as? [String: Any] ?? [:], finish) }
            else { host.invoke(name, m, a["args"], finish) }
        default:
            reply(["ok": false, "error": "unknown ipc: \(method)"])
        }
    }

    private func async(_ reply: @escaping (Any?) -> Void, _ work: @escaping (AppController) -> Any) {
        io.async { [weak self] in
            guard let self = self else { return }
            let r = work(self)
            DispatchQueue.main.async { reply(r) }
        }
    }

    private func openFolder(_ dir: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(dir)
    }

    private func hostService(_ method: String, _ a: [String: Any], _ done: @escaping (Result<Any?, JSRuntime.JSError>) -> Void) {
        let fail = { (m: String) in done(.failure(JSRuntime.JSError(message: m))) }
        switch method {
        case "state":
            done(.success(["plugins": host.publicList(), "themes": host.themeList(), "themeId": settings.theme]))
        case "themeCss":
            let id = "\(a["id"] ?? "")"
            guard host.hasTheme(id) else { return fail("unknown theme") }
            done(.success(host.themeCss(id) ?? NSNull()))
        case "setEnabled":
            let name = "\(a["name"] ?? "")"
            let on = (a["enabled"] as? Bool) ?? false
            if !on { unregisterPluginShortcuts(name) }
            let ok = on ? host.enable(name) : host.disable(name)
            logger.info("plugins", "setEnabled \(name) -> \(on) (\(ok ? "live" : "failed"))")
            let rec = host.record(named: name)
            if on, ok, let r = rec, let p = r.rendererPath { injectRendererEntry(id: name, path: p) }
            else if !on { sendToRenderer("plugin", ["event": "__tenote:deactivate", "payload": ["id": name]]) }
            rebuildTrayMenu()
            done(.success(["ok": ok, "active": rec?.state == .ok]))
        case "pluginInfo":
            let name = "\(a["name"] ?? "")"
            guard let rec = host.record(named: name) else { return fail("unknown plugin: \(name)") }
            let info: [String: Any] = ["name": rec.name, "version": rec.version ?? NSNull(), "layer": rec.layer,
                                       "state": rec.state.rawValue, "error": rec.error ?? NSNull(),
                                       "description": rec.description ?? NSNull()]
            let dir = rec.dir, isDir = rec.isDir
            io.async {
                var readme: String?
                if isDir {
                    for fn in ["README.md", "readme.md", "README.txt", "README"] {
                        if let s = try? String(contentsOf: dir.appendingPathComponent(fn), encoding: .utf8) {
                            readme = String(s.prefix(32768)); break
                        }
                    }
                }
                var out = info
                out["readme"] = readme ?? NSNull()
                DispatchQueue.main.async { done(.success(out)) }
            }
        case "openPluginsFolder":
            openFolder(paths.pluginsUserDir)
            done(.success(true))
        case "installPlugin":
            installPluginInteractive(done)
        case "copyPng":
            guard let data = Data(base64Encoded: "\(a["base64"] ?? "")"), let img = NSImage(data: data) else {
                return done(.success(["ok": false, "error": "bad image data"]))
            }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.writeObjects([img])
            done(.success(["ok": true]))
        case "getPluginSettings":
            done(.success(settings.pluginValues["\(a["name"] ?? "")"] ?? [:]))
        case "setPluginSetting":
            let name = "\(a["name"] ?? "")"
            guard host.record(named: name) != nil else { return fail("unknown plugin") }
            settings.pluginValues[name, default: [:]]["\(a["key"] ?? "")"] = JSONCompat.sanitize(a["value"] ?? NSNull())
            saveSettings()
            done(.success(["ok": true]))
        default:
            fail("unknown host method: \(method)")
        }
    }

    private func installPluginInteractive(_ done: @escaping (Result<Any?, JSRuntime.JSError>) -> Void) {
        let panel = NSOpenPanel()
        panel.title = "Choose a Tenote plugin"
        panel.prompt = "Install"
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        let wasHideOnBlur = settings.hideOnBlur
        settings.hideOnBlur = false
        panel.begin { [weak self] resp in
            guard let self = self else { return }
            self.settings.hideOnBlur = wasHideOnBlur
            guard resp == .OK, let url = panel.url else { return done(.success(["ok": false, "canceled": true])) }
            let dest = self.paths.pluginsUserDir
            self.io.async {
                let r: [String: Any]
                do {
                    let name = try PluginInstaller.install(from: url, into: dest)
                    self.logger.info("plugins", "installed \"\(name)\" from \(url.path)")
                    r = ["ok": true, "name": name]
                } catch {
                    self.logger.warn("plugins", "install failed (\(url.path))", ["error": error.localizedDescription])
                    r = ["ok": false, "error": error.localizedDescription]
                }
                DispatchQueue.main.async { done(.success(r)) }
            }
        }
    }

    private func maybeSweepImages() {
        let now = Date().timeIntervalSince1970 * 1000
        guard now - settings.lastImageSweep >= 24 * 60 * 60 * 1000 else { return }
        settings.lastImageSweep = now
        saveSettings()
        io.async { [weak self] in _ = self?.store.sweepOrphanImages() }
    }

    // MARK: socket (tenotectl / skhd)

    private func startSocket() {
        let s = SocketServer(path: paths.socketPath, logger: logger) { [weak self] cmd, reply in
            self?.handleSocketCommand(cmd, reply) ?? reply("error\n")
        }
        if s.start() { socket = s }
    }

    private func handleSocketCommand(_ cmd: String, _ reply: @escaping (String) -> Void) {
        logger.info("socket", "command", ["cmd": cmd])
        guard let result = host.runCommand(cmd) else { return reply("unknown command: \(cmd)\n") }
        host.runtime.settle(result) { [weak self] r in
            switch r {
            case .success(let v): reply(AppController.formatReply(v))
            case .failure(let e):
                self?.logger.error("socket", "command \(cmd) failed", ["error": e.message])
                reply("error\n")
            }
        }
    }

    static func formatReply(_ r: Any?) -> String {
        guard let r = r, !(r is NSNull) else { return "ok\n" }
        if let s = r as? String { return s.hasSuffix("\n") ? s : s + "\n" }
        return (JSONCompat.string(r).map { $0 + "\n" }) ?? "ok\n"
    }

    // MARK: tray

    private func setupTray() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let img = NSImage(contentsOf: resources.appendingPathComponent("assets/trayTemplate.png")) {
            img.isTemplate = true
            img.size = NSSize(width: 18, height: 18)
            item.button?.image = img
        } else {
            item.button?.title = "✎"
        }
        item.button?.toolTip = "Tenote"
        statusItem = item
        rebuildTrayMenu()
    }

    func menuWillOpen(_ menu: NSMenu) { trayMenuOpen = true }
    func menuDidClose(_ menu: NSMenu) { DispatchQueue.main.async { self.trayMenuOpen = false } }

    private final class Action: NSObject {
        let run: () -> Void
        init(_ run: @escaping () -> Void) { self.run = run }
        @objc func fire() { run() }
    }
    private var actions: [Action] = []

    private func add(_ menu: NSMenu, _ title: String, checked: Bool? = nil, enabled: Bool = true, _ run: (() -> Void)? = nil) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        if let run = run, enabled {
            let a = Action(run)
            actions.append(a)
            item.target = a
            item.action = #selector(Action.fire)
        }
        item.isEnabled = enabled && run != nil
        if let c = checked { item.state = c ? .on : .off }
        menu.addItem(item)
    }

    func rebuildTrayMenu() {
        guard let statusItem = statusItem else { return }
        actions.removeAll()
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.delegate = self
        add(menu, "Open Tenote") { [weak self] in self?.showWindow() }
        add(menu, "All notes") { [weak self] in
            self?.showWindow()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { self?.sendToRenderer("goto", "history") }
        }
        add(menu, "Open Notes Folder") { [weak self] in if let s = self { s.openFolder(s.paths.notesDir) } }
        let items = host?.trayItems ?? []
        if !items.isEmpty {
            menu.addItem(.separator())
            add(menu, "Plugins", enabled: false)
            for (i, it) in items.enumerated() {
                add(menu, it.label, checked: it.type == "checkbox" ? it.checked : nil) { [weak self] in self?.host.clickTrayItem(at: i) }
            }
        }
        menu.addItem(.separator())
        add(menu, "Hide when focus lost", checked: settings.hideOnBlur) { [weak self] in
            guard let s = self else { return }
            s.settings.hideOnBlur.toggle(); s.saveSettings(); s.rebuildTrayMenu()
        }
        add(menu, "Launch at login", checked: settings.launchAtLogin) { [weak self] in
            guard let s = self else { return }
            s.settings.launchAtLogin.toggle(); s.saveSettings(); s.applyLoginItem(); s.rebuildTrayMenu()
        }
        add(menu, "Show in Dock", checked: settings.showDockIcon) { [weak self] in
            guard let s = self else { return }
            s.settings.showDockIcon.toggle(); s.saveSettings(); s.applyDockIcon(); s.rebuildTrayMenu()
        }
        menu.addItem(.separator())
        add(menu, "Open Logs Folder") { [weak self] in if let s = self { s.openFolder(s.logger.logDir) } }
        add(menu, "Copy Log Path") { [weak self] in
            guard let s = self else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(s.logger.logFile.path, forType: .string)
        }
        menu.addItem(.separator())
        add(menu, shortcutHintLabel, enabled: false)
        add(menu, "Quit Tenote") { [weak self] in self?.quitApp() }
        statusItem.menu = menu
    }
}
