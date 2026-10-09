// server/voice/stream-route.test.ts
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { fatal, parseServerMessage, SUBPROTOCOL, type ServerMessage } from "../../shared/flux-stream-contract.ts";
import { scriptedProvider } from "../../tools/flux-stream-sim/providers/scripted.ts";
import { createSimServer } from "../../tools/flux-stream-sim/server.ts";
import { FluxStreamRefused, openFluxStream } from "./flux-stream.ts";
import {
  STREAM_WS_PATH,
  openStreamCount,
  upgradeAdmitted,
  upgradePrincipalFor,
  closeAllStreams,
  createStreamBudget,
  createTicketStore,
  handleStreamTicketRoute,
  handleStreamUpgrade,
  streamFlagOn,
  trimCloseReason,
  type StreamRouteDeps,
} from "./stream-route.ts";

let sim: Awaited<ReturnType<typeof createSimServer>>;
let harness: Server;
let port = 0;
let deps: StreamRouteDeps;
let principal = "desktop";
const logs: string[] = [];

beforeEach(async () => {
  sim = await createSimServer({ port: 0, provider: scriptedProvider(), allowFaults: true });
  logs.length = 0;
  principal = "desktop";
  deps = {
    enabled: () => true,
    busy: () => false,
    fluxKey: () => "sim_key",
    ticketPrincipal: () => principal,
    upgradePrincipal: () => principal,
    tickets: createTicketStore(),
    budget: createStreamBudget(),
    env: { MURAGE_FLUX_STREAM_API: sim.baseUrl } as NodeJS.ProcessEnv,
    log: (line) => logs.push(line),
  };
  harness = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (await handleStreamTicketRoute(req.method ?? "GET", url, req, res, deps)) return;
    res.writeHead(404).end();
  });
  harness.on("upgrade", (req, socket, head) => {
    if (!handleStreamUpgrade(req, socket, head, deps)) socket.destroy();
  });
  await new Promise<void>((r) => harness.listen(0, "127.0.0.1", () => r()));
  port = (harness.address() as AddressInfo).port;
});
afterEach(async () => {
  await closeAllStreams();
  await new Promise<void>((r) => harness.close(() => r()));
  await sim.close();
});

async function ticket() {
  const res = await fetch(`http://127.0.0.1:${port}/api/voice/stream/ticket`, { method: "POST" });
  return { status: res.status, body: (await res.json()) as { ticket?: string; reason?: string } };
}

function page(query: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${STREAM_WS_PATH}?${query}`, [SUBPROTOCOL]);
  const messages: ServerMessage[] = [];
  ws.on("message", (d, binary) => {
    if (!binary) {
      const m = parseServerMessage(String(d));
      if (m) messages.push(m);
    }
  });
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  const opened = new Promise<void>((r) => ws.once("open", () => r()));
  return { ws, messages, closed, opened };
}

const tone = () => {
  const b = Buffer.alloc(2048);
  for (let s = 0; s < 1024; s += 1) b.writeInt16LE(Math.round(Math.sin(s / 3) * 9000), s * 2);
  return b;
};

describe("ticket", () => {
  it("mints a single-use ticket bound to its principal", async () => {
    const { status, body } = await ticket();
    expect(status).toBe(200);
    expect(body.ticket).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(deps.tickets.redeem(body.ticket!, "companion:d1:s1")).toBe(false); // wrong principal, and now spent
    const again = await ticket();
    expect(deps.tickets.redeem(again.body.ticket!, "desktop")).toBe(true);
    expect(deps.tickets.redeem(again.body.ticket!, "desktop")).toBe(false);
  });

  it("refuses an unproven door with 403", async () => {
    principal = null as unknown as string;
    deps.ticketPrincipal = () => null;
    expect((await ticket()).status).toBe(403);
  });

  it.each([
    ["no Flux key", () => (deps.fluxKey = () => null), "key"],
    ["streaming off", () => (deps.enabled = () => false), "unavailable"],
    ["credentials changing", () => (deps.busy = () => true), "busy"],
  ])("refuses with 409 when %s", async (_why, arrange, reason) => {
    arrange();
    const { status, body } = await ticket();
    expect(status).toBe(409);
    expect(body.reason).toBe(reason);
  });
});

describe("relay", () => {
  it("delivers frames sent before Flux is open, and never shows the key", async () => {
    const slow: typeof openFluxStream = async (opts) => {
      await new Promise((r) => setTimeout(r, 400)); // a slow Flux handshake
      return openFluxStream(opts);
    };
    deps.open = slow;
    const { body } = await ticket();
    const p = page(`ticket=${body.ticket}&eagerness=low&sim_script=hello%20there`);
    await p.opened;
    for (let i = 0; i < 30; i += 1) {
      p.ws.send(i < 12 ? tone() : Buffer.alloc(2048)); // starts at once, while Flux is still connecting
      await new Promise((r) => setTimeout(r, 64));
    }
    p.ws.send(JSON.stringify({ type: "turn.commit" }));
    await new Promise((r) => setTimeout(r, 300));
    p.ws.send(JSON.stringify({ type: "session.close" }));
    expect(await p.closed).toBe(1000);
    expect(p.messages[0].type).toBe("session.started");
    const end = p.messages.find((m) => m.type === "turn.end") as { audio_start_ms: number } | undefined;
    expect(end).toBeTruthy();
    expect(end!.audio_start_ms).toBeLessThan(100); // the first frames reached Flux: the clock is not shifted
    expect(JSON.stringify(p.messages)).not.toContain("sim_key");
    expect(logs.join("\n")).not.toContain("sim_key");
    expect(logs.join("\n")).not.toContain("hello");
  });

  it("closes 4401 on a bad ticket or a ticket for another principal, with an error first", async () => {
    const bad = page("ticket=nope");
    expect(await bad.closed).toBe(4401);
    expect(bad.messages[0]).toMatchObject({ type: "error", error: { code: "unauthorized" } });
    principal = "companion:d1:s1";
    const { body } = await ticket();
    principal = "companion:d1:s2";
    const other = page(`ticket=${body.ticket}`);
    expect(await other.closed).toBe(4401);
  });

  it("aborts the Flux handshake when the page leaves first", async () => {
    let aborted = false;
    deps.open = async (opts) => {
      await new Promise((r) => setTimeout(r, 300));
      aborted = Boolean(opts.signal?.aborted);
      return openFluxStream(opts);
    };
    const { body } = await ticket();
    const p = page(`ticket=${body.ticket}`);
    await p.opened;
    p.ws.terminate();
    await new Promise((r) => setTimeout(r, 800));
    expect(aborted).toBe(true);
    expect(sim.openSessions()).toEqual([]);
  });

  it("passes a Flux refusal through with the same code", async () => {
    deps.fluxKey = () => "sim_free";
    const { body } = await ticket();
    const p = page(`ticket=${body.ticket}`);
    expect(await p.closed).toBe(4402);
    expect(p.messages[0]).toMatchObject({ type: "error", error: { code: "premium_locked" } });
  });

  it("decides a handshake failure on closeCode, never on error.close_code", async () => {
    // a non-503 handshake failure: closeCode is 4000 plus the status, error.close_code is 4502
    deps.open = async () => {
      throw new FluxStreamRefused(4401, fatal("capability_unavailable", "Flux answered 401"), "http 401");
    };
    const a = page(`ticket=${(await ticket()).body.ticket}`);
    expect(await a.closed).toBe(4401);
    expect(a.messages[0]).toMatchObject({ type: "error", error: { code: "unauthorized" } });
    deps.open = async () => {
      throw new FluxStreamRefused(4500, fatal("capability_unavailable", "Flux answered 500"), "http 500");
    };
    const b = page(`ticket=${(await ticket()).body.ticket}`);
    expect(await b.closed).toBe(4502);
  });

  it("passes a Flux 503 handshake refusal through with its retry_after_ms", async () => {
    deps.open = async () => {
      throw new FluxStreamRefused(4503, fatal("service_unavailable", "Flux answered 503", { retry_after_ms: 1500 }), "http 503");
    };
    const p = page(`ticket=${(await ticket()).body.ticket}`);
    expect(await p.closed).toBe(4503);
    expect(p.messages[0]).toMatchObject({ type: "error", error: { code: "service_unavailable", retry_after_ms: 1500 } });
  });

  it("continues Flux's seq when the harness reports a dropped Flux connection", async () => {
    const { body } = await ticket();
    const p = page(`ticket=${body.ticket}&sim_fault=drop_after_ms%3D500`);
    expect(await p.closed).toBe(4502);
    const seqs = p.messages.map((m) => m.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(p.messages.at(-1)).toMatchObject({ type: "error", error: { code: "capability_unavailable" } });
  });

  it("drops page JSON outside the allowlist and refuses oversize page messages", async () => {
    const { body } = await ticket();
    const p = page(`ticket=${body.ticket}`);
    await p.opened;
    p.ws.send(JSON.stringify({ type: "session.update", config: { sample_rate: 8000, model: "x", eagerness: "high" } }));
    await new Promise((r) => setTimeout(r, 300));
    expect(p.messages.find((m) => m.type === "session.updated")).toMatchObject({ config: { eagerness: "high", sample_rate: 16000 } });
    p.ws.send(Buffer.alloc(70 * 1024));
    expect(await p.closed).toBe(1009);
  });

  it("closes open streams with 1001 and session.closed going_away when credentials change", async () => {
    const { body } = await ticket();
    const p = page(`ticket=${body.ticket}`);
    await new Promise((r) => setTimeout(r, 300));
    expect(await closeAllStreams()).toBe(1);
    expect(await p.closed).toBe(1001);
    expect(p.messages.at(-1)).toMatchObject({ type: "session.closed", reason: "going_away" });
  });

  it("closes a stream still connecting to Flux when credentials change", async () => {
    deps.open = async (opts) => {
      await new Promise((r) => setTimeout(r, 400));
      return openFluxStream(opts);
    };
    const { body } = await ticket();
    const p = page(`ticket=${body.ticket}`);
    await p.opened;
    expect(await closeAllStreams()).toBe(1); // registered before the Flux handshake
    expect(await p.closed).toBe(1001);
    await new Promise((r) => setTimeout(r, 600));
    expect(sim.openSessions()).toEqual([]);
  });

  it("refuses a ticket minted before streaming was switched off", async () => {
    const { body } = await ticket();
    deps.enabled = () => false;
    const p = page(`ticket=${body.ticket}`);
    expect(await p.closed).toBe(4503);
  });

  it("keeps a commit sent while Flux connects between the audio around it", async () => {
    deps.open = async (opts) => {
      await new Promise((r) => setTimeout(r, 300));
      return openFluxStream(opts);
    };
    const { body } = await ticket();
    const p = page(`ticket=${body.ticket}&eagerness=low&sim_script=first|second`);
    await p.opened;
    for (let i = 0; i < 11; i += 1) p.ws.send(tone()); // audio A
    p.ws.send(JSON.stringify({ type: "turn.commit" }));
    for (let i = 0; i < 11; i += 1) p.ws.send(tone()); // audio B
    await new Promise((r) => setTimeout(r, 1500));
    expect(p.messages.find((m) => m.type === "turn.end")).toMatchObject({ turn: 0, text: "first", reason: "forced" });
    p.ws.close();
  });

  it("force-closes a Flux that ignores session.close at the deadline: session.closed going_away, then 1001", async () => {
    let fluxClosed = false;
    const never = new Promise<never>(() => undefined);
    deps.restartDeadlineMs = 150;
    deps.open = async () => ({
      send: () => undefined,
      sendJson: () => undefined, // ignores session.close
      bufferedAmount: () => 0,
      onMessage: () => () => undefined,
      closed: never,
      close: () => {
        fluxClosed = true;
      },
    });
    const p = page(`ticket=${(await ticket()).body.ticket}`);
    await p.opened;
    await new Promise((r) => setTimeout(r, 200));
    expect(openStreamCount()).toBe(1);
    const started = Date.now();
    expect(await closeAllStreams()).toBe(1);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(await p.closed).toBe(1001);
    expect(fluxClosed).toBe(true);
    expect(p.messages.at(-1)).toMatchObject({ type: "session.closed", reason: "going_away" });
  });

  it("refuses a ticket redeemed after the harness started stopping", async () => {
    const { body } = await ticket();
    let stopping = false;
    deps.busy = () => stopping;
    stopping = true;
    const p = page(`ticket=${body.ticket}`);
    expect(await p.closed).toBe(4503);
    expect((await ticket()).status).toBe(409);
  });

  it("refuses the upgrade when admission fails (bad Host or Origin)", async () => {
    deps.admitUpgrade = () => false;
    const { body } = await ticket();
    const ws = new WebSocket(`ws://127.0.0.1:${port}${STREAM_WS_PATH}?ticket=${body.ticket}`, [SUBPROTOCOL]);
    ws.on("error", () => undefined);
    const code = await new Promise<number>((r) => ws.on("close", (c) => r(c)));
    expect(code).toBe(1006);
    expect(deps.tickets.redeem(body.ticket!, "desktop")).toBe(true); // never reached the ticket
  });

  it("refuses a refused-Flux page cleanly without hanging on its close frame", async () => {
    deps.open = async () => {
      throw new FluxStreamRefused(4500, fatal("capability_unavailable", "Flux answered 500"), "http 500");
    };
    deps.env = { ...deps.env, MURAGE_FLUX_TEST_FAULT: "x", MURAGE_FLUX_STREAM_API: "not a url" } as NodeJS.ProcessEnv;
    const p = page(`ticket=${(await ticket()).body.ticket}`);
    await p.opened;
    for (let i = 0; i < 120; i += 1) p.ws.send(Buffer.alloc(2048)); // over 3 s while it refuses
    const started = Date.now();
    expect(await p.closed).toBe(4502); // an unparsable base refuses this stream; the harness lives
    expect(Date.now() - started).toBeLessThan(15_000); // not hung on the close frame (PAGE_CLOSE_GRACE_MS is 1 s); wide for loaded CI
    expect(openStreamCount()).toBe(0);
    deps.env = { MURAGE_FLUX_STREAM_API: sim.baseUrl } as NodeJS.ProcessEnv;
    const again = await ticket();
    expect(again.status).toBe(200); // the slot was freed
  });

  it("allows one open stream per principal", async () => {
    const a = await ticket();
    const pa = page(`ticket=${a.body.ticket}`);
    await pa.opened;
    await new Promise((r) => setTimeout(r, 200));
    const b = await ticket();
    expect(b.status).toBe(429);
    pa.ws.close();
  });
});

describe("upgrade principal and admission", () => {
  const checks = { marked: (h: Record<string, unknown>) => h["x-murage-companion"] === "1", authorized: (h: Record<string, unknown>) => h["x-murage-launch"] === "ok" };
  it("maps an unmarked request to the desktop, a proven mark to its principal, an unproven mark to nobody", () => {
    expect(upgradePrincipalFor({}, checks)).toBe("desktop");
    expect(upgradePrincipalFor({ "x-murage-companion": "1", "x-murage-launch": "ok", "x-murage-stream-principal": "companion:d1:s1" }, checks)).toBe("companion:d1:s1");
    expect(upgradePrincipalFor({ "x-murage-companion": "1", "x-murage-stream-principal": "companion:d1:s1" }, checks)).toBeNull();
  });

  it("closes 4401 for a marked but unproven upgrade", async () => {
    deps.upgradePrincipal = (req) => upgradePrincipalFor(req.headers, checks);
    const ws = new WebSocket(`ws://127.0.0.1:${port}${STREAM_WS_PATH}?ticket=whatever`, [SUBPROTOCOL], { headers: { "x-murage-companion": "1" } });
    expect(await new Promise<number>((r) => ws.on("close", (c) => r(c)))).toBe(4401);
  });

  it("admits on loopback Host and an allowed or absent Origin only", () => {
    const rules = { host: (h?: string) => h === "127.0.0.1:1", origin: (o: string) => o === "http://127.0.0.1:1" };
    expect(upgradeAdmitted({ host: "127.0.0.1:1" }, rules)).toBe(true);
    expect(upgradeAdmitted({ host: "127.0.0.1:1", origin: "http://127.0.0.1:1" }, rules)).toBe(true);
    expect(upgradeAdmitted({ host: "evil.example" }, rules)).toBe(false);
    expect(upgradeAdmitted({ host: "127.0.0.1:1", origin: "https://evil.example" }, rules)).toBe(false);
  });
});

describe("budget", () => {
  it("leases a minute at a time and counts open leases", () => {
    let now = 0;
    const budget = createStreamBudget({ maxSecondsPerHour: 120, now: () => now });
    const slot = budget.begin("d1");
    expect("lease" in slot).toBe(true);
    if (!("lease" in slot)) return;
    expect(budget.probe("d2")).toEqual({ ok: true }); // 60 reserved + 60 fits, and the harness allows two
    now = 60_000;
    expect(slot.lease()).toBe(true);
    now = 120_000;
    expect(slot.lease()).toBe(false);
    expect(slot.done()).toBe(120);
    expect(budget.begin("d1")).toMatchObject({ ok: false, reason: "budget" });
  });

  it("tells a reservation-blocked caller to retry within a lease, not an hour", () => {
    const budget = createStreamBudget({ maxSecondsPerHour: 90 });
    expect("lease" in budget.begin("d1")).toBe(true);
    const verdict = budget.probe("d2");
    expect(verdict).toMatchObject({ ok: false, reason: "budget" });
    expect((verdict as { retryAfterMs: number }).retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("refuses a second stream whose lease would pass the hour's allowance", () => {
    const budget = createStreamBudget({ maxSecondsPerHour: 90 });
    expect("lease" in budget.begin("d1")).toBe(true);
    expect(budget.probe("d2")).toMatchObject({ ok: false, reason: "budget" }); // 60 open + 60 > 90
  });

  it("settles cumulatively, without per-lease rounding", () => {
    let now = 0;
    const budget = createStreamBudget({ now: () => now });
    const slot = budget.begin("d1");
    if (!("lease" in slot)) throw new Error("no slot");
    now = 60_050;
    slot.lease();
    now = 120_100;
    slot.lease();
    now = 125_100;
    expect(slot.done()).toBe(126); // not 61 + 61 + 5
  });

  it("gives an expiring stream one replacement slot", () => {
    const budget = createStreamBudget();
    const slot = budget.begin("d1");
    if (!("lease" in slot)) throw new Error("no slot");
    expect(budget.begin("d1", true)).toMatchObject({ ok: false, reason: "busy" });
    slot.expiring();
    expect("lease" in budget.begin("d1", true)).toBe(true);
    expect(budget.begin("d1", true)).toMatchObject({ ok: false });
  });
});

describe("trimCloseReason", () => {
  it("keeps a close reason within 123 UTF-8 bytes without splitting a character", () => {
    const long = "é".repeat(120); // 120 chars, 240 bytes
    const out = trimCloseReason(long);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(123);
    expect(out).toBe("é".repeat(61));
    const emoji = trimCloseReason("日本語🙂".repeat(30));
    expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(123);
    expect(emoji).not.toContain("\uFFFD");
    expect(trimCloseReason("short")).toBe("short");
  });
});

describe("live transcription flag", () => {
  it("is off unless MURAGE_VOICE_STREAM is exactly on", () => {
    expect(streamFlagOn({})).toBe(false);
    expect(streamFlagOn({ MURAGE_VOICE_STREAM: "1" })).toBe(false);
    expect(streamFlagOn({ MURAGE_VOICE_STREAM: "off" })).toBe(false);
    expect(streamFlagOn({ MURAGE_VOICE_STREAM: "on" })).toBe(true);
  });
});
