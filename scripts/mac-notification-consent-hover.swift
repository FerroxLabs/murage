// Fixture-only native hover. Never click, authorize, or write notification settings.
import AppKit
import ApplicationServices
import Foundation
let env = ProcessInfo.processInfo.environment
func refuse(_ code: String) -> Never { print("{\"ok\":false,\"error\":\"\(code)\"}"); exit(1) }
guard env["GITHUB_ACTIONS"] == "true", env["RUNNER_ENVIRONMENT"] == "github-hosted", env["HOME"] == "/Users/runner", NSUserName() == "runner", env["MURAGE_B35_NATIVE_CONFIRM"] == "disposable-packaged-attention", CommandLine.arguments.count == 3, let endMilliseconds = Double(CommandLine.arguments[2]), endMilliseconds.isFinite, let pid = Int32(CommandLine.arguments[1]), pid > 0 else { refuse("CONSENT_HOST_GATE") }
guard let owner = NSRunningApplication(processIdentifier: pid), owner.bundleIdentifier == "com.apple.notificationcenterui", owner.bundleURL?.path == "/System/Library/CoreServices/NotificationCenter.app" else { refuse("CONSENT_OWNER_GATE") }
guard AXIsProcessTrusted() else { refuse("CONSENT_AX_UNTRUSTED") }
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 0.5)
let deadline = min(Date().addingTimeInterval(2), Date(timeIntervalSince1970:endMilliseconds/1000))
var visited = 0
func attribute(_ e: AXUIElement, _ name: String) throws -> CFTypeRef? {
 if Date() > deadline { throw NSError(domain:"CONSENT_DEADLINE",code:1) }
 var out: CFTypeRef?
 let result = AXUIElementCopyAttributeValue(e,name as CFString,&out)
 if result == .success { return out }
 if result == .attributeUnsupported || result == .noValue { return nil }
 throw NSError(domain:"CONSENT_AX_READ",code:Int(result.rawValue))
}
struct Row { let e: AXUIElement; let parent: Int; let role: String; let strings: [String] }
var rows:[Row] = []
func walk(_ e: AXUIElement,_ parent:Int,_ depth:Int) throws {
 visited += 1
 if visited > 4000 || depth > 64 { throw NSError(domain:"CONSENT_TREE_LIMIT",code:1) }
 let role = try attribute(e,kAXRoleAttribute) as? String ?? ""
 var strings:[String] = []
 for name in [kAXTitleAttribute,kAXDescriptionAttribute,kAXValueAttribute] { if let value = try attribute(e,name) as? String { strings.append(value) } }
 let index = rows.count; rows.append(Row(e:e,parent:parent,role:role,strings:strings))
 for child in try attribute(e,kAXChildrenAttribute) as? [AXUIElement] ?? [] { try walk(child,index,depth+1) }
}
func within(_ index:Int,_ ancestor:Int)->Bool { var at=index;while at>=0 { if at==ancestor{return true};at=rows[at].parent };return false }
do {
 try walk(app,-1,0)
 let title="“Murage” Notifications",body="Notifications may include alerts, sounds, and icon badges."
 let matches=rows.indices.filter { i in rows[i].role == kAXGroupRole && rows[i].strings.contains(title) && rows.indices.contains { j in within(j,i) && rows[j].role == kAXStaticTextRole && rows[j].strings.contains(body) } }
 guard matches.count == 1 else { refuse("CONSENT_NOTICE_NOT_UNIQUE") }
 let target=rows[matches[0]].e
 guard let rawPosition=try attribute(target,kAXPositionAttribute), let rawSize=try attribute(target,kAXSizeAttribute), CFGetTypeID(rawPosition)==AXValueGetTypeID(), CFGetTypeID(rawSize)==AXValueGetTypeID() else { refuse("CONSENT_BOUNDS_MISSING") }
 var position=CGPoint.zero,size=CGSize.zero
 guard AXValueGetValue(unsafeBitCast(rawPosition,to:AXValue.self),.cgPoint,&position), AXValueGetValue(unsafeBitCast(rawSize,to:AXValue.self),.cgSize,&size),position.x.isFinite,position.y.isFinite,size.width.isFinite,size.height.isFinite,size.width>0,size.height>0 else { refuse("CONSENT_BOUNDS_INVALID") }
 let point=CGPoint(x:position.x+size.width/2,y:position.y+size.height/2)
 // AX global coordinates and CG mouse coordinates both use top-left origin.
 guard let event=CGEvent(mouseEventSource:nil,mouseType:.mouseMoved,mouseCursorPosition:point,mouseButton:.left) else { refuse("CONSENT_HOVER_UNAVAILABLE") }
 guard Date() < deadline else { refuse("CONSENT_DEADLINE") }
 event.post(tap:.cghidEventTap)
 let result:[String:Any]=["ok":true,"action":"hover-only","pid":pid,"visited":visited,"bounds":["x":position.x,"y":position.y,"width":size.width,"height":size.height]]
 print(String(data:try JSONSerialization.data(withJSONObject:result),encoding:.utf8)!)
} catch { refuse("CONSENT_READ_UNAVAILABLE") }
