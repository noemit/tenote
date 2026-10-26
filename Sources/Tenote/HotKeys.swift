import Carbon.HIToolbox
import Foundation
import TenoteCore

/// System-wide shortcuts via Carbon RegisterEventHotKey (no accessibility
/// permission needed, same as Electron's globalShortcut).
final class HotKeys {
    private struct Entry { let ref: EventHotKeyRef; let fire: () -> Void; let accelerator: String }
    private var entries: [UInt32: Entry] = [:]
    private var nextId: UInt32 = 1
    private var handler: EventHandlerRef?
    private static let signature: OSType = 0x544E_4F54 // 'TNOT'

    init() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let me = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, ctx in
            guard let event = event, let ctx = ctx else { return OSStatus(eventNotHandledErr) }
            var hk = EventHotKeyID()
            let st = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                       nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
            guard st == noErr else { return st }
            let keys = Unmanaged<HotKeys>.fromOpaque(ctx).takeUnretainedValue()
            if let e = keys.entries[hk.id] { DispatchQueue.main.async { e.fire() } }
            return noErr
        }, 1, &spec, me, &handler)
    }

    func isRegistered(_ accelerator: String) -> Bool { entries.values.contains { $0.accelerator == accelerator } }

    func register(_ accelerator: String, fire: @escaping () -> Void) -> Bool {
        guard let acc = Accelerator(accelerator), !isRegistered(accelerator) else { return false }
        var ref: EventHotKeyRef?
        let id = nextId
        nextId += 1
        let st = RegisterEventHotKey(acc.keyCode, acc.modifiers, EventHotKeyID(signature: HotKeys.signature, id: id),
                                     GetApplicationEventTarget(), 0, &ref)
        guard st == noErr, let r = ref else { return false }
        entries[id] = Entry(ref: r, fire: fire, accelerator: accelerator)
        return true
    }

    func unregister(_ accelerator: String) {
        for (id, e) in entries where e.accelerator == accelerator {
            UnregisterEventHotKey(e.ref)
            entries[id] = nil
        }
    }

    func unregisterAll() {
        for e in entries.values { UnregisterEventHotKey(e.ref) }
        entries.removeAll()
    }
}
