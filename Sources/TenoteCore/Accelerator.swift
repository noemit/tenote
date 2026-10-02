import Foundation

/// Parses Electron-style accelerators ("Alt+.", "CommandOrControl+Shift+N")
/// into a macOS virtual key code plus Carbon modifier mask, so plugin
/// `registerGlobalShortcut` calls keep working unchanged.
public struct Accelerator: Equatable, Hashable {
    public static let cmdKey: UInt32 = 1 << 8
    public static let shiftKey: UInt32 = 1 << 9
    public static let optionKey: UInt32 = 1 << 11
    public static let controlKey: UInt32 = 1 << 12

    public let keyCode: UInt32
    public let modifiers: UInt32
    public let key: String

    static let keyCodes: [String: UInt32] = [
        "A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7, "C": 8, "V": 9,
        "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15, "Y": 16, "T": 17,
        "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
        "-": 27, "8": 28, "0": 29, "]": 30, "O": 31, "U": 32, "[": 33, "I": 34, "P": 35,
        "RETURN": 36, "ENTER": 36, "L": 37, "J": 38, "'": 39, "K": 40, ";": 41, "\\": 42,
        ",": 43, "/": 44, "N": 45, "M": 46, ".": 47, "TAB": 48, "SPACE": 49, " ": 49, "`": 50,
        "BACKSPACE": 51, "DELETE": 117, "ESCAPE": 53, "ESC": 53,
        "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97, "F7": 98, "F8": 100,
        "F9": 101, "F10": 109, "F11": 103, "F12": 111, "F13": 105, "F14": 107, "F15": 113,
        "F16": 106, "F17": 64, "F18": 79, "F19": 80, "F20": 90,
        "LEFT": 123, "RIGHT": 124, "DOWN": 125, "UP": 126,
        "HOME": 115, "END": 119, "PAGEUP": 116, "PAGEDOWN": 121,
        "PLUS": 24,
    ]

    public init?(_ accelerator: String) {
        let raw = accelerator.trimmingCharacters(in: .whitespaces)
        guard !raw.isEmpty else { return nil }
        var parts: [String] = []
        // "Alt++" means Alt + the plus key.
        var buf = ""
        for ch in raw {
            if ch == "+" && !buf.isEmpty { parts.append(buf); buf = "" } else { buf.append(ch) }
        }
        if !buf.isEmpty { parts.append(buf) }
        guard let keyPart = parts.popLast() else { return nil }
        var mods: UInt32 = 0
        for p in parts {
            switch p.lowercased() {
            case "alt", "option": mods |= Accelerator.optionKey
            case "shift": mods |= Accelerator.shiftKey
            case "command", "cmd", "super", "meta", "commandorcontrol", "cmdorctrl": mods |= Accelerator.cmdKey
            case "control", "ctrl": mods |= Accelerator.controlKey
            default: return nil
            }
        }
        let k = keyPart.uppercased()
        guard let code = Accelerator.keyCodes[k] else { return nil }
        keyCode = code
        modifiers = mods
        key = keyPart.count == 1 ? k : keyPart
    }

    /// "Alt+." → "⌥." (what the tray and topbar show).
    public static func label(_ accelerator: String) -> String {
        accelerator.split(separator: "+", omittingEmptySubsequences: false).map { p -> String in
            switch p {
            case "Alt", "Option": return "⌥"
            case "Shift": return "⇧"
            case "CommandOrControl", "CmdOrCtrl", "Command", "Cmd": return "⌘"
            case "Control", "Ctrl": return "⌃"
            case "": return "+"
            default: return String(p)
            }
        }.joined()
    }
}
