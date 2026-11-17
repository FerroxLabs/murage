// Runs inside fake-pi, never in a newly spawned callback child.
import { writeFileSync } from "node:fs";
import gate from "../drivers/pi-permission-gate.ts";
import { r3Record, r3Root } from "./r3-engine-barrier.ts";
export function r3PiCallback(): void {
  const handlers = new Map<string, Function>();
  const status = process.env.MURAGE_PI_GATE_STATUS_FILE;
  gate({ on(name: string, handler: Function) { handlers.set(name, handler); } } as never);
  const event = { toolName: "find", toolCallId: "r3-filter", input: { path: process.cwd() },
    content: [{ type: "text", text: process.env.FAKE_R3_FILTER === "passthrough" ? "ordinary.txt" : "ordinary.txt\n.env" }] };
  r3Record("filter-enter", { status });
  let result: unknown;
  try { result = handlers.get("tool_result")!(event, { cwd: process.cwd() }); }
  catch { result = event; } // Match Pi's exception behavior.
  writeFileSync(`${r3Root}.accepted`, JSON.stringify(result ?? event));
  r3Record("filter-return");
}
