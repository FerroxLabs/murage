import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { startImageMcpCall } from "./image-mcp-call.ts";

function transport() {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: vi.fn() });
  const requests: any[] = [];
  stdin.on("data", chunk => requests.push(JSON.parse(String(chunk))));
  return { child: child as unknown as ChildProcessWithoutNullStreams, requests,
    reply: (value: unknown) => stdout.write(JSON.stringify(value) + "\n") };
}
afterEach(() => { vi.useRealTimers(); });

it("starts the card wait only after delayed MCP initialization within the unchanged RPC budget", async () => {
  vi.useFakeTimers();
  const wire = transport();
  let cardWaitStarted = false;
  const starting = startImageMcpCall(wire.child, "generate_image", { request_id: "fixture" });
  void starting.then(() => { cardWaitStarted = true; });
  // Explicitly hold the response past the card budget, without sleeping.
  await vi.advanceTimersByTimeAsync(5_001);
  expect(cardWaitStarted).toBe(false);
  expect(wire.requests.map(r => r.method)).toEqual(["initialize"]);
  wire.reply({ jsonrpc: "2.0", id: 41, result: { protocolVersion: "2024-11-05" } });
  const { result } = await starting;
  expect(cardWaitStarted).toBe(true);
  expect(wire.requests.map(r => r.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
  expect(wire.requests[2].params).toEqual({ name: "generate_image", arguments: { request_id: "fixture" } });
  wire.reply({ jsonrpc: "2.0", id: 42, result: { content: [{ text: "fixture result" }] } });
  await expect(result).resolves.toEqual({ content: [{ text: "fixture result" }] });
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps initialization and the call inside one 15 second guard", async () => {
  vi.useFakeTimers();
  const wire = transport();
  const starting = startImageMcpCall(wire.child, "generate_image", {});
  await vi.advanceTimersByTimeAsync(5_001);
  wire.reply({ id: 41, result: {} });
  const { result } = await starting;
  const failure = expect(result).rejects.toThrow("Image MCP timed out");
  await vi.advanceTimersByTimeAsync(9_999);
  await failure;
  expect(wire.child.kill).toHaveBeenCalledOnce();
});

it.each(["error", "close", "refused"])("rejects startup on %s and clears the guard", async fault => {
  vi.useFakeTimers();
  const wire = transport();
  const starting = startImageMcpCall(wire.child, "generate_image", {});
  const failure = expect(starting).rejects.toThrow();
  if (fault === "refused") wire.reply({ id: 41, error: { code: -1 } });
  else wire.child.emit(fault, new Error("fixture failure"));
  await failure;
  expect(vi.getTimerCount()).toBe(0);
});
