// What a customer needs out of a vendor CLI's sign-in screen: the page to open and the one-time code. Nothing else of the raw
// output is ever shown (the IPv6 and nameserver lines, "could not open browser", the warnings). Pure text in, facts out; no
// Cloud, no DOM, so the desktop can use it as it is. The raw screen stays one click away under "Details" for support.
//
// What the pinned CLIs really print (captured 2026-11-01 on the build box):
//   Codex  "1. Open this link ... https://auth.openai.com/codex/device" then "2. Enter this one-time code ... SOKN-ZVOHN"
//   Grok   "https://accounts.x.ai/oauth2/device?user_code=67SE-48EK" then "Confirm this code in your browser: 67SE-48EK"
//   Claude "Opening browser to sign in", the link once as an OSC 8 hyperlink and once plain, then "Paste code here if prompted >"
//   Kimi   "https://www.kimi.ai/code/authorize_device?user_code=..." (measured 2026-10-15, same device shape as Grok)
import { checkAuthUrl } from "@/lib/engine-login-terminal";

export interface SignInFacts { url?: string; code?: string }

// CSI sequences, OSC sequences (an OSC 8 hyperlink carries the URL a second time), and lone escapes.
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const URL_AT = /https:\/\/[^\s"'<>\u0000-\u001f\u007f]+/g;
const TRAILING = /[.,;:!?)\]}]+$/;
/** A device code such as SOKN-ZVOHN or 67SE-48EK. */
const DEVICE_CODE = /\b[A-Z0-9]{3,6}-[A-Z0-9]{3,6}\b/;
/** A code with no hyphen, on a line that says "code" (Kimi prints one). It must hold a digit, so a word in capitals is not taken. */
const PLAIN_CODE = /\b(?=[A-Z0-9]*\d)[A-Z0-9]{6,10}\b/;

export const stripEscapes = (text: string): string => text.replace(ESCAPES, "").replace(/\r/g, "");

/** The first allow-listed https link, joining one the CLI broke across lines (a continuation with no spaces). */
function findUrl(lines: string[]): string | undefined {
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i]!.indexOf("https://");
    if (at < 0) continue;
    let text = lines[i]!.slice(at).trimEnd();
    const candidates: string[] = [text];
    for (let j = i + 1; j < lines.length && j < i + 8; j++) {
      const next = lines[j]!.trim();
      if (next === "" || /\s/.test(next) || next.startsWith("http") || next.startsWith(">") || /\s/.test(text.slice(text.lastIndexOf("https://")))) break;
      text += next;
      candidates.unshift(text);
    }
    for (const candidate of candidates) {
      const raw = (candidate.match(URL_AT)?.[0] ?? "").replace(TRAILING, "");
      const url = raw ? checkAuthUrl(raw) : null;
      if (url) return url;
    }
  }
  return undefined;
}

export function parseSignIn(raw: string): SignInFacts {
  const lines = stripEscapes(raw).split("\n");
  const url = findUrl(lines);
  const prose = lines.map((line) => line.replace(URL_AT, " ")).filter((line) => !/IPv6|nameserver/i.test(line));
  let code: string | undefined;
  for (const line of prose) { code = line.match(DEVICE_CODE)?.[0]; if (code) break; }
  if (!code) for (const line of prose) { if (/code/i.test(line)) { code = line.match(PLAIN_CODE)?.[0]; if (code) break; } }
  return { ...(url ? { url } : {}), ...(code ? { code } : {}) };
}

/** The address to show a person: the page without its query, so a long or code-carrying link reads as a plain address. */
export function displayAddress(url: string): string {
  try { const u = new URL(url); return `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`; } catch { return url; }
}

/** The raw text kept for parsing: the last part only, so a long-lived session cannot grow it without end. */
export const KEEP_CHARS = 24_000;
export const keepTail = (text: string): string => (text.length > KEEP_CHARS ? text.slice(text.length - KEEP_CHARS) : text);
