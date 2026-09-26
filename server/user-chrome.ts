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
export async function userChromeTrouble(dataDir: string = userChromeDataDir(), timeoutMs = 1000): Promise<"off" | "allow"> {
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
