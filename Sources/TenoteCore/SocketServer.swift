import Foundation

private func makeAddress(_ path: String) -> sockaddr_un? {
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    let capacity = MemoryLayout.size(ofValue: addr.sun_path)
    guard bytes.count < capacity else { return nil }
    withUnsafeMutableBytes(of: &addr.sun_path) { buf in
        for (i, b) in bytes.enumerated() { buf[i] = b }
        buf[bytes.count] = 0
    }
    #if os(macOS)
    addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    #endif
    return addr
}

/// Line-oriented Unix-domain socket used by tenotectl / skhd. One command per
/// connection: the first reply ends the connection (like `sock.end()`).
public final class SocketServer {
    public let path: String
    let logger: Logger
    let handler: (String, @escaping (String) -> Void) -> Void
    private var fd: Int32 = -1
    private var source: DispatchSourceRead?
    private let queue = DispatchQueue(label: "tenote.socket")

    /// `handler` runs on the main queue.
    public init(path: String, logger: Logger, handler: @escaping (String, @escaping (String) -> Void) -> Void) {
        self.path = path
        self.logger = logger
        self.handler = handler
    }

    @discardableResult
    public func start() -> Bool {
        unlink(path)
        guard var addr = makeAddress(path) else {
            logger.error("socket", "path too long", ["path": path]); return false
        }
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { logger.error("socket", "socket() failed", ["errno": Int(errno)]); return false }
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard ok == 0 else {
            logger.error("socket", "listen error", ["errno": Int(errno), "path": path])
            close(fd); fd = -1; return false
        }
        chmod(path, 0o600)
        guard listen(fd, 16) == 0 else {
            logger.error("socket", "listen error", ["errno": Int(errno), "path": path])
            close(fd); fd = -1; return false
        }
        let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        src.setEventHandler { [weak self] in self?.acceptClient() }
        src.resume()
        source = src
        logger.info("socket", "listening", ["path": path])
        return true
    }

    public func stop() {
        source?.cancel()
        source = nil
        if fd >= 0 { close(fd); fd = -1 }
        unlink(path)
    }

    private func acceptClient() {
        let c = accept(fd, nil, nil)
        guard c >= 0 else { return }
        var one: Int32 = 1
        setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in self?.serve(c) }
    }

    private func serve(_ c: Int32) {
        var tv = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var data = Data()
        var buf = [UInt8](repeating: 0, count: 1024)
        while !data.contains(0x0A) && data.count < 65536 {
            let n = read(c, &buf, buf.count)
            if n <= 0 { break }
            data.append(contentsOf: buf[0..<n])
        }
        guard let nl = data.firstIndex(of: 0x0A) else { close(c); return }
        let cmd = String(decoding: data[data.startIndex..<nl], as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        var replied = false
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { close(c); return }
            self.handler(cmd) { reply in
                guard !replied else { return }
                replied = true
                self.queue.async {
                    let bytes = Array(reply.utf8)
                    var off = 0
                    while off < bytes.count {
                        let n = bytes[off...].withUnsafeBufferPointer { write(c, $0.baseAddress, $0.count) }
                        if n <= 0 { break }
                        off += n
                    }
                    close(c)
                }
            }
        }
    }

    /// Sends one command and returns the reply (nil if nobody is listening).
    public static func send(_ command: String, to path: String, timeout: TimeInterval = 5) -> String? {
        guard var addr = makeAddress(path) else { return nil }
        let s = socket(AF_UNIX, SOCK_STREAM, 0)
        guard s >= 0 else { return nil }
        defer { close(s) }
        var one: Int32 = 1
        setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        var tv = timeval(tv_sec: Int(timeout), tv_usec: 0)
        setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(s, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard ok == 0 else { return nil }
        let bytes = Array((command + "\n").utf8)
        guard bytes.withUnsafeBufferPointer({ write(s, $0.baseAddress, $0.count) }) == bytes.count else { return nil }
        var out = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = read(s, &buf, buf.count)
            if n <= 0 { break }
            out.append(contentsOf: buf[0..<n])
        }
        return String(decoding: out, as: UTF8.self)
    }
}
