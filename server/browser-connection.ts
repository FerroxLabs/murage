// How the harness finds the built-in browser. Electron main owns the browser
// views and a loopback host in front of them; it writes where that host
// listens and a per-boot secret to a descriptor file, exactly like the Cua
// daemon's cua-connection.json. The server reads it when a turn mounts the
// browser tools and hands the two values to the proxy — the server itself
// never proxies browser actions.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export interface BrowserConnection {
  /** http://127.0.0.1:<port> — loopback only, by construction and by check. */
  url: string;
  /** 64 hex characters minted per Electron boot. */
  token: string;
}

const descriptorSchema = z.object({
  version: z.literal(1),
  url: z.string().url(),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  pid: z.number().int().positive(),
}).strict();

function loopbackOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) return null;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  return url.origin;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else — for a
    // descriptor in the user's own userData that still means "alive".
    // SAFETY: process.kill rejects with a Node errno error; only `code` is
    // read, and any other shape simply fails the equality below.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** A descriptor becomes a connection only when its host is a loopback origin
 * and the Electron process that wrote it is still running — a stale file from
 * a previous boot must never send a bot's actions to a recycled port. */
export function decodeBrowserDescriptor(raw: unknown, alive: (pid: number) => boolean = processAlive): BrowserConnection | null {
  const parsed = descriptorSchema.safeParse(raw);
  if (!parsed.success) return null;
  const origin = loopbackOrigin(parsed.data.url);
  if (!origin) return null;
  if (!alive(parsed.data.pid)) return null;
  return { url: origin, token: parsed.data.token };
}

export function readBrowserConnection({
  platform = process.platform,
  userData = process.env.OMB_USER_DATA,
  home = homedir(),
  file = process.env.OMB_BROWSER_CONNECTION,
  alive,
}: {
  platform?: NodeJS.Platform;
  userData?: string;
  home?: string;
  /** Explicit descriptor path — tests and dev rigs. */
  file?: string;
  alive?: (pid: number) => boolean;
} = {}): BrowserConnection | null {
  const candidates = file ? [file] : [];
  if (!file) {
    if (userData) candidates.push(join(userData, "browser-connection.json"));
    if (platform === "darwin") {
      // Dev fallback (Electron and the dev server are separate processes);
      // the packaged app passes its exact userData path.
      for (const directory of ["OpenMausBot", "openmausbot"]) {
        candidates.push(join(home, "Library", "Application Support", directory, "browser-connection.json"));
      }
    }
  }
  for (const candidate of new Set(candidates)) {
    try {
      const decoded = decodeBrowserDescriptor(JSON.parse(readFileSync(candidate, "utf8")), alive);
      if (decoded) return decoded;
    } catch {
      // missing or unreadable: the next candidate, then "unavailable"
    }
  }
  return null;
}

const screenshotSchema = z.object({ png: z.string().min(1), format: z.string().optional() });

/** One frame of a bot's browser for the preview pipeline (SSE `screen`
 * frames and the settled transcript picture). */
export async function browserScreenshot(
  connection: BrowserConnection,
  botId: string,
  fetchImpl: typeof fetch = fetch,
  profile = "",
): Promise<{ png: string; format: string }> {
  const res = await fetchImpl(`${connection.url}/v1/bots/${encodeURIComponent(botId)}/screenshot`, {
    method: "POST",
    headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
    body: JSON.stringify({ profile }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`browser screenshot: HTTP ${res.status}`);
  const body = screenshotSchema.parse(await res.json());
  return { png: body.png, format: body.format ?? "jpeg" };
}
