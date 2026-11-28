// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1024-steerquar: a real bot-wide mount relay quarantine, as a stop that cannot confirm the engine's tree leaves it. The relay is
// the production CliMountRelay; only its engine is a stand-in whose pid the caller's procs mock reports as never stopped
// (HELD_RELAY_PID), so the hold persists for the whole test and no late confirmation can clear it. With `servers`, each named mount
// child is a stand-in on the same pid (H2): its stop cannot confirm either, as for an integration that may still be running.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { expect, onTestFinished } from "vitest";
import { consumingFixture } from "./consuming-fixture.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createMcpMountAdmission } from "../drivers/mcp-mounts.ts";
import { createTurnCredentialStore } from "../drivers/turn-credentials.ts";
import { assertRelayAvailable, CliMountRelay } from "../drivers/cli-mount-relay.ts";
import type { SendTurnInput } from "../contracts.ts";

/** The stand-in engine pid: a procs mock answers "not stopped" for it and never signals a late confirmation. */
export const HELD_RELAY_PID = 2_000_000_017;

/** Leave `botId` quarantined by an earlier turn's relay whose stop could not confirm. Returns that earlier turn. */
export async function holdBotRelay(botId: string, servers: Record<string, unknown> = {}): Promise<SendTurnInput> {
  const f = consumingFixture(undefined, { botId });
  const caps = new InternalCapabilities(); caps.begin(botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const admission = createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1");
  const cred = createTurnCredentialStore();
  onTestFinished(() => { try { cred.dispose(); } finally { f.close(); } });
  const turn: SendTurnInput = { threadId: f.turn.threadId, text: "held", warmIdentity: { botId, audience: "owner" }, releaseBinding: f.binding, mountAdmission: admission };
  const standIn = () => Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    pid: HELD_RELAY_PID, exitCode: null, signalCode: null, kill: () => true }) as unknown as ChildProcess;
  let launched = 0;
  const relay = await CliMountRelay.create(turn, servers, {}, cred, () => (launched++, standIn()));
  expect(launched, "fixture: every held mount child was started").toBe(Object.keys(servers).length);
  const engine = standIn();
  expect(await relay.finish(engine), "fixture: the earlier relay's stop is unconfirmed").toBe(false);
  expect(() => assertRelayAvailable(turn), "fixture: the bot is quarantined").toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
  return turn;
}
