import { describe, expect, it } from "vitest";
import { ClaudeStdinGate, type StdinFrame } from "./cli-stdin.ts";
import { awaitClaudeS2Barrier } from "./claude-s2-barrier.ts";

const user = (text: string): StdinFrame => ({ wire: JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n" });
const control = (id: string, subtype: string): StdinFrame => ({ wire: JSON.stringify({ type: "control_request", request_id: id, request: { subtype } }) + "\n" });
const success = { subtype: "success" };
const connected = { subtype: "success", response: { mcpServers: [{ name: "a", status: "connected" }, { name: "b", status: "connected" }] } };

describe("S2 input/barrier components (not driver integration evidence)", () => {
  it("T-S2-COLD-FIRST: cold first prompt is writable", () => {
    const gate = new ClaudeStdinGate();
    expect(gate.barrier).toBe("passed");
    expect(gate.route(user("prompt"))).toBe("write");
  });
  it("T-S2-STEER-MID-BARRIER: hold and passed-before-prompt window preserve order", async () => {
    const gate = new ClaudeStdinGate(); gate.open();
    const bytes: string[] = [];
    const sink = (frame: StdinFrame) => { bytes.push(frame.wire); };
    const send = (frame: StdinFrame) => { if (gate.route(frame) === "write") sink(frame); };
    let answer!: (value: typeof success) => void;
    let live: object | null = null; let started = 0;
    const barrier = awaitClaudeS2Barrier(gate, ["a"], async (_id, request) => request.subtype === "mcp_status"
      ? connected : new Promise(resolve => { answer = resolve; }), 1000);
    send(user("steer")); send(user("queued flush"));
    expect(bytes).toEqual([]); expect(live).toBeNull(); expect(started).toBe(0);
    answer(success);
    expect(await barrier).toBe(true);
    gate.release(user("prompt"), () => {
      live = {}; started++;
      expect(gate.barrier).toBe("passed");
      send(user("turn.started listener steer"));
    }, sink);
    expect(bytes).toEqual(["prompt", "steer", "queued flush", "turn.started listener steer"].map(text => user(text).wire));
    expect(started).toBe(1);
  });
  it("CL7a (N4): a refused prompt write hands every queued frame the prompt's error and writes 0 bytes after it", () => {
    const gate = new ClaudeStdinGate(); gate.open();
    const refused = new Error("memory-refused: ledger revoked");
    const done: Array<Error | null | undefined> = [];
    const queued = (text: string): StdinFrame => ({ ...user(text), done: error => { done.push(error); } });
    expect(gate.route(queued("steer one"))).toBe("held");
    expect(gate.route(queued("steer two"))).toBe("held");
    const bytes: string[] = [];
    expect(() => gate.release(user("prompt"), () => {}, frame => {
      if (frame.wire === user("prompt").wire) throw refused;
      bytes.push(frame.wire);
    })).toThrow(refused);
    expect(bytes).toEqual([]);
    expect(done).toEqual([refused, refused]);
    expect(gate.takeForCold()).toEqual([]);
  });
  it.each(["elicitation", "permission", "unknown"])("T-S2-ELICIT-MID-BARRIER: %s request fails without a response", async () => {
    const gate = new ClaudeStdinGate(); gate.open();
    const barrier = awaitClaudeS2Barrier(gate, ["a"], async () => new Promise(() => {}), 1000);
    expect(gate.route(user("steer"))).toBe("held");
    expect(gate.incomingRequest()).toBe(true);
    // Exercise the primitive policy independently of the incoming-request guard:
    // a typed-answer route cannot write even if an old callback survives.
    expect(gate.route({ wire: JSON.stringify({ type: "control_response", response: { answer: "secret" } }) })).toBe("blocked");
    expect(await barrier).toBe(false);
    expect(gate.takeForCold()).toEqual([user("steer")]);
    expect(gate.takeForCold()).toEqual([]);
  });
  it("T-S2-ALLOWLIST: only owned matching one-use request ids write", () => {
    const gate = new ClaudeStdinGate(); gate.open();
    gate.own("ours", "mcp_status");
    expect(gate.route(control("ours", "mcp_status"))).toBe("write");
    expect(gate.route(control("ours", "mcp_status"))).toBe("blocked");
    const other = new ClaudeStdinGate(); other.open();
    expect(other.route(control("foreign", "mcp_reconnect"))).toBe("blocked");
  });
  it("T-S2-BARRIER: all reconnect outcomes precede connected status", async () => {
    const gate = new ClaudeStdinGate(); gate.open();
    const calls: string[] = [];
    expect(await awaitClaudeS2Barrier(gate, ["a", "b"], async (id, request) => {
      expect(gate.route(control(id, request.subtype))).toBe("write");
      calls.push(request.serverName ?? request.subtype);
      return request.subtype === "mcp_status" ? connected : success;
    }, 1000)).toBe(true);
    expect(calls).toEqual(["a", "b", "mcp_status"]);
    expect(gate.barrier).toBe("open"); // release owns the turn-start transition
  });
  it.each(["error", "null", "timeout", "unsupported", "disconnected", "throw"])("T-S2-BARRIER: %s requires cold", async kind => {
    const gate = new ClaudeStdinGate(); gate.open();
    const result = await awaitClaudeS2Barrier(gate, ["a", "b"], async (_id, request) => {
      if (kind === "throw") throw new Error("transport failed");
      if (kind === "timeout") return new Promise(() => {});
      if (request.subtype === "mcp_reconnect") return kind === "error" ? { subtype: "error" } : kind === "null" ? null : success;
      return kind === "unsupported" ? { subtype: "error" } : { subtype: "success", response: { mcpServers: [{ name: "a", status: "connected" }, { name: "b", status: "failed" }] } };
    }, 10);
    expect(result).toBe(false);
    expect(gate.failure).not.toBeNull();
    expect(gate.barrier).toBe("open");
  });
  it("T-S2-UNSUPPORTED: known unsupported build does not reconnect", async () => {
    const gate = new ClaudeStdinGate(); gate.open();
    let called = false;
    expect(await awaitClaudeS2Barrier(gate, ["a"], async () => { called = true; return success; }, 100, false)).toBe(false);
    expect(called).toBe(false);
  });
});
