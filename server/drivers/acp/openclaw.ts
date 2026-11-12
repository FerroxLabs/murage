import { registerBusyloopPayloadSite } from "../../../shared/flux-route.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OpenClaw — `openclaw acp`, the ACP stdio bridge OpenClaw ships natively.
// Each OpenClaw isolated agent (workspace + auth + routing) mounts as its own
// engine instance, selected with `{ agent?: string }` in the instance config
// exactly as a Hermes profile is selected with `{ profile? }`.
//
//   { "instances": { "openclaw-agent-fred": {
//       "driver": "openclawAgent",
//       "displayName": "OpenClaw · fred",
//       "config": { "agent": "fred" } } } }
//
// Auth: none. The local bridge advertises `authMethods: []` (verified against
// OpenClaw 2026.9.5), carries its own gateway and model, and reads its own
// state dir. Unlike Hermes there is no Flux home to materialise and no
// provider key to inject: this driver writes NOTHING to disk and puts no
// credential in the child env.
//
// Model: the agent runs whatever it is configured for. One passthrough id is
// advertised and no model is ever sent (`-m` conventions differ per CLI and
// the bridge does not take one).
//
// Tools and approvals: OpenClaw runs on its own tools, with no Murage mounts.
// Lower levels confirm read-only on the exact bridge session and deny managed exec.
// The server's owner-only No limits flag opens that session for writes and exec. That alone cannot establish refused-read, skill-root,
// plugin, native-harness or delegation coverage. Unknown coverage refuses
// the turn. Shared Gateway defaults and legacy recovery records stay intact;
// Every later lower-level turn restores the read-only mode on its conversation session.
// Offline package witness: openclaw-package.test.ts executes the published
// 2026.10.5 permission projection, directive parser and ACP exec-approval relay.
// ask=always keeps each command at session/request_permission for Murage’s wipe check.
//
// Remote seam: a remote gateway is `openclaw acp --url <ws> --token-file <f>`.
// It is deliberately NOT implemented. `openclawBridgeArgs` is the single place
// argv is built; a future `config.url` / `config.tokenFile` extends it there
// (the token goes in a file, never in argv), and `decodeExtra` below is where
// the new fields would be validated.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../../atomic.ts";
import { join } from "node:path";
import { DATA_DIR } from "../../config.ts";
import type { ModelCatalog, SendTurnInput } from "../../contracts.ts";
import { execCli } from "../../procs.ts";
import { AskStopRefusal } from "../ask-stop.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";
import {
  DEFAULT_OPENCLAW_AGENT,
  isOpenclawAgentName,
  openclawAgentOf,
  openclawSessionKey,
} from "../../openclaw-profiles.ts";

const DRIVER_KIND = "openclawAgent";

/** Passthrough: the agent's own configured model. Never sent over ACP. */
export const OPENCLAW_DEFAULT_MODEL_ID = "openclaw-default";

const CATALOG: ModelCatalog = {
  default: OPENCLAW_DEFAULT_MODEL_ID,
  // `custom: true` so the custom-only picker pane lists it (see hermes.ts).
  options: [{ id: OPENCLAW_DEFAULT_MODEL_ID, label: "OpenClaw agent default", custom: true }],
};

type OpenclawAgentConfig = { agent?: string } | undefined;

const generationsPath = (dataDir: string): string => join(dataDir, "native", "openclaw-session-generations.json");

function readGenerations(dataDir: string): Record<string, number> {
  try {
    const parsed = registerBusyloopPayloadSite("read", JSON.parse(readFileSync(generationsPath(dataDir), "utf8"))) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, value]) => Number.isSafeInteger(value) && (value as number) > 0)) as Record<string, number>;
  } catch {
    return {};
  }
}

/** How many times this conversation's OpenClaw session was reset (0 when never). */
export function openclawSessionGeneration(threadId: string, dataDir = DATA_DIR): number {
  return readGenerations(dataDir)[threadId] ?? 0;
}

/** A reset turn (edit, rewind, memory revocation) moves the conversation to a new gateway key: the gateway keeps
 *  one conversation per key, so the old key's history, which holds what the owner removed, is attached to nobody. */
export function bumpOpenclawSessionGeneration(threadId: string, dataDir = DATA_DIR): number {
  const all = readGenerations(dataDir);
  const next = (all[threadId] ?? 0) + 1;
  all[threadId] = next;
  mkdirSync(join(dataDir, "native"), { recursive: true, mode: 0o700 });
  writeFileAtomic(generationsPath(dataDir), `${JSON.stringify(all)}\n`, { mode: 0o600 });
  return next;
}

/** argv AFTER the binary: enter ACP stdio mode for one named agent, on the
 * gateway conversation that belongs to this Murage conversation and audience
 * (openclawSessionKey). Every spawn names its agent, so nothing OpenClaw keeps
 * as a default can change who answers, and the bridge binds every session it
 * opens or loads to this key, so no other conversation's history is reachable.
 * The old shared `agent:<agent>:main` history is orphaned in the gateway and
 * attached to nobody; every conversation and person starts fresh on its own key.
 * The one place to extend for the future remote form. */
export function openclawBridgeArgs(config: OpenclawAgentConfig, turn: Pick<SendTurnInput, "threadId" | "warmIdentity">): string[] {
  return ["acp", "--session", openclawTurnSessionKey(config, turn)];
}

/** The Gateway session a turn runs on: the one key openclawBridgeArgs hands the bridge and the Ask hard stop
 *  (applyOpenclawAskStop) sets read-only, so the stop always lands on the session the turn uses. */
export function openclawTurnSessionKey(config: OpenclawAgentConfig, turn: Pick<SendTurnInput, "threadId" | "warmIdentity">): string {
  return openclawSessionKey(openclawAgentOf(config), {
    threadId: turn.threadId,
    generation: openclawSessionGeneration(turn.threadId),
    audience: turn.warmIdentity?.audience,
    humanPrincipal: turn.warmIdentity?.humanPrincipal,
  });
}

/** Tighten managed exec on every ordinary prompt, at every permission level. */
export const OPENCLAW_ASK_STOP_DIRECTIVE = "/exec security=deny";
// Full native access; every exec approval is relayed by OpenClaw's ACP bridge
// to Murage, where No limits applies only the wipe/catastrophe check.
export const OPENCLAW_NO_LIMITS_DIRECTIVE = "/exec security=full ask=always";
export const OPENCLAW_READ_ONLY_NOTICE = "OpenClaw runs read-only here because it cannot enforce Murage’s protected-folder, refused-folder and wipe rules.";
export const OPENCLAW_DENY_REFUSAL = "OpenClaw cannot run this turn with your folder restrictions.";

export function openclawPromptText(turn: Pick<SendTurnInput, "system" | "text" | "askLevel" | "noLimits" | "permissionNow">): string {
  const body = turn.system ? `${turn.system}\n\n${turn.text}` : turn.text;
  return `${(turn.permissionNow?.() ?? turn).noLimits === true ? OPENCLAW_NO_LIMITS_DIRECTIVE : OPENCLAW_ASK_STOP_DIRECTIVE}\n${body}`;
}

/** The session permission mode every turn requires (OpenClaw "Session permission modes"). */
export const OPENCLAW_READ_ONLY_MODE = "read-only";
const GATEWAY_CALL_TIMEOUT_MS = 30_000;

/** The first OpenClaw release whose `sessions.patch` takes `permissionMode` (2026.8.1). Checked by unpacking the npm
 *  packages: 2026.8.1, 2026.8.35, 2026.9.1, 2026.9.33 (extended-stable) and 2026.10.5 (latest) all carry it in
 *  SessionsPatchMutationProperties with the "read-only" mode; 2026.7.35 and earlier do not, and their closed schema
 *  (additionalProperties false) rejects the field, so an Ask turn there cannot be stopped before changes. */
export const OPENCLAW_PERMISSION_MODE_FLOOR = "2026.8.1";

/** Parse "2026.10.5", "OpenClaw 2026.10.10-beta.3 (abc)" into [y, m, d, beta] (beta Infinity for a release); null when unreadable. */
export function parseOpenclawVersion(text: string): [number, number, number, number] | null {
  const m = /(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-beta\.(\d+))?/.exec(text);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Number.POSITIVE_INFINITY : Number(m[4])];
}

/** Whether this OpenClaw version text is at or above the permissionMode floor. Unreadable is below (fail closed). */
export function openclawHasPermissionMode(versionText: string): boolean {
  const v = parseOpenclawVersion(versionText);
  const floor = parseOpenclawVersion(OPENCLAW_PERMISSION_MODE_FLOOR)!;
  if (!v) return false;
  for (let i = 0; i < 4; i++) {
    if (v[i]! !== floor[i]!) return v[i]! > floor[i]!;
  }
  return true;
}

/** The line setup and engine detection show beside an OpenClaw version below the floor (the same one a refused Ask
 *  turn shows); undefined at or above it. */
export function openclawVersionNote(versionText: string): string | undefined {
  return openclawHasPermissionMode(versionText) ? undefined : OPENCLAW_DENY_REFUSAL;
}

/** Ask the installed binary for its version (`openclaw --version`). Throws on failure. */
export type OpenclawVersionProbe = (cli: string, env: Record<string, string | undefined>) => Promise<string>;
export const openclawVersionProbe: OpenclawVersionProbe = (cli, env) => new Promise((resolve, reject) => {
  execCli(cli, ["--version"], { timeout: 15_000, env: env as NodeJS.ProcessEnv, maxBuffer: 1024 * 1024 }, (err, stdout) => {
    if (err) return reject(err);
    resolve(String(stdout ?? ""));
  });
});

/** Run `openclaw gateway call <method> --params <json> --json` and return the parsed answer. Throws on any failure. */
export type OpenclawGatewayCall = (cli: string, method: string, params: Record<string, unknown>, env: Record<string, string | undefined>) => Promise<Record<string, unknown>>;
export const openclawGatewayCall: OpenclawGatewayCall = (cli, method, params, env) => new Promise((resolve, reject) => {
  execCli(cli, ["gateway", "call", method, "--params", JSON.stringify(params), "--json", "--timeout", "20000"],
    { timeout: GATEWAY_CALL_TIMEOUT_MS, env: env as NodeJS.ProcessEnv, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      const text = String(stdout ?? "");
      const start = text.indexOf("{");
      try {
        const parsed: unknown = registerBusyloopPayloadSite("read", JSON.parse(start >= 0 ? text.slice(start) : text));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return resolve(parsed as Record<string, unknown>);
      } catch { /* below */ }
      reject(new Error(`openclaw gateway call ${method} gave no JSON object`));
    });
});

/** Legacy recovery record location. Existing files are preserved without replaying their values. */
export function openclawAskStopRecordPath(cli: string, sessionKey: string, dataDir = DATA_DIR): string {
  const id = createHash("sha256").update(`${cli}\0${sessionKey}`).digest("hex").slice(0, 24);
  return join(dataDir, "native", "openclaw-ask-stop", `${id}.json`);
}

async function withinGatewayDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new AskStopRefusal(OPENCLAW_DENY_REFUSAL)), GATEWAY_CALL_TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer); }
}

type OpenclawPromptContext = Parameters<NonNullable<AcpSupport["prePrompt"]>["apply"]>[0];

/** Apply the server-owned level to this conversation key before each submission. */
export async function applyOpenclawAskStop(ctx: { env: Record<string, string | undefined>; config: AcpConfig; turn: Pick<SendTurnInput, "threadId" | "warmIdentity" | "noLimits" | "permissionNow">; askLevel: boolean },
  call: OpenclawGatewayCall = openclawGatewayCall, _dataDir = DATA_DIR, probeVersion: OpenclawVersionProbe = openclawVersionProbe): Promise<void> {
  const cli = ctx.config.cli || "openclaw";
  const key = openclawTurnSessionKey(ctx.config as OpenclawAgentConfig, ctx.turn);
  const mode = (ctx.turn.permissionNow?.() ?? ctx.turn).noLimits === true ? "full" : OPENCLAW_READ_ONLY_MODE;
  try {
    const versionText = await withinGatewayDeadline(probeVersion(cli, ctx.env));
    if (!openclawHasPermissionMode(versionText)) throw new AskStopRefusal(OPENCLAW_DENY_REFUSAL);
    const patched = await withinGatewayDeadline(call(cli, "sessions.patch", { key, permissionMode: mode }, ctx.env));
    // `entry` is the stored session row, not our request echoed back.
    const entry = patched?.entry as Record<string, unknown> | undefined;
    if (patched?.ok !== true || patched.key !== key || entry?.permissionMode !== mode) {
      throw new AskStopRefusal(OPENCLAW_DENY_REFUSAL);
    }
  } catch { throw new AskStopRefusal(OPENCLAW_DENY_REFUSAL); }
}

/** These independent boundaries require proof beyond permissionMode or a tool catalog.
 * No installed-package verifier is available yet. Production therefore refuses by default.
 * The injected verifier is an internal seam for isolated fixtures, never a user configuration flag
 * or a claimed Gateway attestation endpoint. */
export function createOpenclawPrePromptGuard(deps: {
  call?: OpenclawGatewayCall;
  dataDir?: string;
  probeVersion?: OpenclawVersionProbe;
  verifyCoverage?: (ctx: OpenclawPromptContext) => Promise<Partial<Record<"refusedReads" | "skillRoots" | "extraTools" | "nativeHarnesses" | "delegation" | "readBoundary", boolean>> | undefined>;
} = {}): NonNullable<AcpSupport["prePrompt"]> {
  return {
    notice: (turn) => (turn.permissionNow?.() ?? turn).noLimits === true ? undefined : OPENCLAW_READ_ONLY_NOTICE,
    refusal: OPENCLAW_DENY_REFUSAL,
    async apply(ctx) {
      await applyOpenclawAskStop(ctx, deps.call, deps.dataDir, deps.probeVersion);
      if ((ctx.turn.permissionNow?.() ?? ctx.turn).noLimits === true) return; // exec approvals remain on: OPENCLAW_NO_LIMITS_DIRECTIVE
      const coverage = await deps.verifyCoverage?.(ctx);
      if (!coverage || coverage.refusedReads !== true || coverage.skillRoots !== true || coverage.extraTools !== true
        || coverage.nativeHarnesses !== true || coverage.delegation !== true || coverage.readBoundary !== true) {
        throw new AskStopRefusal(OPENCLAW_DENY_REFUSAL);
      }
    },
  };
}

export const openclawSupport: AcpSupport = {
  driverKind: DRIVER_KIND,
  displayName: "OpenClaw",
  access: "custom",
  models: CATALOG,
  ownTools: true,
  defaultCli: "openclaw",
  nativeSource: "openclaw.acp",
  loginNote: "OpenClaw CLI is not installed",
  install: {
    command: {
      darwin: "npm install -g openclaw@latest",
      linux: "npm install -g openclaw@latest",
      win32: "npm install -g openclaw@latest",
    },
    docsUrl: "https://docs.openclaw.ai",
    signInCommand: "openclaw onboard",
  },
  decodeExtra: (raw) => (isOpenclawAgentName(raw.agent) ? { agent: raw.agent } : {}),
  spawnArgs: (config, turn) => openclawBridgeArgs(config, turn),
  onSessionReset: (turn) => { bumpOpenclawSessionGeneration(turn.threadId); },
  // authMethods is empty: nothing to authenticate, and a missing sign-in is
  // OpenClaw's own error to report, not a reason to refuse the spawn.
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
  buildPromptText: openclawPromptText,
  askStop: {},
  prePrompt: createOpenclawPrePromptGuard(),
  versionNote: openclawVersionNote,
};

export { DEFAULT_OPENCLAW_AGENT };
export const OpenclawAgentDriver = createAcpDriver(openclawSupport);
