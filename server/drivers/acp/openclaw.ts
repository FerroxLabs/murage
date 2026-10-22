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
// Tools and approvals: an OpenClaw bot runs on OpenClaw's OWN tools. Verified
// live against the bridge (OpenClaw 2026.10.5): it ignores `session/new`
// `mcpServers` (a mounted probe tool was reported as absent), so `ownTools:
// true` below: Murage hands the bridge NO mounts and declares no teammates,
// memory, computer, browser or connected-apps capability. Its exec approvals
// live on the Gateway, which runs the agent; the bridge relays a Gateway exec
// approval to the client as `session/request_permission`, but the Gateway
// asks only when its exec policy says so, and its default (permission mode
// "full") never does, so a shell command ran with no ask at Ask. The
// Gateway's policy is the owner's and shared (`openclaw exec-policy`,
// `sessions.patch`), so Murage never edits it. OpenClaw's inline `/exec`
// directive sets the exec policy "for this run only": every prompt starts
// with `/exec ask=always security=full`, so each shell command is asked
// through the bridge and Murage's access level answers it (Full access and
// Auto answer it unasked, Ask shows the card). A command OpenClaw cannot bind
// to an approval (one with a shell redirect) is refused by OpenClaw itself,
// ask or no ask. OpenClaw's own file-write tool has no ask in any permission
// mode (only read-only blocks it), so a write cannot be asked: at Ask the turn
// runs read-only instead (the Ask hard stop, ../ask-stop.ts). Before the prompt
// the Gateway session's permission mode is set to "read-only" (`openclaw
// gateway call sessions.patch`, OpenClaw 2026.8.1 and later: mutation tools are
// left out and exec is denied) and the prompt's directive is
// `/exec security=deny`. Releases before 2026.8.1 (2026.7.35 and earlier) have no permissionMode on sessions.patch
// (the closed schema rejects it), so there an Ask turn is refused before anything runs (ASK_STOP_OPENCLAW_OLD_NOTE).
// The Gateway's answer to the patch is the session entry it stored, and the turn runs only when that entry shows
// "read-only". The mode it replaced is recorded under Murage's data
// dir and put back by the next turn that is not at Ask, so Auto and Full
// access run exactly as before. A mode that cannot be set refuses the turn.
//
// Remote seam: a remote gateway is `openclaw acp --url <ws> --token-file <f>`.
// It is deliberately NOT implemented. `openclawBridgeArgs` is the single place
// argv is built; a future `config.url` / `config.tokenFile` extends it there
// (the token goes in a file, never in argv), and `decodeExtra` below is where
// the new fields would be validated.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../atomic.ts";
import { DATA_DIR } from "../../config.ts";
import type { ModelCatalog } from "../../contracts.ts";
import { execCli } from "../../procs.ts";
import { AskStopRefusal, ASK_STOP_OPENCLAW_OLD_NOTE } from "../ask-stop.ts";
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

/** argv AFTER the binary: enter ACP stdio mode for one named agent. Every
 * spawn names its agent, so nothing OpenClaw keeps as a default can change who
 * answers. The one place to extend for the future remote form. */
export function openclawBridgeArgs(config: OpenclawAgentConfig): string[] {
  return ["acp", "--session", openclawSessionKey(openclawAgentOf(config))];
}

/** OpenClaw's inline exec directive, "for this run only": ask for every shell command, whatever the Gateway's own
 *  exec policy or the session's permission mode says. Only the leading line of a prompt that carries more text is
 *  read as a directive, so OpenClaw acts on it and sends no acknowledgement into the reply. */
export const OPENCLAW_ASK_DIRECTIVE = "/exec ask=always security=full";

/** The same directive on an Ask turn: no shell command runs at all ("for this run only", and it can only tighten the
 *  session's read-only mode, never loosen it). */
export const OPENCLAW_ASK_STOP_DIRECTIVE = "/exec security=deny";

export function openclawPromptText(turn: { system?: string; text: string; askLevel?: true }): string {
  const directive = turn.askLevel ? OPENCLAW_ASK_STOP_DIRECTIVE : OPENCLAW_ASK_DIRECTIVE;
  return `${directive}\n${turn.system ? `${turn.system}\n\n${turn.text}` : turn.text}`;
}

/** The session permission mode an Ask turn runs under (OpenClaw "Session permission modes"). */
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
  return openclawHasPermissionMode(versionText) ? undefined : ASK_STOP_OPENCLAW_OLD_NOTE;
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
        const parsed: unknown = JSON.parse(start >= 0 ? text.slice(start) : text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return resolve(parsed as Record<string, unknown>);
      } catch { /* below */ }
      reject(new Error(`openclaw gateway call ${method} gave no JSON object`));
    });
});

/** Where the mode an Ask turn replaced is kept until a later turn puts it back: Murage's own data dir, one file per
 *  OpenClaw binary and session key. */
export function openclawAskStopRecordPath(cli: string, sessionKey: string, dataDir = DATA_DIR): string {
  const id = createHash("sha256").update(`${cli}\0${sessionKey}`).digest("hex").slice(0, 24);
  return join(dataDir, "native", "openclaw-ask-stop", `${id}.json`);
}

type AskStopRecord = { key: string; previous: string | null };
function readRecord(path: string): AskStopRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AskStopRecord>;
    if (typeof parsed?.key !== "string") return null;
    return { key: parsed.key, previous: typeof parsed.previous === "string" ? parsed.previous : null };
  } catch {
    return null;
  }
}

/** The session row's permission mode (null when the session has none, or is not listed yet). */
async function currentPermissionMode(call: OpenclawGatewayCall, cli: string, key: string, env: Record<string, string | undefined>): Promise<string | null> {
  const listed = await call(cli, "sessions.list", { limit: 50, search: key }, env);
  const rows = Array.isArray(listed.sessions) ? listed.sessions as Array<Record<string, unknown>> : [];
  const row = rows.find((entry) => entry?.key === key);
  return typeof row?.permissionMode === "string" ? row.permissionMode : null;
}

/**
 * The Ask hard stop for OpenClaw (support.askStop.apply), called before every prompt. At Ask: record the session's
 * current permission mode (once, before anything is changed), set "read-only", and require the Gateway's answer to
 * show it set; any failure throws and the turn does not run. Not at Ask: when a record exists, put its mode back if
 * the session still shows "read-only" (an owner who changed it since keeps their choice), then drop the record. With
 * no record nothing is called, so Auto and Full access run as before.
 */
export async function applyOpenclawAskStop(ctx: { env: Record<string, string | undefined>; config: AcpConfig; askLevel: boolean },
  call: OpenclawGatewayCall = openclawGatewayCall, dataDir = DATA_DIR, probeVersion: OpenclawVersionProbe = openclawVersionProbe): Promise<void> {
  const cli = ctx.config.cli || "openclaw";
  const key = openclawSessionKey(openclawAgentOf(ctx.config as OpenclawAgentConfig));
  const recordPath = openclawAskStopRecordPath(cli, key, dataDir);
  const record = readRecord(recordPath);
  if (ctx.askLevel) {
    // A version without permissionMode on sessions.patch rejects the call, so refuse before anything is recorded or run.
    let versionText = "";
    try { versionText = await probeVersion(cli, ctx.env); } catch { /* unreadable: treated as below the floor */ }
    if (!openclawHasPermissionMode(versionText)) throw new AskStopRefusal(ASK_STOP_OPENCLAW_OLD_NOTE);
    if (!record) {
      const previous = await currentPermissionMode(call, cli, key, ctx.env);
      mkdirSync(join(dataDir, "native", "openclaw-ask-stop"), { recursive: true, mode: 0o700 });
      writeFileAtomic(recordPath, `${JSON.stringify({ key, previous })}\n`, { mode: 0o600 });
    }
    // The answer's `entry` is the session row the Gateway stored after the patch (OpenClaw's projectSessionPatchResult),
    // not our request echoed back: a Gateway that took the call but did not apply the mode shows no "read-only" here.
    const patched = await call(cli, "sessions.patch", { key, permissionMode: OPENCLAW_READ_ONLY_MODE }, ctx.env);
    const entry = patched.entry as Record<string, unknown> | undefined;
    if (patched.ok !== true || entry?.permissionMode !== OPENCLAW_READ_ONLY_MODE) {
      throw new Error(`the Gateway did not confirm ${OPENCLAW_READ_ONLY_MODE} for ${key}`);
    }
    return;
  }
  if (!record) return;
  try {
    const current = await currentPermissionMode(call, cli, key, ctx.env);
    if (current === OPENCLAW_READ_ONLY_MODE && record.previous !== OPENCLAW_READ_ONLY_MODE) {
      await call(cli, "sessions.patch", { key, permissionMode: record.previous }, ctx.env);
    }
    rmSync(recordPath, { force: true });
  } catch (error) {
    // Kept for the next turn to try again; this turn runs on whatever mode the session has.
    console.warn(`OpenClaw ask stop: permission mode not put back for ${key} (${(error as Error)?.message ?? error})`);
  }
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
  spawnArgs: (config) => openclawBridgeArgs(config),
  // authMethods is empty: nothing to authenticate, and a missing sign-in is
  // OpenClaw's own error to report, not a reason to refuse the spawn.
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
  buildPromptText: openclawPromptText,
  askStop: { apply: (ctx) => applyOpenclawAskStop(ctx) },
  versionNote: openclawVersionNote,
};

export { DEFAULT_OPENCLAW_AGENT };
export const OpenclawAgentDriver = createAcpDriver(openclawSupport);
