// DRV: stdio client -> bounded HTTP response, with real durable owner cards.
// Virtual time exercises 90-second answers without wall-clock sleeps or a live app.
// C2 integration gate: both browser routes must retain { error, code } for
// executor refusals and uncertain outcomes. index.ts currently drops the code
// in its final catch; this fixture supplies the required server envelope.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { BROWSER_EXTENSION_CALL_TIMEOUT_MS, HUMAN_DECISION_MS } from "../../shared/browser-extension-protocol.ts";
import { BrowserExtensionApprovals, type ApprovalBinding } from "../browser-extension-approvals.ts";
import { WAITING_TEXT } from "../browser-extension-service.ts";
import type { ApprovalBus } from "../peer-approval.ts";
import type { Message } from "../store.ts";
import { runBrowserExtensionMcp } from "./browser-extension-mcp.ts";

const config = { endpoint: "http://127.0.0.1:12345/api/browser-extension/mcp", clientId: "fixture_client", token: "a".repeat(43) };
const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const close of cleanup.splice(0)) close(); });

function bridge(response: (signal: AbortSignal) => Promise<Response>, method = "tools/call") {
  let stdout = "";
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const done = runBrowserExtensionMcp({
    config,
    input: Readable.from([JSON.stringify({ id: 1, method, ...(method === "tools/call" ? { params: { name: "agent_browser_click", arguments: { selector: "#next" } } } : {}) }) + "\n"]),
    output: new Writable({ write(chunk, _encoding, callback) { stdout += chunk; callback(); } }),
    fetch: async (_url, init) => {
      const signal = init!.signal!;
      const result = response(signal);
      ready();
      return new Promise<Response>((resolve, reject) => {
        const aborted = () => reject(signal.reason);
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
        void result.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
      });
    },
  });
  return { started, done, reply: () => JSON.parse(stdout) };
}

function clock() {
  vi.useFakeTimers();
  // Node's native AbortSignal timer is not controlled by Vitest's clock.
  return vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("fixture deadline")), ms);
    return controller.signal;
  });
}

function cards() {
  const dir = mkdtempSync(join(tmpdir(), "drv-owner-cards-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "approvals.json");
  const messages: Message[] = [];
  const store = {
    messagesFor: () => messages,
    appendMessage: (_thread: string, input: Partial<Message>) => { const message = { ...input, id: String(messages.length + 1) } as Message; messages.push(message); return message; },
    patchMessage: (_thread: string, id: string, patch: Partial<Message>) => { const message = messages.find(item => item.id === id)!; Object.assign(message, patch); return message; },
  };
  const bus = { store, broadcast() {}, onApproval() {} } as unknown as ApprovalBus;
  const make = () => new BrowserExtensionApprovals(bus, { file, valid: () => true });
  const approvals = make();
  const binding: ApprovalBinding = { generation: 1, documentEpoch: "1:1:https://fixture.test", targetDigest: "1".repeat(64), submissionDigest: "2".repeat(64), payloadDigest: "3".repeat(64), actionDigest: "4".repeat(64) };
  const ask = () => approvals.ask({ bot: { id: "bot", name: "Mira", color: "blue" }, threadId: "thread", bindingId: "binding", generation: 1, digest: "a".repeat(64), summary: "Click Next", waitMs: HUMAN_DECISION_MS, binding, kind: "action" });
  return { approvals, make, file, messages, ask, binding };
}

it("an owner answer at 90 seconds completes on the original call", async () => {
  const timeout = clock();
  const f = cards();
  const client = bridge(async () => {
    const answer = await f.ask();
    return Response.json({ content: [{ type: "text", text: answer === "allow" ? "Action completed" : "Action withheld" }] });
  });
  await client.started;
  await vi.advanceTimersByTimeAsync(90_000);
  expect(f.approvals.resolve("thread", f.messages[0].card!.requestId!, "allow")).toBe(true);
  await client.done;
  expect(client.reply().result).toEqual({ content: [{ type: "text", text: "Action completed" }] });
  // A call can ask for site access and then for its action, before execution.
  expect(BROWSER_EXTENSION_CALL_TIMEOUT_MS).toBe(HUMAN_DECISION_MS * 2 + 60_000);
  expect(timeout).toHaveBeenCalledWith(BROWSER_EXTENSION_CALL_TIMEOUT_MS);
});

it("an unanswered card returns WAITING and remains answerable after a restart", async () => {
  clock();
  const f = cards();
  const client = bridge(async () => {
    const answer = await f.ask();
    expect(answer).toBe("waiting");
    return Response.json({ error: WAITING_TEXT, code: "browser_extension_refused" }, { status: 409 });
  });
  await client.started;
  await vi.advanceTimersByTimeAsync(HUMAN_DECISION_MS);
  await client.done;
  expect(client.reply().result).toMatchObject({ isError: true, code: "browser_extension_refused", content: [{ type: "text", text: WAITING_TEXT }] });
  expect(JSON.parse(readFileSync(f.file, "utf8")).records).toHaveLength(1);
  expect(f.messages[0].card!.answered).toBeUndefined();
  const restarted = f.make();
  expect(restarted.resolve("thread", f.messages[0].card!.requestId!, "allow")).toBe(true);
  expect(restarted.consume({ bindingId: "binding", kind: "action", binding: f.binding })).toBe(true);
  expect(restarted.consume({ bindingId: "binding", kind: "action", binding: f.binding })).toBe(false);
});

it("the execution window ends once and a late response cannot replay the call", async () => {
  clock();
  let attempts = 0;
  const client = bridge(async () => {
    attempts++;
    await new Promise(resolve => setTimeout(resolve, BROWSER_EXTENSION_CALL_TIMEOUT_MS + 1));
    return Response.json({ content: [{ type: "text", text: "Late action result" }] });
  });
  await client.started;
  await vi.advanceTimersByTimeAsync(BROWSER_EXTENSION_CALL_TIMEOUT_MS);
  await client.done;
  expect(client.reply().result.isError).toBe(true);
  expect(JSON.stringify(client.reply())).not.toContain("Late action result");
  await vi.advanceTimersByTimeAsync(1);
  expect(attempts).toBe(1);
  expect(client.reply().result.isError).toBe(true);
});

it.each(["browser_extension_refused", "browser_extension_stale_document", "browser_extension_uncertain", "uncertain"])("preserves %s for the client", async code => {
  const client = bridge(async () => Response.json({ error: "The owner needs to check this step.", code }, { status: 409 }));
  await client.done;
  expect(client.reply().result).toMatchObject({ isError: true, code });
  expect(client.reply().result.content[0].text).toMatch(/owner/i);
});

it("a refused listing retains its code as JSON-RPC error data", async () => {
  const client = bridge(async () => Response.json({ error: "Browser control is paused.", code: "browser_extension_binding_inactive" }, { status: 409 }), "tools/list");
  await client.done;
  expect(client.reply().error).toEqual({ code: -32000, message: "Browser control is paused.", data: { code: "browser_extension_binding_inactive" } });
  expect(client.reply().result).toBeUndefined();
});

it.each([
  { error: "private-page-value", code: "untrusted" },
  { error: "private-page-value" },
  { error: "private-page-value".repeat(500), code: "browser_extension_refused" },
])("unrecognised or oversized failures stay private", async body => {
  const client = bridge(async () => Response.json(body, { status: 500 }));
  await client.done;
  expect(client.reply().result.isError).toBe(true);
  expect(JSON.stringify(client.reply())).not.toContain("private-page-value");
});

it("uncertain outcomes never echo raw backend details", async () => {
  const client = bridge(async () => Response.json({ error: "private-page-value", code: "uncertain" }, { status: 409 }));
  await client.done;
  expect(client.reply().result.code).toBe("uncertain");
  expect(JSON.stringify(client.reply())).not.toContain("private-page-value");
});
