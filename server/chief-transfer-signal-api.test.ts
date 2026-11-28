// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CHIEF-TRANSFER-1023 W8 for Signal over the real server (designs/CHIEF-TRANSFER-1023.md r3). Owners: this witness = q1024-intsingle,
// the hand-over and its Signal adapter = bld1023-chief-transfer, the Signal runtime qualification = the Signal lane.
// This release ships Signal switched off (channels/signal/runtime-pin.json g0 null), so a plain booted server builds no Signal service.
// The fixture preload qualifies only that gate: the pin gets a g0 row and the runtime boot reports verified adapters (plus the
// container note on the custody fence's process scan, below). Everything after it is production code: index.ts builds the real
// SignalService from the seeded link, the real transfer adapter reads it, and the owner's hand-over goes through
// GET /api/chief-transfer/preview and POST /api/chief-transfer. No signal-cli runs (none is in the box), so the service reports
// needs-update and the link is a saved one that the transfer must still pause.
//   W8s  a Signal link saved for the old Chief and left unchecked: the commit pauses it on disk, still on the old Chief, and the
//        outcome lists it; a restart keeps the pause (the reader is not started again for the old Chief)
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;
let headers: Record<string, string>;
async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(new URL(path, fixture.info.url), { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as any };
}
async function api(method: string, path: string, body?: unknown) {
  const result = await call(method, path, body);
  expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeLessThan(300);
  return result.body;
}
async function readDesktopProof() {
  const proof = await (await fetch(new URL("/api/desktop-secret", fixture.info.url))).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}
const linkFile = () => join(fixture.info.dataDir, "channels", "signal", "connection.json");
const savedLink = () => JSON.parse(readFileSync(linkFile(), "utf8"));
const bots = async () => (await api("GET", "/api/bots?messages=0")).bots as Array<{ id: string; chiefScope?: string }>;

let chief: { id: string }, other: { id: string };

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: String.raw`
      // The preload runs only in the fixture's server process. It qualifies the Signal runtime gate and nothing else.
      const { registerHooks } = await import('node:module');
      registerHooks({ load(url, context, next) {
        const loaded = next(url, context);
        if (url.endsWith('/server/channels/signal/runtime-pin.json')) {
          const pin = JSON.parse(String(loaded.source));
          pin.g0 = { signalCliVersion: pin.signalCliVersion, citation: 'fixture', signalCliCommit: 'fixture' };
          return { ...loaded, source: JSON.stringify(pin) };
        }
        if (url.endsWith('/server/channels/signal/boot.ts')) {
          const source = String(loaded.source);
          const anchor = 'adapters: loadSignalAdapters(pin, fixtureDir)';
          if (!source.includes(anchor)) throw new Error('Signal boot anchor missing');
          return { ...loaded, source: source.replace(anchor, 'adapters: { ...loadSignalAdapters(pin, fixtureDir), verified: true, linkProtocol: {} }') };
        }
        // No signal-cli (and no Java) exists in the test box, which is what the custody fence's /proc scan proves on an owner's
        // computer; inside the container that scan cannot read every process, so the fixture states the fact instead.
        if (url.endsWith('/server/channels/signal/park-fence.ts')) {
          const source = String(loaded.source);
          const anchor = "platform === 'linux' && discoverSignalChildren(join(io.root, 'signal/auth'), deadline)";
          if (!source.includes(anchor)) throw new Error('Signal fence anchor missing');
          return { ...loaded, source: source.replace(anchor, 'true') };
        }
        return loaded;
      } });
    ` });
  await readDesktopProof();
  const model = (await api("GET", "/api/instances")).instances.find((entry: any) => entry.instanceId === "verification").models.options[0].id;
  const make = async (name: string) => (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } })).bot as { id: string };
  chief = await make("Alpha"); other = await make("Bravo");
  await api("PATCH", `/api/bots/${chief.id}`, { computer: "off", browser: false, composio: false, chiefOfStaff: true, chiefScope: "workspace" });
  // the Signal link the owner made with the old Chief, written as its link flow leaves it: owner-only files and a signal/auth folder (without it the boot reads a restored backup and revokes)
  const connectionId = randomUUID(), generation = 1;
  mkdirSync(join(fixture.info.dataDir, "channels", "signal"), { recursive: true, mode: 0o700 });
  mkdirSync(join(fixture.info.dataDir, "signal", "auth"), { recursive: true, mode: 0o700 });
  writeFileSync(linkFile(), JSON.stringify({ version: 1, connectionId, generation, enabled: true, paused: false, revoking: false,
    binding: { connectionId, generation, ownAci: "00000000-0000-4000-8000-000000000001", ownDeviceId: 2, linkedAt: 1_700_000_000_000, chiefBotId: chief.id },
    account: "+15550100000" }), { mode: 0o600 });
  await fixture.restart();
  await readDesktopProof();
}, 120_000);
afterAll(async () => { await fixture?.close(); });

it("W8s a Signal link left unchecked while the Chief changes is paused on the old Chief, listed in the outcome, and stays paused after a restart", async () => {
  // the booted server built the real Signal service from the saved link
  expect((await api("GET", "/api/signal/status")).state).not.toBe("off");
  const from = (await bots()).find(bot => bot.chiefScope === "workspace")!.id;
  expect(from).toBe(chief.id);
  const to = other.id;
  const preview = await call("GET", `/api/chief-transfer/preview?from=${from}&to=${to}`);
  // the previous release has no hand-over: the owner elects the new Chief directly, the only route it has
  const result = preview.status === 404
    ? await call("PATCH", `/api/bots/${to}`, { chiefOfStaff: true, chiefScope: "workspace" })
    : await call("POST", "/api/chief-transfer", { fence: preview.body.fence, move: [] });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect((await bots()).find(bot => bot.chiefScope === "workspace")?.id).toBe(to);
  // the behaviour: the unchecked Signal link is paused on disk, still on the old Chief, before the answer comes back
  expect(savedLink()).toMatchObject({ enabled: true, paused: true, binding: { chiefBotId: from } });
  expect(preview.body.pairings.map((pair: { channel: string; live: boolean; target: string }) => ({ channel: pair.channel, live: pair.live, target: pair.target })))
    .toEqual([{ channel: "signal", live: true, target: from }]);
  expect(result.body.outcome.channels).toEqual([{ channel: "signal", result: "paused:left-paused" }]);
  // the pause is durable: a restart reads it and does not resume the link for the old Chief
  await fixture.restart();
  await readDesktopProof();
  expect(savedLink()).toMatchObject({ paused: true, binding: { chiefBotId: from } });
}, 120_000);
