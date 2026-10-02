import Foundation
import TenoteCore

// tenotectl — control Tenote from the command line / skhd.
//
//   ~/.skhdrc:  period - alt : /Applications/Tenote Native.app/Contents/MacOS/tenotectl toggle
//
// Commands: toggle | show | hide | quit | status (plus any plugin command).
// If the app isn't running it is launched (`open -a "Tenote Native"`, or TENOTE_APP_PATH)
// and the command retried. TENOTE_SOCKET overrides the socket path.

let env = ProcessInfo.processInfo.environment
let socket = TenotePaths.defaultSocketPath(environment: env)
let cmd = CommandLine.arguments.dropFirst().first ?? "toggle"

func send(_ c: String) -> Bool {
    guard let reply = SocketServer.send(c, to: socket, timeout: 2) else { return false }
    FileHandle.standardOutput.write(Data(reply.utf8))
    return true
}

func launchApp() -> Bool {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    if let app = env["TENOTE_APP_PATH"], !app.isEmpty {
        p.arguments = [app]
    } else if let bundle = Bundle.main.bundleURL.pathExtension == "app" ? Bundle.main.bundleURL : nil {
        p.arguments = [bundle.path]
    } else {
        p.arguments = ["-a", "Tenote Native"]
    }
    do { try p.run() } catch { return false }
    p.waitUntilExit()
    return p.terminationStatus == 0
}

if cmd == "status" {
    if !send("status") { print("Tenote not running"); exit(1) }
    exit(0)
}
if send(cmd) { exit(0) }
guard launchApp() else {
    FileHandle.standardError.write(Data("could not launch the app — open Tenote Native.app manually\n".utf8))
    exit(1)
}
for _ in 0..<8 {
    Thread.sleep(forTimeInterval: 0.7)
    if send(cmd) { exit(0) }
}
FileHandle.standardError.write(Data("Tenote started but never came up on the socket — see ~/Library/Logs/Tenote/main.log\n".utf8))
exit(1)
