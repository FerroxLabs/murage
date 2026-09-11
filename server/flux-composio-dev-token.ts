// The dev harness's own FluxRouter connected-apps broker token.
//
// A packaged app mints the broker token in electron/main.mjs from the
// encrypted Flux key and hands it to the server child it forked, over the
// private utility port. A dev harness (`pnpm dev:server`) has no such parent:
// the Electron dev shell loads the Vite renderer and never forks the server,
// so nothing main.mjs minted could reach it (`syncManagedComposioCredentials`
// has no `serverProc` to post to). Without this module a dev harness with
// `MURAGE_FLUX_COMPOSIO_BROKER_URL` set could never hold a token, and the
// panel would say FluxRouter was unreachable while it was perfectly healthy.
//
// So the dev harness mints for itself, with the same rules the desktop shell
// follows (`ensureFluxComposioBrokerToken` is shared, not copied), from the
// same stored Flux key it routes models with (`fluxKey()`). That is what makes
// dev and packaged resolve the same broker for the same credentials: the
// FluxRouter account, and through it the Composio identity, is chosen by the
// key, never by which build presented it. The token is kept in the harness's
// own data directory (owner-only) so restarts re-use it instead of minting a
// fresh one each launch — FluxRouter keeps at most five live tokens per
// account, and a developer's restarts must not revoke the packaged app's.
//
// Never inside the packaged app: an embedded harness receives its token from
// main.mjs, and the env override `MURAGE_FLUX_COMPOSIO_BROKER_TOKEN` always
// wins so QA can pin one by hand.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import {
  ensureFluxComposioBrokerToken,
  FLUX_BROKER_TOKEN,
  type FluxComposioTokenFields,
} from "../electron/flux-composio-token.mjs";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { fluxKey } from "./flux-config.ts";

export const DEV_FLUX_TOKEN_FILE = "flux-composio-broker-token.json";
export const DEV_FLUX_TOKEN_LABEL = "murage-dev-harness";
/** After a failed attempt (network, 5xx, 429) wait this long before another. */
export const DEV_FLUX_TOKEN_RETRY_MS = 60_000;
export const DEV_FLUX_TOKEN_RATE_LIMIT_RETRY_MS = 60 * 60_000;

const documentSchema = z.object({
  fluxComposioBrokerToken: z.string().regex(FLUX_BROKER_TOKEN).optional(),
  fluxComposioBrokerTokenExpiresAt: z.string().optional(),
  fluxComposioBrokerTokenKeyFingerprint: z.string().optional(),
  fluxComposioAccountKind: z.enum(["personal", "shared"]).optional(),
  fluxComposioTokenError: z.string().optional(),
}).strict();

export type DevFluxTokenDocument = FluxComposioTokenFields;

/** Only the plain dev harness. `parentPort` is supplied by exactly one
 * runtime — an Electron utility process — and `MURAGE_DESKTOP_PARENT` is how
 * a packaged parent marks its child before the port speaks. */
export function harnessEmbeddedInDesktop(env: NodeJS.ProcessEnv = process.env): boolean {
  return (process as NodeJS.Process & { parentPort?: unknown }).parentPort !== undefined || env.MURAGE_DESKTOP_PARENT === "1";
}

function tokenPath(): string {
  return join(DATA_DIR, DEV_FLUX_TOKEN_FILE);
}

/** Loaded from disk once; every write refreshes it. `activeBroker` is
 * synchronous and runs per request, so it must not read a file. */
let cached: DevFluxTokenDocument | null = null;

export function readDevFluxTokenDocument(): DevFluxTokenDocument {
  if (cached) return cached;
  try {
    if (!existsSync(tokenPath())) return (cached = {});
    const parsed = documentSchema.safeParse(JSON.parse(readFileSync(tokenPath(), "utf8")));
    return (cached = parsed.success ? parsed.data : {});
  } catch {
    return (cached = {});
  }
}

function writeDevFluxTokenDocument(document: DevFluxTokenDocument): void {
  cached = document;
  if (!document.fluxComposioBrokerToken && !document.fluxComposioTokenError) {
    try {
      unlinkSync(tokenPath());
    } catch {
      // nothing to forget
    }
    return;
  }
  writeFileAtomic(tokenPath(), JSON.stringify(document, null, 2), { mode: 0o600 });
}

/** Forget the stored token document (tests; a workspace reset). */
export function clearDevFluxTokenDocument(): void {
  writeDevFluxTokenDocument({});
}

export interface DevFluxTokenOptions {
  fluxBrokerUrl: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  now?: number;
  force?: boolean;
  env?: NodeJS.ProcessEnv;
}

let nextAttemptAt = 0;
let inFlight: Promise<DevFluxTokenDocument> | null = null;

/** Reset the retry clock and the in-memory copy (tests; a data-dir change). */
export function resetDevFluxTokenState(): void {
  nextAttemptAt = 0;
  inFlight = null;
  cached = null;
}

/** Whether a mint is running right now; a turn never waits on one. */
export function devFluxTokenInFlight(): boolean {
  return inFlight !== null;
}

/** Whether this harness mints its own token: a plain dev harness with the
 * Flux broker turned on and no token pinned through the env. */
export function devFluxTokenApplies(fluxBrokerUrl: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return fluxBrokerUrl !== "" && !harnessEmbeddedInDesktop(env) && !(env.MURAGE_FLUX_COMPOSIO_BROKER_TOKEN ?? "").trim();
}

/** Mint, keep or clear the dev harness's token and return the document. The
 * stored Flux key decides: no key means no token (and the old one revoked);
 * a changed key re-mints under the new account. One attempt at a time, and a
 * failed attempt is not retried for a minute (an hour after a 429). Never
 * throws — connected apps are optional. */
export async function ensureDevFluxBrokerToken(options: DevFluxTokenOptions): Promise<DevFluxTokenDocument> {
  const env = options.env ?? process.env;
  const current = readDevFluxTokenDocument();
  if (!devFluxTokenApplies(options.fluxBrokerUrl, env)) return current;
  if (inFlight) return inFlight;
  const now = options.now ?? Date.now();
  const key = fluxKey(env) ?? "";
  // `ensureFluxComposioBrokerToken` returns the same document when the token
  // is healthy, so the cheap no-network case is the common one. The retry
  // clock only gates attempts that would go to the network.
  if (!key && !current.fluxComposioBrokerToken && !current.fluxComposioTokenError) return current;
  if (!options.force && now < nextAttemptAt) return current;
  inFlight = (async () => {
    let rateLimited = false;
    let attempted = false;
    const baseFetch = options.fetchImpl ?? globalThis.fetch;
    const fetchImpl: typeof fetch = (input, init) => {
      attempted = true;
      return baseFetch(input, init);
    };
    const before = current.fluxComposioBrokerToken;
    let next: DevFluxTokenDocument = current;
    try {
      next = await ensureFluxComposioBrokerToken({
        fluxBrokerUrl: options.fluxBrokerUrl,
        credentials: current,
        fluxKey: key,
        fetchImpl,
        log: options.log,
        now,
        force: options.force,
        onRateLimited: () => { rateLimited = true; },
        label: DEV_FLUX_TOKEN_LABEL,
      });
    } catch (error) {
      options.log?.(`dev connected-apps token failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // A network attempt that produced no new token (unreachable, 5xx, or a
    // declined code the panel now shows) waits before the next one, so a
    // declined key is not re-presented on every connector route.
    nextAttemptAt = rateLimited
      ? now + DEV_FLUX_TOKEN_RATE_LIMIT_RETRY_MS
      : attempted && next.fluxComposioBrokerToken === before ? now + DEV_FLUX_TOKEN_RETRY_MS : 0;
    try {
      writeDevFluxTokenDocument(next);
    } catch (error) {
      options.log?.(`dev connected-apps token could not be stored: ${error instanceof Error ? error.message : String(error)}`);
    }
    return next;
  })().finally(() => { inFlight = null; });
  return inFlight;
}
