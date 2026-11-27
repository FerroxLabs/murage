// W-L3 (DESIGN 1022-cua-windows R13c / R17f / R20): main.mjs is the one place that connects the Windows computer-use runtime to
// the server process and to the quit/update path. A parse check of main.mjs: every server process it starts is wired to the
// host-desktop lock state, the three harness messages reach the runtime, and the win32 quit stage is the runtime's one barrier.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { stuckMessage, integrityMessage, hostDesktopReadyMessage } from "../shared/cua-host-messages.mjs";

const { routeHarnessMessage } = createRequire(import.meta.url)("./cua-windows-runtime.cjs");

const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
const lines = source.split("\n");
const at = (pattern, from = 0) => lines.findIndex((line, index) => index >= from && pattern.test(line));

describe("W-L3 main.mjs wiring of the Windows computer-use runtime", () => {
  it("imports the runtime's wireHostDesktop, cuaCleanupStage and cuaStopStageMs", () => {
    expect(source).toMatch(/const \{[^}]*\bcuaCleanupStage\b[^}]*\bcuaStopStageMs\b[^}]*\bwireHostDesktop\b[^}]*\} = require\("\.\/cua-windows-runtime\.cjs"\)/);
  });

  it("wires every server process it starts (the one startServerOn caller) to the host-desktop lock on win32", () => {
    const callers = lines.filter(line => /await startServerOn\(/.test(line));
    expect(callers.length).toBe(1);
    const started = at(/await startServerOn\(/);
    const win32 = at(/process\.platform === "win32"/, started);
    const wire = at(/wireHostDesktop\(\{ lock: hostDesktopLock, port: started\.proc \}\)/, started);
    expect(win32, "win32 block after the start").toBeGreaterThan(started);
    expect(wire, "wireHostDesktop with the new process").toBeGreaterThan(win32);
    expect(wire - started).toBeLessThan(12);
    expect(lines.slice(started, wire).join("\n")).toMatch(/hostDesktopWire\?\.dispose\(\)/);
  });

  it("main's server-process message handler hands every message to the runtime's routeHarnessMessage with the runtime handler as its delivery", () => {
    const message = at(/proc\.on\("message"/);
    expect(message).toBeGreaterThan(0);
    const block = lines.slice(message, message + 14).join("\n");
    expect(block).toMatch(/if \(routeHarnessMessage\(message, \{ isCurrent: proc === serverProc, wire: hostDesktopWire, deliver: \(routed\) => onCuaHarnessMessage\(routed, proc\) \}\)\) return;/);
  });

  // the routing itself, driven through the runtime's real function with the real message builders
  describe("routeHarnessMessage: what reaches the runtime", () => {
    const run = (message, isCurrent = true) => {
      const wire = { onReady: vi.fn() }; const deliver = vi.fn();
      const handled = routeHarnessMessage(message, { isCurrent, wire, deliver });
      return { handled, wire, deliver };
    };
    const G = "0123456789ab";
    it("cua-stuck and cua-integrity are delivered once and never touch the desktop wire", () => {
      for (const message of [stuckMessage(G), integrityMessage(G)]) {
        const { handled, wire, deliver } = run(message);
        expect(handled, message.type).toBe(true);
        expect(deliver, message.type).toHaveBeenCalledTimes(1);
        expect(deliver.mock.calls[0][0], message.type).toEqual(message);
        expect(wire.onReady, message.type).not.toHaveBeenCalled();
      }
    });
    it("host-desktop-ready from the current server re-sends the desktop state and is delivered once", () => {
      const { handled, wire, deliver } = run(hostDesktopReadyMessage());
      expect(handled).toBe(true);
      expect(wire.onReady).toHaveBeenCalledTimes(1);
      expect(deliver).toHaveBeenCalledTimes(1);
    });
    it("host-desktop-ready from an older server process is delivered but never re-sends the desktop state", () => {
      const { handled, wire, deliver } = run(hostDesktopReadyMessage(), false);
      expect(handled).toBe(true);
      expect(wire.onReady).not.toHaveBeenCalled();
      expect(deliver).toHaveBeenCalledTimes(1);
    });
    it("any other message is not handled and reaches nothing", () => {
      for (const message of [{ type: "murage:sentinel-io-ack" }, { type: "startup-stage", stage: "ready" }, null, undefined, "x"]) {
        const { handled, wire, deliver } = run(message);
        expect(handled, String(message?.type ?? message)).toBe(false);
        expect(deliver).not.toHaveBeenCalled();
        expect(wire.onReady).not.toHaveBeenCalled();
      }
    });
  });

  it("the win32 quit/update stage is cuaCleanupStage with the runtime's stage bound, never the 2.5 s generic await", () => {
    const stage = at(/cuaCleanupStage\(\{ stop: stopCua, ms: cuaStopStageMs\("win32"\) \}\)/);
    expect(stage).toBeGreaterThan(0);
    const guard = at(/process\.platform === "win32"/, stage - 4);
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(stage);
    expect(lines.slice(stage, stage + 4).join("\n")).toMatch(/else \{[\s\S]*CUA_STOP_TIMEOUT_MS/);
  });
});
