import Foundation
import JavaScriptCore
@testable import TenoteCore
import XCTest

final class PluginHostTests: XCTestCase {
    private var lines: [(Logger.Level, String)] = []

    private func tmp() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("tenote-host-test-" + UUID().uuidString)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    @discardableResult
    private func writePlugin(_ dir: URL, _ name: String, _ body: String?, manifest: [String: Any]? = nil) -> URL {
        let p = dir.appendingPathComponent(name)
        try? FileManager.default.createDirectory(at: p, withIntermediateDirectories: true)
        if let m = manifest { try? JSONSerialization.data(withJSONObject: m).write(to: p.appendingPathComponent("plugin.json")) }
        if let b = body, !b.isEmpty { write(p.appendingPathComponent("index.js"), "module.exports = function (t) { \(b) };") }
        return p
    }

    private func write(_ url: URL, _ s: String) { try? s.write(to: url, atomically: true, encoding: .utf8) }

    private func makeHost(_ dir: URL, settings: Settings = Settings(file: nil), layers: [PluginHost.Layer]? = nil,
                          envFiles: [String] = [], persist: @escaping () -> Void = {}) -> PluginHost {
        let logger = Logger(logDir: dir.appendingPathComponent("logs"), minLevel: .debug, writesToDisk: false)
        logger.sink = { [weak self] lvl, line in self?.lines.append((lvl, line)) }
        return PluginHost(logger: logger, settings: settings, layers: layers ?? [PluginHost.Layer(name: "builtin", dir: dir)],
                          envFiles: envFiles, pluginDataRoot: dir.appendingPathComponent("data"), persist: persist)
    }

    private func plugins(_ h: PluginHost) -> [[String: Any]] { h.status()["plugins"] as? [[String: Any]] ?? [] }
    private func state(_ h: PluginHost, _ name: String) -> String? {
        plugins(h).first { $0["name"] as? String == name }?["state"] as? String
    }
    private func run(_ h: PluginHost, _ cmd: String) -> String? { h.runCommand(cmd).flatMap { $0.isString ? $0.toString() : nil } }

    private func invoke(_ h: PluginHost, _ name: String, _ method: String) -> Result<Any?, JSRuntime.JSError> {
        var out: Result<Any?, JSRuntime.JSError>?
        h.invoke(name, method, nil) { out = $0 }
        let deadline = Date().addingTimeInterval(2)
        while out == nil && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
        return out ?? .failure(JSRuntime.JSError(message: "timeout"))
    }

    func testDiscoversAndActivatesInOrder() {
        let dir = tmp()
        writePlugin(dir, "a-one", "this.ran='a';")
        writePlugin(dir, "b-two", "this.ran='b';")
        let h = makeHost(dir)
        h.discover(); h.activateAll()
        XCTAssertEqual(plugins(h).map { "\($0["name"]!):\($0["state"]!)" }, ["a-one:ok", "b-two:ok"])
    }

    func testDisabledPluginsStayDormant() {
        let dir = tmp()
        writePlugin(dir, "off", "globalThis.__x = (globalThis.__x || 0) + 1;")
        let s = Settings(file: nil)
        s.disabledPlugins = ["off"]
        let h = makeHost(dir, settings: s)
        h.discover(); h.activateAll()
        XCTAssertEqual(state(h, "off"), "disabled")
        XCTAssertTrue(h.runtime.context.evaluateScript("typeof globalThis.__x")?.toString() == "undefined")
    }

    func testLaterLayerLosesOnNameCollision() {
        let builtin = tmp(), user = tmp()
        writePlugin(builtin, "dupe", "")
        write(builtin.appendingPathComponent("dupe/index.js"), "module.exports = function () {};")
        writePlugin(user, "dupe", "")
        write(user.appendingPathComponent("dupe/index.js"), "module.exports = function () {};")
        let h = makeHost(builtin, layers: [PluginHost.Layer(name: "builtin", dir: builtin), PluginHost.Layer(name: "user", dir: user)])
        h.discover(); h.activateAll()
        let dupes = plugins(h).filter { $0["name"] as? String == "dupe" }
        XCTAssertEqual(dupes.count, 1)
        XCTAssertEqual(dupes.first?["layer"] as? String, "builtin")
    }

    func testFailedActivationIsolates() {
        let dir = tmp()
        writePlugin(dir, "boom", "throw new Error('nope');")
        writePlugin(dir, "gooder", "t.registerCommand('hello', () => 'hi');", manifest: ["name": "gooder"])
        let h = makeHost(dir)
        h.discover(); h.activateAll()
        XCTAssertEqual(state(h, "boom"), "failed")
        XCTAssertEqual(h.record(named: "boom")?.error?.contains("nope"), true)
        XCTAssertEqual(state(h, "gooder"), "ok")
        XCTAssertEqual(run(h, "hello"), "hi")
    }

    func testHookFailuresSuspendAfterThreeStrikes() {
        let dir = tmp()
        writePlugin(dir, "flaky", "t.on('note:saved', () => { throw new Error('boom'); });")
        let h = makeHost(dir)
        h.discover(); h.activateAll()
        for _ in 0..<5 { h.emit("note:saved", [String: Any]()) }
        let threw = lines.filter { $0.1.contains("threw (flaky)") }.count
        XCTAssertEqual(threw, 3)
        XCTAssertTrue(lines.contains { $0.1.contains("suspended") })
    }

    func testBeforeSavePipelineInOrder() {
        let dir = tmp()
        writePlugin(dir, "p1", "t.on('note:before-save', (n) => ({ ...n, text: n.text + '-one' }));")
        writePlugin(dir, "p2", "t.on('note:before-save', (n) => ({ ...n, text: n.text + '-two' }));")
        let h = makeHost(dir)
        h.discover(); h.activateAll()
        let out = h.applyBeforeSave(["id": NSNull(), "text": "x", "tags": [Any]()])
        XCTAssertEqual(out["text"] as? String, "x-one-two")
    }

    func testThrowingPipelinePassesThrough() {
        let dir = tmp()
        writePlugin(dir, "bad", "t.on('note:before-save', () => { throw new Error('x'); });")
        let h = makeHost(dir)
        h.discover(); h.activateAll()
        XCTAssertEqual(h.applyBeforeSave(["id": NSNull(), "text": "keep", "tags": [Any]()])["text"] as? String, "keep")
    }

    func testFirstCommandWins() {
        let dir = tmp()
        writePlugin(dir, "c1", "t.registerCommand('dup', () => 'first');")
        writePlugin(dir, "c2", "t.registerCommand('dup', () => 'second');")
        let h = makeHost(dir)
        h.discover(); h.activateAll()
        XCTAssertEqual(run(h, "dup"), "first")
    }

    func testThemeOnlyPlugin() {
        let dir = tmp()
        let p = writePlugin(dir, "pack", nil, manifest: [
            "name": "pack", "themes": [["id": "forest", "name": "Forest", "css": "forest.css", "swatch": ["#111", "#222"]]],
        ])
        write(p.appendingPathComponent("forest.css"), "body{}")
        let h = makeHost(dir)
        h.discover(); h.activateAll()
        XCTAssertTrue(h.hasTheme("forest"))
        XCTAssertEqual(h.themeCss("forest"), "body{}")
        let t = h.themeList().first
        XCTAssertEqual(t?["id"] as? String, "forest")
        XCTAssertEqual(t?["name"] as? String, "Forest")
        XCTAssertEqual(t?["swatch"] as? [String], ["#111", "#222"])
    }

    func testRendererEntriesOnlyWhenOk() {
        let dir = tmp()
        let ui = writePlugin(dir, "ui", nil, manifest: ["name": "ui", "renderer": "renderer.js"])
        write(ui.appendingPathComponent("renderer.js"), "module.exports=function(){};")
        writePlugin(dir, "dead", nil, manifest: ["name": "dead"])
        let h = makeHost(dir)
        h.discover(); h.activateAll()
        XCTAssertEqual(h.rendererEntries().map { $0.id }, ["ui"])
    }

    func testInvokeRoutesToServices() {
        let dir = tmp()
        writePlugin(dir, "svc", "t.registerService({ ping: () => 'pong', later: () => Promise.resolve(7) });")
        let h = makeHost(dir)
        h.discover(); h.activateAll()
        XCTAssertEqual(try? invoke(h, "svc", "ping").get() as? String, "pong")
        XCTAssertEqual(try? invoke(h, "svc", "later").get() as? Double, 7)
        if case .success = invoke(h, "svc", "nope") { XCTFail("expected failure") }
        if case .success = invoke(h, "ghost", "x") { XCTFail("expected failure") }
    }

    func testSettingsNamespacePersists() {
        let dir = tmp()
        writePlugin(dir, "setter", "t.settings.set('k', t.settings.get('k', 0) + 41);")
        var saved = 0
        let s = Settings(file: nil)
        s.pluginValues = ["setter": ["k": 1]]
        let h = makeHost(dir, settings: s, persist: { saved += 1 })
        h.discover(); h.activateAll()
        XCTAssertEqual(s.pluginValues["setter"]?["k"] as? Double, 42)
        XCTAssertEqual(saved, 1)
    }

    func testSetEnabledPersists() {
        let dir = tmp()
        writePlugin(dir, "toggle-me", "")
        write(dir.appendingPathComponent("toggle-me/index.js"), "module.exports = function () {};")
        var saved = 0
        let s = Settings(file: nil)
        let h = makeHost(dir, settings: s, persist: { saved += 1 })
        h.discover()
        h.setEnabled("toggle-me", false)
        XCTAssertEqual(s.disabledPlugins, ["toggle-me"])
        h.setEnabled("toggle-me", true)
        XCTAssertEqual(s.disabledPlugins, [])
        XCTAssertGreaterThanOrEqual(saved, 2)
    }

    func testOnEmitPipesEveryEvent() {
        let dir = tmp()
        writePlugin(dir, "emitter", "t.on('note:saved', () => {});")
        var seen: [(String, Any?)] = []
        let h = makeHost(dir)
        h.onEmit = { seen.append(($0, $1)) }
        h.discover(); h.activateAll()
        h.emit("note:saved", ["id": "a"])
        XCTAssertTrue(seen.contains { $0.0 == "ready" })
        XCTAssertTrue(seen.contains { $0.0 == "note:saved" && ($0.1 as? [String: Any])?["id"] as? String == "a" })
    }

    func testFileAllowlistIncludesSiblingJson() {
        let dir = tmp()
        let p = writePlugin(dir, "pack", nil, manifest: ["name": "pack", "renderer": "renderer.js"])
        write(p.appendingPathComponent("renderer.js"), "module.exports=function(){};")
        write(p.appendingPathComponent("words.json"), "[]")
        let h = makeHost(dir)
        h.discover(); h.activateAll()
        let e = h.fileAllowlist()["pack"]
        XCTAssertEqual(e?.files.contains("renderer.js"), true)
        XCTAssertEqual(e?.files.contains("words.json"), true)
        XCTAssertEqual(e?.files.contains("plugin.json"), false)
    }

    func testEnableActivatesLiveAndFiresOnlyItsReady() {
        let dir = tmp()
        writePlugin(dir, "early", "t.on('ready', () => t.settings.set('readyN', t.settings.get('readyN', 0) + 1));")
        writePlugin(dir, "late", "t.registerCommand('late-cmd', () => 'late'); t.on('ready', () => t.settings.set('sawReady', true));")
        let s = Settings(file: nil)
        s.disabledPlugins = ["late"]
        let h = makeHost(dir, settings: s)
        h.discover(); h.activateAll()
        XCTAssertNil(h.runCommand("late-cmd"))
        XCTAssertEqual(s.pluginValues["early"]?["readyN"] as? Double, 1)
        XCTAssertTrue(h.enable("late"))
        XCTAssertEqual(run(h, "late-cmd"), "late")
        XCTAssertEqual(s.pluginValues["late"]?["sawReady"] as? Bool, true)
        XCTAssertEqual(s.pluginValues["early"]?["readyN"] as? Double, 1)
        XCTAssertEqual(s.disabledPlugins, [])
    }

    func testDisableTearsDownLive() {
        let dir = tmp()
        let p = writePlugin(dir, "pack", """
            t.registerCommand('pack-cmd', () => 'x');
            t.registerService({ ping: () => 'pong' });
            t.on('note:saved', () => t.settings.set('saves', t.settings.get('saves', 0) + 1));
            """, manifest: ["name": "pack", "themes": [["id": "pack-theme", "name": "Pack", "css": "pack.css"]]])
        write(p.appendingPathComponent("pack.css"), "body{}")
        let s = Settings(file: nil)
        let h = makeHost(dir, settings: s)
        h.discover(); h.activateAll()
        XCTAssertTrue(h.hasTheme("pack-theme"))
        h.emit("note:saved", [String: Any]())
        XCTAssertEqual(s.pluginValues["pack"]?["saves"] as? Double, 1)
        XCTAssertTrue(h.disable("pack"))
        XCTAssertNil(h.runCommand("pack-cmd"))
        XCTAssertFalse(h.hasTheme("pack-theme"))
        if case .success = invoke(h, "pack", "ping") { XCTFail("service should be gone") }
        h.emit("note:saved", [String: Any]())
        XCTAssertEqual(s.pluginValues["pack"]?["saves"] as? Double, 1)
        XCTAssertEqual(s.disabledPlugins, ["pack"])
    }

    func testEnableRestoresTheme() {
        let dir = tmp()
        let p = writePlugin(dir, "pack", nil, manifest: ["name": "pack", "themes": [["id": "pack-theme", "name": "Pack", "css": "pack.css"]]])
        write(p.appendingPathComponent("pack.css"), "body{}")
        let s = Settings(file: nil)
        s.disabledPlugins = ["pack"]
        let h = makeHost(dir, settings: s)
        h.discover(); h.activateAll()
        XCTAssertFalse(h.hasTheme("pack-theme"))
        XCTAssertTrue(h.enable("pack"))
        XCTAssertTrue(h.hasTheme("pack-theme"))
    }

    func testCustomEventsBetweenPlugins() {
        let dir = tmp()
        writePlugin(dir, "source", "t.on('ready', () => t.emit('daily:open', { id: 'x' }));")
        let sink = tmp().appendingPathComponent("sink")
        try? FileManager.default.createDirectory(at: sink, withIntermediateDirectories: true)
        write(sink.appendingPathComponent("index.js"),
              "module.exports = function (t) { t.on('daily:open', (p) => { t.settings.set('got', p.id); }); };")
        let s = Settings(file: nil)
        let h = makeHost(dir, settings: s, envFiles: [sink.path])
        h.discover(); h.activateAll()
        XCTAssertEqual(s.pluginValues["sink"]?["got"] as? String, "x")
    }

    func testNodeShimsForExamplePlugins() {
        let dir = tmp()
        writePlugin(dir, "shim", """
            const fs = require('fs'), path = require('path'), os = require('os');
            const f = path.join(t.dataDir(), 'a.txt');
            fs.writeFileSync(f, 'hello');
            t.registerCommand('shim', () => [fs.readFileSync(f, 'utf8'), path.basename(f, '.txt'), typeof os.tmpdir(),
              Buffer.from('hi').toString('base64'), fs.existsSync(f)].join(','));
            """)
        let h = makeHost(dir)
        h.discover(); h.activateAll()
        XCTAssertEqual(state(h, "shim"), "ok", h.record(named: "shim")?.error ?? "")
        XCTAssertEqual(run(h, "shim"), "hello,a,string,aGk=,true")
    }

    func testBuiltinPluginsActivate() throws {
        let builtin = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../plugins/builtin").standardizedFileURL
        try XCTSkipUnless(FileManager.default.fileExists(atPath: builtin.path))
        let h = makeHost(tmp(), layers: [PluginHost.Layer(name: "builtin", dir: builtin)])
        var registered: [String] = []
        h.onShortcut = { accel, _, _ in registered.append(accel); return true }
        h.discover(); h.activateAll()
        for p in plugins(h) { XCTAssertEqual(p["state"] as? String, "ok", "\(p["name"] ?? "")") }
        XCTAssertTrue(h.hasCommand("toggle"))
        XCTAssertTrue(h.hasCommand("status"))
        XCTAssertFalse(registered.isEmpty)
        XCTAssertTrue(h.hasTheme("latte"))
    }
}
