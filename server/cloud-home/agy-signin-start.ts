// SPDX-License-Identifier: AGPL-3.0-or-later
// The in-chat Antigravity sign-in's start (fallback for clients that cannot run the desktop sign-in box). When an
// agy turn starts for a bot with no token, the home starts agy's full-screen login on a pty (the launcher's `login`
// mode, same relay as engine-login.ts; the launcher presses Enter on the login menu itself), reads Google's link
// from the pty, checks it exactly, tells the owner in chat, and holds the pty for the code (agy-signin-code.ts).
// The pty's bytes are held in memory only until the link is found, then counted and dropped; nothing is stored or
// logged here but identifiers and counts.
import type { ChildProcess } from "node:child_process";
import { AgySigninHolds, agySigninHolds, SIGNIN_HOLD_TTL_MS } from "./agy-signin-code.ts";
import { queryCloudBotState } from "./bot-state.ts";
import { cloudHomeCopy } from "./copy.ts";
import { spawnEngineLoginLauncher } from "./engine-login.ts";

/** agy 1.4.4's own OAuth client and redirect (read from the binary). Anything else is not shown to the owner. */
export const AGY_OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const AGY_OAUTH_REDIRECT = "https://antigravity.google/oauth-callback";
const LINK_WAIT_MS = 30_000;
const SCAN_CAP = 64 * 1024;

/** The link, only if it is exactly Google's sign-in page for agy's client and redirect; otherwise null. */
export function checkedGoogleLink(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.hostname !== "accounts.google.com" || url.port !== "" || url.username || url.password) return null;
  if (url.pathname !== "/o/oauth2/auth" && url.pathname !== "/o/oauth2/v2/auth") return null;
  if (url.searchParams.get("client_id") !== AGY_OAUTH_CLIENT_ID || url.searchParams.get("redirect_uri") !== AGY_OAUTH_REDIRECT) return null;
  // PKCE is required: an auth code intercepted at the edge is useless without the verifier that stays on the home.
  if (!url.searchParams.get("code_challenge") || url.searchParams.get("code_challenge_method") !== "S256") return null;
  return url.toString();
}

/** The first OSC 8 hyperlink target in terminal output (ESC ] 8 ; params ; URI, ended by BEL or ESC \). */
export function osc8Link(output: string): string | null {
  const match = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/.exec(output);
  return match ? match[1] : null;
}

const signinLine = (link: string) => cloudHomeCopy.antigravitySigninLine.replace("{link}", link);

export type SigninStart = "started" | "pending" | "failed";
export interface AgySigninStarterDeps {
  launch?: (botId: string) => ChildProcess;
  holds?: AgySigninHolds;
  /** Append one Murage line to the bot's thread. */
  say: (botId: string, text: string) => void;
  ttlMs?: number;
  linkWaitMs?: number;
  log?: (line: string) => void;
}

export class AgySigninStarter {
  private active = new Map<string, { link: string; child: ChildProcess; timer: NodeJS.Timeout }>();
  private starting = new Map<string, Promise<SigninStart>>();
  private readonly deps: AgySigninStarterDeps;
  constructor(deps: AgySigninStarterDeps) { this.deps = deps; }

  has(botId: string): boolean { return this.active.has(botId); }

  /** Start (or re-show) this bot's sign-in. One per bot. Resolves once the link is shown or the start failed. */
  start(botId: string): Promise<SigninStart> {
    const live = this.active.get(botId);
    if (live) { this.deps.say(botId, signinLine(live.link)); return Promise.resolve("pending"); }
    const inFlight = this.starting.get(botId);
    if (inFlight) return inFlight;
    const run = this.begin(botId).finally(() => this.starting.delete(botId));
    this.starting.set(botId, run);
    return run;
  }

  private begin(botId: string): Promise<SigninStart> {
    const holds = this.deps.holds ?? agySigninHolds;
    const log = this.deps.log ?? ((line: string) => console.log(line));
    return new Promise<SigninStart>((resolve) => {
      let child: ChildProcess;
      try { child = (this.deps.launch ?? ((id) => spawnEngineLoginLauncher("antigravityAgent", "login", { bot: id })))(botId); }
      catch { this.deps.say(botId, cloudHomeCopy.antigravitySigninFailed); resolve("failed"); return; }
      let scan = "", seen = 0, linked = false, done = false;
      const ttl = this.deps.ttlMs ?? SIGNIN_HOLD_TTL_MS;
      const kill = () => { try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* gone */ } } };
      const end = (outcome: SigninStart, line?: string) => {
        if (done) return;
        done = true;
        clearTimeout(wait);
        scan = "";
        const entry = this.active.get(botId);
        if (entry) clearTimeout(entry.timer);
        this.active.delete(botId);
        holds.drop(botId);
        kill();
        if (line) this.deps.say(botId, line);
        resolve(outcome);
      };
      const wait = setTimeout(() => { if (!linked) end("failed", cloudHomeCopy.antigravitySigninFailed); }, this.deps.linkWaitMs ?? LINK_WAIT_MS);
      wait.unref?.();
      const onData = (chunk: Buffer) => {
        seen += chunk.length;
        if (linked || done) return; // counted, never kept
        scan += chunk.toString("utf8");
        if (scan.length > SCAN_CAP) scan = scan.slice(-SCAN_CAP);
        const raw = osc8Link(scan);
        if (raw === null) return;
        scan = "";
        const link = checkedGoogleLink(raw);
        if (link === null) { end("failed", cloudHomeCopy.antigravitySigninFailed); return; }
        linked = true;
        clearTimeout(wait);
        const timer = setTimeout(() => end("failed", cloudHomeCopy.antigravitySigninExpired), ttl);
        timer.unref?.();
        this.active.set(botId, { link, child, timer });
        holds.hold(botId, (bytes) => {
          const stdin = child.stdin;
          if (!stdin || stdin.destroyed || !stdin.writable) return false;
          stdin.write(bytes);
          return true;
        });
        this.deps.say(botId, signinLine(link));
        resolve("started");
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.stdin?.on("error", () => {});
      child.on("error", () => end("failed", cloudHomeCopy.antigravitySigninFailed));
      child.on("close", (code) => {
        log(`agy-signin end bot=${botId} exit=${code ?? "none"} bytes=${seen}`);
        if (done) return;
        end(linked ? "started" : "failed", code === 0 ? cloudHomeCopy.antigravitySignedIn : linked ? cloudHomeCopy.antigravitySigninRejected : cloudHomeCopy.antigravitySigninFailed);
      });
    });
  }
}

let starter: AgySigninStarter | null = null;
/** Registered once by the server (index.ts) with the function that writes a line into a bot's thread. */
export function configureAgySignin(say: AgySigninStarterDeps["say"]): AgySigninStarter {
  starter = new AgySigninStarter({ say });
  return starter;
}

/** The driver's gate (antigravity.ts): on a home, a bot with no Antigravity token does not run a turn. The sign-in
 * starts instead and the owner is told in chat. Returns the plain note to show, or null to run the turn. A launcher
 * that cannot answer lets the turn run (agy then reports its own sign-in error). */
export async function agySigninRequired(botId: string | null | undefined, query: typeof queryCloudBotState = queryCloudBotState): Promise<string | null> {
  if (!botId || process.env.MURAGE_CLOUD_ROLE !== "home" || !starter) return null;
  try {
    const state = await query(botId);
    if (state.engines.antigravity?.signedIn) return null;
  } catch { return null; }
  const outcome = await starter.start(botId);
  return outcome === "failed" ? cloudHomeCopy.antigravitySigninFailed : cloudHomeCopy.antigravityNeedsSignin;
}
