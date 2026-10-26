import Foundation
import JavaScriptCore

/// The JavaScriptCore context that runs plugin "main" code (index.js).
///
/// Plugins were written against Node, so this provides the slice of Node they
/// actually use: CommonJS `require` (relative files, JSON), `fs`, `fs/promises`,
/// `path`, `os`, `child_process.execFile/exec`, `process`, `Buffer`, `console`
/// and timers. Everything runs on the main thread.
public final class JSRuntime {
    public let context: JSContext
    let logger: Logger
    private let native: JSValue
    private var timers: [Int: DispatchSourceTimer] = [:]
    private var nextTimerId = 1

    public init(logger: Logger, version: String = "") {
        guard let ctx = JSContext() else { fatalError("JavaScriptCore unavailable") }
        context = ctx
        context.name = "Tenote plugins"
        self.logger = logger
        native = JSValue(newObjectIn: ctx)
        installNatives()
        let info: [String: Any] = [
            "env": ProcessInfo.processInfo.environment,
            "home": FileManager.default.homeDirectoryForCurrentUser.path,
            "tmpdir": JSRuntime.tmpdir(),
            "cwd": FileManager.default.currentDirectoryPath,
            "pid": Int(ProcessInfo.processInfo.processIdentifier),
            "uid": Int(getuid()),
            "user": NSUserName(),
            "hostname": ProcessInfo.processInfo.hostName,
            "arch": JSRuntime.arch(),
            "version": version,
        ]
        let prelude = context.evaluateScript(JSRuntime.prelude, withSourceURL: URL(string: "tenote://runtime/prelude.js"))
        prelude?.call(withArguments: [native as Any, info])
        if let e = takeException() { logger.error("plugins", "runtime prelude failed", ["error": e]) }
    }

    deinit {
        for t in timers.values { t.cancel() }
    }

    // MARK: helpers used by the host

    /// Returns and clears the pending JS exception (stack if available).
    public func takeException() -> String? {
        guard let e = context.exception else { return nil }
        context.exception = nil
        return JSRuntime.describe(e)
    }

    public static func describe(_ e: JSValue) -> String {
        let msg = e.toString() ?? "error"
        if let stack = e.forProperty("stack"), stack.isString, let s = stack.toString(), !s.isEmpty {
            return "\(msg)\n\(s)"
        }
        return msg
    }

    public func isFunction(_ v: JSValue?) -> Bool {
        guard let v = v, v.isObject, let fnCtor = context.objectForKeyedSubscript("Function") else { return false }
        return v.isInstance(of: fnCtor)
    }

    public func isThenable(_ v: JSValue?) -> Bool {
        guard let v = v, v.isObject else { return false }
        return isFunction(v.forProperty("then"))
    }

    public func value(_ object: Any?) -> JSValue {
        guard let object = object, !(object is NSNull) else { return JSValue(nullIn: context) }
        return JSValue(object: object, in: context)
    }

    /// Calls `fn` and reports a thrown exception instead of propagating it.
    public func call(_ fn: JSValue, _ args: [Any] = [], this: JSValue? = nil, method: String? = nil) -> Result<JSValue, JSError> {
        context.exception = nil
        let result: JSValue?
        if let this = this, let method = method {
            result = this.invokeMethod(method, withArguments: args)
        } else {
            result = fn.call(withArguments: args)
        }
        if let e = takeException() { return .failure(JSError(message: e)) }
        return .success(result ?? JSValue(undefinedIn: context))
    }

    /// Resolves a plain value or a thenable to a Foundation value.
    public func settle(_ v: JSValue, _ done: @escaping (Result<Any?, JSError>) -> Void) {
        guard isThenable(v) else { done(.success(JSRuntime.foundation(v))); return }
        let onOk: @convention(block) (JSValue) -> Void = { r in done(.success(JSRuntime.foundation(r))) }
        let onErr: @convention(block) (JSValue) -> Void = { e in
            let msg = e.isObject ? (e.forProperty("message")?.toString() ?? e.toString() ?? "error") : (e.toString() ?? "error")
            done(.failure(JSError(message: msg)))
        }
        context.exception = nil
        v.invokeMethod("then", withArguments: [unsafeBitCast(onOk, to: AnyObject.self), unsafeBitCast(onErr, to: AnyObject.self)])
        if let e = takeException() { done(.failure(JSError(message: e))) }
    }

    public static func foundation(_ v: JSValue?) -> Any? {
        guard let v = v, !v.isUndefined else { return nil }
        if v.isNull { return NSNull() }
        return v.toObject()
    }

    /// Loads a CommonJS module fresh (bypassing the require cache).
    public func load(module path: String) -> Result<JSValue, JSError> {
        guard let loader = context.objectForKeyedSubscript("__tenoteLoad") else {
            return .failure(JSError(message: "runtime not initialised"))
        }
        return call(loader, [path])
    }

    public func makeApi(bridge: JSValue, name: String, version: String?, notesDir: String) -> JSValue? {
        guard let make = context.objectForKeyedSubscript("__tenoteMakeApi") else { return nil }
        return make.call(withArguments: [bridge, name, version ?? NSNull(), notesDir])
    }

    public struct JSError: Error, CustomStringConvertible {
        public let message: String
        public init(message: String) { self.message = message }
        public var description: String { message }
    }

    static func tmpdir() -> String {
        var t = ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory()
        if t.isEmpty { t = "/tmp" }
        while t.count > 1 && t.hasSuffix("/") { t.removeLast() }
        return t
    }

    static func arch() -> String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x64"
        #endif
    }

    // MARK: natives

    static func fail(_ message: String, code: String? = nil) {
        guard let ctx = JSContext.current(), let err = JSValue(newErrorFromMessage: message, in: ctx) else { return }
        if let code = code { err.setValue(code, forProperty: "code") }
        ctx.exception = err
    }

    static func fail(_ error: Error, path: String) {
        let ns = error as NSError
        var code = "EIO"
        if ns.domain == NSCocoaErrorDomain {
            switch ns.code {
            case NSFileNoSuchFileError, NSFileReadNoSuchFileError: code = "ENOENT"
            case NSFileWriteFileExistsError: code = "EEXIST"
            case NSFileReadNoPermissionError, NSFileWriteNoPermissionError: code = "EACCES"
            default: break
            }
            if let u = ns.userInfo[NSUnderlyingErrorKey] as? NSError, u.domain == NSPOSIXErrorDomain {
                if u.code == Int(ENOENT) { code = "ENOENT" }
                if u.code == Int(ENOTDIR) { code = "ENOTDIR" }
                if u.code == Int(ENOTEMPTY) { code = "ENOTEMPTY" }
            }
        } else if ns.domain == NSPOSIXErrorDomain, ns.code == Int(ENOENT) {
            code = "ENOENT"
        }
        fail("\(code): \(ns.localizedDescription), '\(path)'", code: code)
    }

    private func put(_ name: String, _ block: AnyObject) {
        native.setObject(block, forKeyedSubscript: name as NSString)
    }

    private func installNatives() {
        let fm = FileManager.default
        let log = logger

        let logFn: @convention(block) (String, String, String, JSValue) -> Void = { level, tag, msg, extra in
            let l = Logger.Level(name: level) ?? .info
            log.log(l, tag, msg, extraJSON: (extra.isNull || extra.isUndefined) ? nil : extra.toString())
        }
        put("log", unsafeBitCast(logFn, to: AnyObject.self))

        let exists: @convention(block) (String) -> Bool = { p in fm.fileExists(atPath: p) }
        put("fsExists", unsafeBitCast(exists, to: AnyObject.self))

        let read: @convention(block) (String, Bool) -> JSValue? = { p, b64 in
            guard let ctx = JSContext.current() else { return nil }
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: p, isDirectory: &isDir), isDir.boolValue {
                JSRuntime.fail("EISDIR: illegal operation on a directory, read '\(p)'", code: "EISDIR"); return nil
            }
            do {
                let data = try Data(contentsOf: URL(fileURLWithPath: p))
                let s = b64 ? data.base64EncodedString() : String(decoding: data, as: UTF8.self)
                return JSValue(object: s, in: ctx)
            } catch {
                JSRuntime.fail(error, path: p); return nil
            }
        }
        put("fsRead", unsafeBitCast(read, to: AnyObject.self))

        let write: @convention(block) (String, String, Bool, Bool) -> Void = { p, content, b64, append in
            let data: Data
            if b64 {
                guard let d = Data(base64Encoded: content) else { JSRuntime.fail("bad buffer data", code: "EINVAL"); return }
                data = d
            } else {
                data = Data(content.utf8)
            }
            let url = URL(fileURLWithPath: p)
            do {
                if append, fm.fileExists(atPath: p) {
                    let h = try FileHandle(forWritingTo: url)
                    defer { try? h.close() }
                    _ = try h.seekToEnd()
                    try h.write(contentsOf: data)
                } else {
                    try data.write(to: url)
                }
            } catch {
                JSRuntime.fail(error, path: p)
            }
        }
        put("fsWrite", unsafeBitCast(write, to: AnyObject.self))

        let stat: @convention(block) (String) -> JSValue? = { p in
            guard let ctx = JSContext.current() else { return nil }
            do {
                let a = try fm.attributesOfItem(atPath: p)
                let type = a[.type] as? FileAttributeType
                let m = (a[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
                let b = (a[.creationDate] as? Date)?.timeIntervalSince1970 ?? m
                return JSValue(object: [
                    "isDir": type == .typeDirectory,
                    "isFile": type == .typeRegular,
                    "isSymlink": type == .typeSymbolicLink,
                    "size": (a[.size] as? NSNumber)?.doubleValue ?? 0,
                    "mtimeMs": m * 1000,
                    "birthtimeMs": b * 1000,
                ], in: ctx)
            } catch {
                JSRuntime.fail(error, path: p); return nil
            }
        }
        put("fsStat", unsafeBitCast(stat, to: AnyObject.self))

        let readdir: @convention(block) (String) -> JSValue? = { p in
            guard let ctx = JSContext.current() else { return nil }
            do {
                let names = try fm.contentsOfDirectory(atPath: p).sorted()
                let out: [[String: Any]] = names.map { n in
                    var isDir: ObjCBool = false
                    let full = (p as NSString).appendingPathComponent(n)
                    let exists = fm.fileExists(atPath: full, isDirectory: &isDir)
                    return ["name": n, "isDir": exists && isDir.boolValue, "isFile": exists && !isDir.boolValue]
                }
                return JSValue(object: out, in: ctx)
            } catch {
                JSRuntime.fail(error, path: p); return nil
            }
        }
        put("fsReaddir", unsafeBitCast(readdir, to: AnyObject.self))

        let mkdir: @convention(block) (String, Bool) -> Void = { p, recursive in
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: p, isDirectory: &isDir) {
                if recursive && isDir.boolValue { return }
                JSRuntime.fail("EEXIST: file already exists, mkdir '\(p)'", code: "EEXIST"); return
            }
            do { try fm.createDirectory(atPath: p, withIntermediateDirectories: recursive) } catch { JSRuntime.fail(error, path: p) }
        }
        put("fsMkdir", unsafeBitCast(mkdir, to: AnyObject.self))

        let rm: @convention(block) (String, Bool, Bool) -> Void = { p, recursive, force in
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: p, isDirectory: &isDir) else {
                if !force { JSRuntime.fail("ENOENT: no such file or directory, rm '\(p)'", code: "ENOENT") }
                return
            }
            if isDir.boolValue && !recursive {
                if ((try? fm.contentsOfDirectory(atPath: p)) ?? []).isEmpty == false {
                    JSRuntime.fail("ENOTEMPTY: directory not empty, rm '\(p)'", code: "ENOTEMPTY"); return
                }
            }
            do { try fm.removeItem(atPath: p) } catch { JSRuntime.fail(error, path: p) }
        }
        put("fsRm", unsafeBitCast(rm, to: AnyObject.self))

        let unlink: @convention(block) (String) -> Void = { p in
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: p, isDirectory: &isDir) else {
                JSRuntime.fail("ENOENT: no such file or directory, unlink '\(p)'", code: "ENOENT"); return
            }
            if isDir.boolValue { JSRuntime.fail("EPERM: operation not permitted, unlink '\(p)'", code: "EPERM"); return }
            do { try fm.removeItem(atPath: p) } catch { JSRuntime.fail(error, path: p) }
        }
        put("fsUnlink", unsafeBitCast(unlink, to: AnyObject.self))

        let rename: @convention(block) (String, String) -> Void = { a, b in
            if Foundation.rename(a, b) != 0 {
                let code = errno == ENOENT ? "ENOENT" : "EIO"
                JSRuntime.fail("\(code): rename '\(a)' -> '\(b)'", code: code)
            }
        }
        put("fsRename", unsafeBitCast(rename, to: AnyObject.self))

        let copy: @convention(block) (String, String, Bool) -> Void = { a, b, recursive in
            do {
                var isDir: ObjCBool = false
                guard fm.fileExists(atPath: a, isDirectory: &isDir) else {
                    JSRuntime.fail("ENOENT: no such file or directory, copy '\(a)'", code: "ENOENT"); return
                }
                if isDir.boolValue && !recursive {
                    JSRuntime.fail("EISDIR: is a directory, copy '\(a)'", code: "EISDIR"); return
                }
                if fm.fileExists(atPath: b) {
                    if isDir.boolValue {
                        for name in try fm.contentsOfDirectory(atPath: a) {
                            let src = (a as NSString).appendingPathComponent(name)
                            let dst = (b as NSString).appendingPathComponent(name)
                            if fm.fileExists(atPath: dst) { try fm.removeItem(atPath: dst) }
                            try fm.copyItem(atPath: src, toPath: dst)
                        }
                        return
                    }
                    try fm.removeItem(atPath: b)
                }
                try fm.copyItem(atPath: a, toPath: b)
            } catch {
                JSRuntime.fail(error, path: a)
            }
        }
        put("fsCopy", unsafeBitCast(copy, to: AnyObject.self))

        let mkdtemp: @convention(block) (String) -> JSValue? = { prefix in
            guard let ctx = JSContext.current() else { return nil }
            let chars = Array("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
            for _ in 0..<20 {
                let p = prefix + String((0..<6).map { _ in chars[Int.random(in: 0..<chars.count)] })
                if fm.fileExists(atPath: p) { continue }
                do { try fm.createDirectory(atPath: p, withIntermediateDirectories: false); return JSValue(object: p, in: ctx) }
                catch { JSRuntime.fail(error, path: p); return nil }
            }
            JSRuntime.fail("EEXIST: mkdtemp '\(prefix)'", code: "EEXIST")
            return nil
        }
        put("fsMkdtemp", unsafeBitCast(mkdtemp, to: AnyObject.self))

        let realpath: @convention(block) (String) -> String = { p in
            URL(fileURLWithPath: p).resolvingSymlinksInPath().path
        }
        put("fsRealpath", unsafeBitCast(realpath, to: AnyObject.self))

        let setTimer: @convention(block) (Double, Bool, JSValue) -> Int = { [weak self] ms, repeats, fn in
            self?.addTimer(ms: ms, repeats: repeats, fn: fn) ?? 0
        }
        put("setTimer", unsafeBitCast(setTimer, to: AnyObject.self))

        let clearTimer: @convention(block) (Int) -> Void = { [weak self] id in
            self?.timers.removeValue(forKey: id)?.cancel()
        }
        put("clearTimer", unsafeBitCast(clearTimer, to: AnyObject.self))

        let evalModule: @convention(block) (String, String) -> JSValue? = { src, file in
            guard let ctx = JSContext.current() else { return nil }
            return ctx.evaluateScript(src, withSourceURL: URL(fileURLWithPath: file))
        }
        put("evalModule", unsafeBitCast(evalModule, to: AnyObject.self))

        let exec: @convention(block) (String, JSValue, JSValue, JSValue) -> Void = { [weak self] file, args, opts, cb in
            let argv = (args.toArray() ?? []).map { "\($0)" }
            let o = (opts.toDictionary() as? [String: Any]) ?? [:]
            self?.runProcess(file: file, args: argv, cwd: o["cwd"] as? String,
                             timeoutMs: (o["timeout"] as? NSNumber)?.doubleValue ?? 0,
                             env: o["env"] as? [String: Any], callback: cb)
        }
        put("exec", unsafeBitCast(exec, to: AnyObject.self))
    }

    private func addTimer(ms: Double, repeats: Bool, fn: JSValue) -> Int {
        let id = nextTimerId
        nextTimerId += 1
        let delay = max(0, ms.isFinite ? ms : 0) / 1000
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now() + delay, repeating: repeats ? max(delay, 0.001) : .infinity)
        t.setEventHandler { [weak self] in
            guard let self = self else { return }
            if !repeats { self.timers.removeValue(forKey: id)?.cancel() }
            if case .failure(let e) = self.call(fn) {
                self.logger.error("plugins", "timer callback threw", ["error": e.message])
            }
        }
        timers[id] = t
        t.resume()
        return id
    }

    private final class ProcessOutput {
        var stdout = Data()
        var stderr = Data()
        var timedOut = false
    }

    private func runProcess(file: String, args: [String], cwd: String?, timeoutMs: Double, env: [String: Any]?, callback: JSValue) {
        let logger = self.logger
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let p = Process()
            if file.hasPrefix("/") {
                p.executableURL = URL(fileURLWithPath: file)
                p.arguments = args
            } else {
                p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                p.arguments = [file] + args
            }
            if let cwd = cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
            if let env = env {
                var e: [String: String] = [:]
                for (k, v) in env { e[k] = "\(v)" }
                p.environment = e
            }
            let outPipe = Pipe(), errPipe = Pipe()
            p.standardOutput = outPipe
            p.standardError = errPipe
            p.standardInput = FileHandle.nullDevice
            let out = ProcessOutput()
            var launchError: String?
            do {
                try p.run()
                let group = DispatchGroup()
                group.enter()
                DispatchQueue.global().async { out.stdout = outPipe.fileHandleForReading.readDataToEndOfFile(); group.leave() }
                group.enter()
                DispatchQueue.global().async { out.stderr = errPipe.fileHandleForReading.readDataToEndOfFile(); group.leave() }
                if timeoutMs > 0 {
                    DispatchQueue.global().asyncAfter(deadline: .now() + timeoutMs / 1000) {
                        if p.isRunning { out.timedOut = true; p.terminate() }
                    }
                }
                p.waitUntilExit()
                group.wait()
            } catch {
                launchError = "spawn \(file) ENOENT: \(error.localizedDescription)"
            }
            let code = launchError == nil ? Int(p.terminationStatus) : -2
            var err: Any = NSNull()
            if let le = launchError { err = le }
            else if out.timedOut { err = "Command timed out: \(file) \(args.joined(separator: " "))" }
            else if code != 0 { err = "Command failed (exit \(code)): \(file) \(args.joined(separator: " "))" }
            let so = String(decoding: out.stdout, as: UTF8.self)
            let se = String(decoding: out.stderr, as: UTF8.self)
            DispatchQueue.main.async {
                guard let self = self else { return }
                if case .failure(let e) = self.call(callback, [err, code, so, se]) {
                    logger.error("plugins", "exec callback threw", ["error": e.message])
                }
            }
        }
    }
}
