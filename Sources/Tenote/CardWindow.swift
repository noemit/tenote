import AppKit
import TenoteCore
import WebKit

/// Transparent, borderless floating panel hosting the web UI. The card itself
/// is drawn by CSS inside a SHADOW_PAD margin, exactly like the Electron build.
final class CardPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class CardWebView: WKWebView {
    var onDropPaths: (([String]) -> Void)?
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        if !urls.isEmpty { onDropPaths?(urls.map { $0.path }) }
        return super.performDragOperation(sender)
    }
}

/// Serves tenote://app/… (web UI), timg://file/… (note images) and
/// tnplug://<plugin>/<file> (allowlisted plugin files).
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    typealias Resolver = (URL) -> (status: Int, data: Data, mime: String)
    let resolve: Resolver
    init(_ resolve: @escaping Resolver) { self.resolve = resolve }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let r = resolve(url)
        let headers = ["Content-Type": r.mime, "Content-Length": "\(r.data.count)", "Cache-Control": "no-store"]
        if let resp = HTTPURLResponse(url: url, statusCode: r.status, httpVersion: "HTTP/1.1", headerFields: headers) {
            task.didReceive(resp)
        }
        task.didReceive(r.data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    static func mime(for ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "woff2": return "font/woff2"
        case "md", "txt": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }

    static func file(_ url: URL?) -> (Int, Data, String) {
        guard let url = url, let data = try? Data(contentsOf: url) else { return (404, Data(), "text/plain") }
        return (200, data, mime(for: url.pathExtension))
    }
}

/// WKScriptMessageHandlerWithReply → AppController.handleIpc.
final class IpcBridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var controller: AppController?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let method = body["method"] as? String, let c = controller else {
            replyHandler(nil, "bad message"); return
        }
        let args = body["args"].flatMap { $0 is NSNull ? nil : $0 }
        c.handleIpc(method, args) { value in replyHandler(value.map(JSONCompat.sanitize), nil) }
    }
}

enum Edge: String { case n, s, e, w, ne, nw, se, sw }

/// Window geometry: cursor-anchored show, JS-driven drag/resize (the card has
/// no native chrome), and temporary growth for popover menus.
final class CardWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    static let width: CGFloat = 480
    static let height: CGFloat = 340
    static let shadowPad: CGFloat = 48
    static let minWidth: CGFloat = 300 + shadowPad * 2
    static let minHeight: CGFloat = 180 + shadowPad * 2

    let panel: CardPanel
    let webView: CardWebView
    let logger: Logger
    var onBlur: (() -> Void)?
    var onDidFinishLoad: (() -> Void)?

    private var tick: Timer?
    private var dragStart: (mouse: NSPoint, origin: NSPoint, moved: Bool)?
    private var resizeStart: (mouse: NSPoint, frame: NSRect, edge: Edge)?
    private var menuGrowFrom: NSRect?

    init(logger: Logger, config: WKWebViewConfiguration) {
        self.logger = logger
        let size = NSSize(width: CardWindow.width + CardWindow.shadowPad * 2, height: CardWindow.height + CardWindow.shadowPad * 2)
        panel = CardPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        webView = CardWebView(frame: NSRect(origin: .zero, size: size), configuration: config)
        super.init()
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.isMovable = false
        panel.isReleasedWhenClosed = false
        panel.minSize = NSSize(width: CardWindow.minWidth, height: CardWindow.minHeight)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.delegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        panel.contentView = webView
    }

    var isVisible: Bool { panel.isVisible }

    func show() {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
        let size = panel.frame.size
        var x = mouse.x - CardWindow.shadowPad + 12
        var y = mouse.y + CardWindow.shadowPad - 12 - size.height
        if let wa = screen?.visibleFrame {
            x = max(wa.minX, min(x, wa.maxX - size.width))
            y = max(wa.minY, min(y, wa.maxY - size.height))
        }
        panel.setFrameOrigin(NSPoint(x: x.rounded(), y: y.rounded()))
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(webView)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
            guard let p = self?.panel, p.isVisible, !p.isKeyWindow else { return }
            p.makeKey()
        }
    }

    func hide() {
        stopTick()
        panel.orderOut(nil)
        if !NSApp.windows.contains(where: { $0.isVisible && $0 !== panel && $0.level == .normal }) { NSApp.hide(nil) }
    }

    // MARK: drag / resize

    private func startTick() {
        guard tick == nil else { return }
        let t = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in self?.step() }
        RunLoop.main.add(t, forMode: .common)
        tick = t
    }

    private func stopTick() {
        tick?.invalidate()
        tick = nil
        dragStart = nil
        resizeStart = nil
    }

    func startDrag() {
        resizeStart = nil
        dragStart = (NSEvent.mouseLocation, panel.frame.origin, false)
        startTick()
    }

    func stopDrag() { if resizeStart == nil { stopTick() } else { dragStart = nil } }

    func startResize(_ edge: String) {
        guard let e = Edge(rawValue: edge) else { return }
        dragStart = nil
        menuGrowFrom = nil
        resizeStart = (NSEvent.mouseLocation, panel.frame, e)
        startTick()
    }

    func stopResize() { if dragStart == nil { stopTick() } else { resizeStart = nil } }

    private func step() {
        if NSEvent.pressedMouseButtons & 1 == 0 { stopTick(); return }
        let p = NSEvent.mouseLocation
        if var d = dragStart {
            let dx = p.x - d.mouse.x, dy = p.y - d.mouse.y
            if !d.moved && abs(dx) < 3 && abs(dy) < 3 { return }
            d.moved = true
            dragStart = d
            panel.setFrameOrigin(NSPoint(x: (d.origin.x + dx).rounded(), y: (d.origin.y + dy).rounded()))
        } else if let r = resizeStart {
            let dx = p.x - r.mouse.x, dy = p.y - r.mouse.y
            var left = r.frame.minX, right = r.frame.maxX, top = r.frame.maxY, bottom = r.frame.minY
            let e = r.edge.rawValue
            if e.contains("e") { right += dx }
            if e.contains("w") { left += dx }
            if e.contains("n") { top += dy }
            if e.contains("s") { bottom += dy }
            if right - left < CardWindow.minWidth {
                if e.contains("w") { left = right - CardWindow.minWidth } else { right = left + CardWindow.minWidth }
            }
            if top - bottom < CardWindow.minHeight {
                if e.contains("n") { top = bottom + CardWindow.minHeight } else { bottom = top - CardWindow.minHeight }
            }
            panel.setFrame(NSRect(x: left.rounded(), y: bottom.rounded(), width: (right - left).rounded(), height: (top - bottom).rounded()), display: true)
        } else {
            stopTick()
        }
    }

    /// `{ width, height }` grows the window (left/down, keeping the top-right
    /// corner put) so a menu fits; `{ restore: true }` undoes it.
    func ensureSize(_ opts: [String: Any]) -> Bool {
        let b = panel.frame
        if opts["restore"] as? Bool == true {
            guard let g = menuGrowFrom else { return true }
            menuGrowFrom = nil
            panel.setFrame(NSRect(x: b.maxX - g.width, y: b.maxY - g.height, width: g.width, height: g.height), display: true)
            return true
        }
        let wantW = CGFloat((opts["width"] as? Double) ?? 0) + CardWindow.shadowPad * 2
        let wantH = CGFloat((opts["height"] as? Double) ?? 0) + CardWindow.shadowPad * 2
        let w = max(b.width, wantW), h = max(b.height, wantH)
        if w == b.width && h == b.height { return true }
        if menuGrowFrom == nil { menuGrowFrom = b }
        let wa = (panel.screen ?? NSScreen.main)?.visibleFrame ?? b
        var x = b.maxX - w, nw = w, nh = h
        if x < wa.minX { nw -= wa.minX - x; x = wa.minX }
        if b.maxY - nh < wa.minY { nh = max(b.height, b.maxY - wa.minY) }
        if x + nw > wa.maxX { nw = wa.maxX - x }
        if nw < CardWindow.minWidth { nw = CardWindow.minWidth; if x + nw > wa.maxX { x = wa.maxX - nw } }
        nh = max(nh, CardWindow.minHeight)
        panel.setFrame(NSRect(x: x.rounded(), y: (b.maxY - nh).rounded(), width: nw.rounded(), height: nh.rounded()), display: true)
        return true
    }

    // MARK: delegates

    func windowDidResignKey(_ notification: Notification) { onBlur?() }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        logger.debug("window", "renderer did-finish-load")
        onDidFinishLoad?()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        logger.error("window", "did-fail-load", ["error": error.localizedDescription])
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        logger.error("window", "did-fail-load", ["error": error.localizedDescription])
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        logger.error("window", "render-process-gone")
        webView.reload()
    }

    private static func isExternal(_ url: URL?) -> Bool {
        guard let s = url?.scheme?.lowercased() else { return false }
        return s == "http" || s == "https" || s == "mailto"
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if CardWindow.isExternal(action.request.url) {
            if let u = action.request.url { NSWorkspace.shared.open(u) }
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if CardWindow.isExternal(action.request.url), let u = action.request.url { NSWorkspace.shared.open(u) }
        return nil
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }
}
