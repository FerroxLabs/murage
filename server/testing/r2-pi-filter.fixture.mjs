// Isolated child only. Never import this fixture into the test runner.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import gate, { DEFAULT_HOOKS } from "../drivers/pi-permission-gate.ts";

const [root, outcome, mode = "bound", status = join(root, "status")] = process.argv.slice(2);
process.env.MURAGE_PI_GATE = "r2-fixture";
process.env.MURAGE_PI_GATE_MODE = mode;
process.env.MURAGE_PI_GATE_STATUS_FILE = status;
const handlers = new Map();
if (outcome === "reload") {
  process.env.MURAGE_PI_GATE_MODE_FILE = join(root, "mode.env");
  writeFileSync(process.env.MURAGE_PI_GATE_MODE_FILE, "MODE=open\n");
}
let checking = true;
const hooks = {
  ...DEFAULT_HOOKS,
  line(...args) {
    if (outcome === "untrusted") return "keep";
    if (checking) return DEFAULT_HOOKS.line(...args);
    if (outcome === "throw") throw new Error("private-path-sentinel");
    if (outcome === "count") return "unparsable";
    return DEFAULT_HOOKS.line(...args);
  },
};
gate({ on(name, handler) { handlers.set(name, handler); } }, { hooks });
if (outcome === "reload") {
  writeFileSync(join(root, "mode.env"), "MODE=bound\n");
  gate({ on(name, handler) { handlers.set(name, handler); } }, { hooks });
}
checking = false;
const event = {
  toolName: "find", toolCallId: "r2-result", input: { path: root },
  content: outcome === "malformed" ? [{ type: "image", data: "private-path-sentinel" }]
    : [{ type: "text", text: outcome === "passthrough" ? "ordinary.txt" : "ordinary.txt\n.env" }],
};
// Pi catches an ordinary handler exception and keeps the native result.
let result;
try { result = handlers.get("tool_result")(event, { cwd: root }); }
catch { result = event; }
writeFileSync(join(root, "accepted.json"), JSON.stringify(result ?? event));
