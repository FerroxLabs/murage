import AppKit
import ApplicationServices
import Foundation

struct Context {
    let app: String
    let windowTitle: String
}

final class Recorder {
    private let stopFile: String
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var timer: Timer?
    private var lastContext = Context(app: "", windowTitle: "")
    private let startedAt = ProcessInfo.processInfo.systemUptime

    init(stopFile: String) {
        self.stopFile = stopFile
    }

    private func nowMs() -> Int {
        return Int((ProcessInfo.processInfo.systemUptime - startedAt) * 1000)
    }

    private func context() -> Context {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            return Context(app: "", windowTitle: "")
        }
        let appName = app.localizedName ?? ""
        let element = AXUIElementCreateApplication(app.processIdentifier)
        var focused: CFTypeRef?
        var title = ""
        if AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute as CFString, &focused) == .success,
           let window = focused,
           CFGetTypeID(window) == AXUIElementGetTypeID() {
            var value: CFTypeRef?
            let windowElement = window as! AXUIElement
            if AXUIElementCopyAttributeValue(windowElement, kAXTitleAttribute as CFString, &value) == .success,
               let string = value as? String {
                title = String(string.prefix(240))
            }
        }
        return Context(app: appName, windowTitle: title)
    }

    private func emit(_ values: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(values),
              let data = try? JSONSerialization.data(withJSONObject: values),
              let line = String(data: data, encoding: .utf8) else { return }
        FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
        fflush(stdout)
    }

    private func emitContextIfChanged(force: Bool = false) -> Context {
        let current = context()
        if force || current.app != lastContext.app || current.windowTitle != lastContext.windowTitle {
            lastContext = current
            emit(["type": "app", "atMs": nowMs(), "app": current.app, "windowTitle": current.windowTitle])
        }
        return current
    }

    func handle(type: CGEventType, event: CGEvent) {
        let current = emitContextIfChanged()
        var values: [String: Any] = [
            "atMs": nowMs(),
            "app": current.app,
            "windowTitle": current.windowTitle,
        ]
        switch type {
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            let point = event.location
            values["type"] = "click"
            values["x"] = Int(point.x)
            values["y"] = Int(point.y)
            values["button"] = type == .leftMouseDown ? "left" : type == .rightMouseDown ? "right" : "other"
        case .scrollWheel:
            values["type"] = "scroll"
            values["deltaY"] = event.getIntegerValueField(.scrollWheelEventDeltaAxis1)
        case .keyDown:
            values["type"] = "key"
            values["keycode"] = event.getIntegerValueField(.keyboardEventKeycode)
            let flags = event.flags
            values["meta"] = flags.contains(.maskCommand)
            values["control"] = flags.contains(.maskControl)
            values["option"] = flags.contains(.maskAlternate)
            values["shift"] = flags.contains(.maskShift)
        default:
            return
        }
        emit(values)
    }

    func start() -> Bool {
        let mask = (1 << CGEventType.leftMouseDown.rawValue)
            | (1 << CGEventType.rightMouseDown.rawValue)
            | (1 << CGEventType.otherMouseDown.rawValue)
            | (1 << CGEventType.scrollWheel.rawValue)
            | (1 << CGEventType.keyDown.rawValue)
        let callback: CGEventTapCallBack = { _, type, event, refcon in
            guard let refcon = refcon else { return Unmanaged.passUnretained(event) }
            let recorder = Unmanaged<Recorder>.fromOpaque(refcon).takeUnretainedValue()
            if type == .tapDisabledByTimeout {
                if let tap = recorder.tap {
                    CGEvent.tapEnable(tap: tap, enable: true)
                }
                return Unmanaged.passUnretained(event)
            }
            recorder.handle(type: type, event: event)
            return Unmanaged.passUnretained(event)
        }
        tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: CGEventMask(mask),
            callback: callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        )
        guard let tap = tap else { return false }
        source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        _ = emitContextIfChanged(force: true)
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            if FileManager.default.fileExists(atPath: self.stopFile) {
                CFRunLoopStop(CFRunLoopGetMain())
                return
            }
            _ = self.emitContextIfChanged()
        }
        return true
    }
}

func argument(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[index + 1]
}

guard let stopFile = argument("--stop-file") else {
    fputs("missing --stop-file\n", stderr)
    exit(2)
}
let trustOptions = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
guard AXIsProcessTrustedWithOptions(trustOptions) else {
    fputs("Allow OpenMausBot Recorder in Privacy & Security → Accessibility, then try again. Input Monitoring may also be requested.\n", stderr)
    exit(3)
}
let recorder = Recorder(stopFile: stopFile)
guard recorder.start() else {
    fputs("input monitoring permission is required\n", stderr)
    exit(4)
}
RunLoop.main.run()
