// "Use my Chrome": find the owner's running Google Chrome for ONE opted-in bot.
//
// Since Chrome 136, --remote-debugging-port is ignored on the default profile,
// so relaunching Chrome with a flag can only ever reach a fresh, signed-out
// profile. The one route to the owner's real, signed-in profile is Chrome's
// own switch at chrome://inspect/#remote-debugging (Chrome 144+). While it is
// on, Chrome writes DevToolsActivePort (port, then browser WebSocket path)
// into its user-data directory and asks the owner to Allow each connection.
// The JSON discovery API is not served in that mode, so the WebSocket URL is
// built from the file rather than probed over HTTP.
//
// The URL is always loopback: only a port number and a fixed-shape path are
// taken from the file, so its contents can never point a bot's browser at
// another host. Nothing here reads the process environment for a CDP target.
import { closeSync, fstatSync, openSync, readSync, constants } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const USER_CHROME_SETUP_MESSAGE =
  "Your Chrome is not ready for this bot yet. Open chrome://inspect/#remote-debugging in Google Chrome and turn on remote debugging, keep Chrome open, then try again. Chrome will ask you to allow the connection.";

/** Google Chrome (stable) default user-data directory for this platform. */
export function userChromeDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Google", "Chrome");
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Google", "Chrome", "User Data");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "google-chrome");
}

const PORT_LINE = /^[0-9]{1,5}$/u;
const BROWSER_PATH = /^\/devtools\/browser\/[A-Za-z0-9-]{1,128}$/u;

/** Parse DevToolsActivePort contents into a loopback browser WebSocket URL. */
export function userChromeEndpointFromPortFile(text: string): string | null {
  const [portLine, pathLine] = text.split(/\r?\n/u).map((line) => line.trim());
  if (!portLine || !pathLine || !PORT_LINE.test(portLine) || !BROWSER_PATH.test(pathLine)) return null;
  const port = Number(portLine);
  if (port < 1 || port > 65_535) return null;
  return `ws://127.0.0.1:${port}${pathLine}`;
}

/** The owner's Chrome endpoint, or null when remote debugging is off. */
export function readUserChromeEndpoint(dataDir: string = userChromeDataDir()): string | null {
  let fd: number;
  try { fd = openSync(join(dataDir, "DevToolsActivePort"), constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)); }
  catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 512) return null;
    const buffer = Buffer.alloc(stat.size);
    readSync(fd, buffer, 0, stat.size, 0);
    return userChromeEndpointFromPortFile(buffer.toString("utf8"));
  } catch { return null; } finally { closeSync(fd); }
}

/** A CDP target this module could have produced: loopback browser WebSocket only. */
export function isUserChromeEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^ws:\/\/127\.0\.0\.1:([0-9]{1,5})(\/devtools\/browser\/[A-Za-z0-9-]{1,128})$/u.exec(value);
  return !!match && Number(match[1]) >= 1 && Number(match[1]) <= 65_535;
}

/** Why a "Use my Chrome" browser call failed, in the owner's terms.
 * - "off": no DevToolsActivePort, or nothing listens on its port: remote
 *   debugging was turned off or Chrome is closed (0.1.60 Linux D11).
 * - "allow": Chrome is listening, so it refused or is still waiting for the
 *   owner to Allow the connection (D12). */
export async function userChromeTrouble(dataDir: string = userChromeDataDir(), timeoutMs = 1000, cacheMs = USER_CHROME_TROUBLE_CACHE_MS): Promise<"off" | "allow"> {
  // The panel polls every second; one TCP probe per few seconds says the same.
  const cached = troubleCache.get(dataDir);
  if (cached && Date.now() - cached.at < cacheMs) return cached.value;
  const value = await probeUserChrome(dataDir, timeoutMs);
  troubleCache.set(dataDir, { at: Date.now(), value });
  return value;
}
/** How long one userChromeTrouble answer is reused. */
export const USER_CHROME_TROUBLE_CACHE_MS = 5000;
const troubleCache = new Map<string, { at: number; value: "off" | "allow" }>();
/** Tests only: forget the cached probe answers. */
export function resetUserChromeTroubleCache() { troubleCache.clear(); }
async function probeUserChrome(dataDir: string, timeoutMs: number): Promise<"off" | "allow"> {
  const endpoint = readUserChromeEndpoint(dataDir);
  if (!endpoint) return "off";
  const port = Number(new URL(endpoint).port);
  const listening = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
  return listening ? "allow" : "off";
}

/** How long a "Use my Chrome" connection waits for the owner's Allow. */
export const USER_CHROME_ALLOW_WAIT_MS = 120_000;

/** Where "Use my Chrome" goes, decided by the server when the owner confirms it.
 * - "extension": Murage for Chrome has a connected Chrome profile. No Allow prompt.
 * - "remote-debugging": no paired extension, but Chrome's remote debugging is on.
 * - "install": neither. The extension panel shows how to add Murage for Chrome
 *   and connects by itself once it pairs. */
export type UseMyChromeRoute = { route: "extension" | "install"; transport: "extension"; profileId?: string } | { route: "remote-debugging"; transport: undefined };
export function useMyChromeRoute(profiles: ReadonlyArray<{ profileId: string; browser?: string }>, remoteDebugging: "listening" | "off"): UseMyChromeRoute {
  const paired = pairedExtensionProfile(profiles);
  if (paired.ready) return { route: "extension", transport: "extension", ...(paired.profileId ? { profileId: paired.profileId } : {}) };
  if (remoteDebugging === "listening") return { route: "remote-debugging", transport: undefined };
  return { route: "install", transport: "extension" };
}
/** Murage for Chrome is connected in at least one Chrome profile ("Use my
 * Chrome" never lands in a profile that says it is Edge or Brave). The
 * extension names itself "chromium" in every browser it runs in (it cannot
 * tell them apart), and the owner's Connect registered its helper for Google
 * Chrome, so "chromium" counts as Chrome. The profile is named only when there
 * is exactly one; otherwise the extension panel asks which. */
export function pairedExtensionProfile(profiles: ReadonlyArray<{ profileId: string; browser?: string }>): { ready: boolean; profileId?: string } {
  const chrome = profiles.filter((profile) => ["chrome", "chromium"].includes((profile.browser ?? "").toLowerCase()));
  return { ready: chrome.length > 0, ...(chrome.length === 1 ? { profileId: chrome[0]!.profileId } : {}) };
}
/** Is the owner's Chrome listening for remote debugging right now (uncached)? */
export async function userChromeListening(dataDir: string = userChromeDataDir(), timeoutMs = 1000): Promise<"listening" | "off"> {
  return (await probeUserChrome(dataDir, timeoutMs)) === "allow" ? "listening" : "off";
}
/** One server.log line per "Use my Chrome" attach step. Only fixed words and a
 * duration: never the endpoint, a URL, a tab title or anything from a page. */
export type UserChromeAttachEvent = "start" | "waiting-allow" | "connected" | "failed" | "chrome-waiting" | "chrome-allowed" | "chrome-closed";
export function userChromeAttachLog(event: UserChromeAttachEvent, ms?: number, reason?: "off" | "allow" | "engine" | "timeout" | "guard"): string {
  return `[browser] user-chrome attach ${event}${ms === undefined ? "" : ` (${Math.max(0, Math.round(ms))} ms${reason ? `, ${reason}` : ""})`}`;
}
/** "Use my Chrome" binds, one at a time per bot. `forget` moves the bot to a new
 * generation; a bind that awaited across it sees `current()` turn false, so it
 * closes what it opened and never publishes a connection to the owner's Chrome
 * after a transport switch, opt-out, deletion or Chrome restart. */
export class UserChromeBinds<T> {
  private readonly running = new Map<string, Promise<T>>();
  private readonly generations = new Map<string, number>();
  run(botId: string, bind: (current: () => boolean) => Promise<T>): Promise<T> {
    const already = this.running.get(botId);
    if (already) return already;
    const generation = this.generations.get(botId) ?? 0;
    const current = () => (this.generations.get(botId) ?? 0) === generation;
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
    const started = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
    // Recorded before the bind runs: when the bind itself forgets (Chrome
    // restarted) and binds again, that forget clears this entry and the new run
    // starts fresh instead of waiting on the run it was started from.
    this.running.set(botId, started);
    const done = () => { if (this.running.get(botId) === started) this.running.delete(botId); };
    started.then(done, done);
    try { resolve(bind(current)); } catch (error) { reject(error); }
    return started;
  }
  forget(botId: string) {
    this.generations.set(botId, (this.generations.get(botId) ?? 0) + 1);
    // A later bind starts fresh; the overtaken one still settles (and refuses) on its own.
    this.running.delete(botId);
  }
}
