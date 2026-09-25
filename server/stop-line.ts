// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The stop line: the three kinds of action Full access still stops before.
//
// Full access is meant to be fast, so it approves almost everything. The owner
// decided it must still stop before three kinds of action, and that the line
// is drawn by WHAT the action touches, not by which command spells it:
//
//   - Deleting outside the folder the bot works in (its turn folder, its own
//     Murage workspace and thread folder, temp). Deleting inside it, including
//     build output and caches, goes ahead. Also: deleting mail, files or
//     records through a connected app, dropping or emptying a database table,
//     irreversible git (force push, remote branch delete, reset --hard), and
//     wiping a disk.
//   - Paying: charges, payouts, refunds, purchases and transfers, through a
//     connected app or a shell call to a payment API.
//   - Messaging a new person or group, or posting anything public. Replies in
//     an existing conversation and messages to someone the bot has already
//     written to go ahead.
//
// This is a classifier, not a sandbox. It reads the engine's STRUCTURED tool
// input (falling back to the card text only for a shell command the engine
// reported no input for), and wherever it cannot tell where an action lands it
// answers "stop": an unknown target, an unparseable shell line that contains a
// delete verb, a message with no readable recipient. The cost of a wrong stop
// is one card; the cost of a wrong pass is the thing the owner asked us to
// catch. It is pure: every fact about the machine (the folders, the home
// folder, the recipients the bot has written to, how links resolve) is passed
// in, so it is table-tested without touching a disk.
import { posix } from "node:path";

export type StopKind = "delete" | "pay" | "message";

export interface StopHit {
  kind: StopKind;
  /** Where the action lands, canonical: a folder path for a delete outside the
   * working folder, `git:<repo>`, `sql:<tool>`, `app:<app>`, a recipient list
   * or `public:<app>` for a message, `<app>:<payee>` for a payment. Absent when
   * it could not be pinned down, and then no "for this task" or "always" grant
   * can be offered: only "Allow once". */
  place?: string;
  /** The card's plain-words line: what the bot is about to do, and why it
   * stopped. Never an em dash; read by the owner. */
  what: string;
  /** Everyone a message goes to, normalized, so an approved send can be
   * remembered and the next message to them is not "new". */
  recipients?: string[];
}

export interface StopLinePlace {
  /** The folder the turn runs in. Undefined means relative paths cannot be
   * placed, which stops any relative delete. */
  cwd?: string;
  /** Every folder the bot may delete inside: the turn folder, its own
   * workspace and thread folder, temp. Too-broad entries (a disk root, the
   * home folder, Documents and friends) are ignored here, not trusted. */
  roots: readonly string[];
  home: string;
  /** Recipients this bot has already sent to, or that the conversation
   * itself belongs to, normalized with `normalizeRecipient`. */
  knownRecipients: ReadonlySet<string>;
  /** Optional: resolve links for an absolute path (the deepest existing
   * ancestor). Without it the check is lexical only. */
  realpath?: (path: string) => string;
  /** Optional: the GitHub `owner/repo` a folder's origin remote points at,
   * for a `gh` post that names no `--repo`. */
  repoOf?: (dir: string) => string | undefined;
}

// ── shared vocabulary ─────────────────────────────────────────────────

/** Murage's own MCP servers. Their tools are the product's bookkeeping or
 * already carry their own approval (bot-to-bot contact, the computer), and
 * are never "a connected app" for this line. */
const MURAGE_SERVERS = new Set(["murage-memory", "agents", "muragebox", "computer", "browser", "phone", "dweb"]);

const COMMAND_TOOLS = new Set(["bash", "shell", "execute", "exec_command", "run_command", "computer_exec", "terminal", "run_shell_command", "run_terminal_cmd"]);

const PAYMENT_APPS = /^(stripe|paypal|square|squareup|braintree|adyen|wise|transferwise|venmo|cashapp|coinbase|plaid|revolut|mollie|razorpay|gocardless|klarna|paddle|lemonsqueezy|chargebee|recurly|mercury|brex|ramp)$/;
const PUBLIC_APPS = /^(twitter|x|linkedin|facebook|instagram|reddit|mastodon|bluesky|bsky|threads|tiktok|youtube|medium|wordpress|ghost|substack|tumblr|pinterest|producthunt|devto|hashnode)$/;

const PAYMENT_HOSTS = /(^|\.)(api\.stripe\.com|api(-m)?\.(sandbox\.)?paypal\.com|connect\.squareup\.com|api\.squareup\.com|api\.braintreegateway\.com|api\.(sandbox\.)?transferwise\.com|api\.wise\.com|api\.coinbase\.com|adyen\.com|adyenpayments\.com|api\.razorpay\.com|api\.mollie\.com|api\.gocardless\.com|api\.paddle\.com)$/i;
const MESSAGE_URLS = /slack\.com\/api\/chat\.|hooks\.slack\.com|api\.telegram\.org\/.*\/send|discord(app)?\.com\/api\/(webhooks|.*\/messages)|api\.(twitter|x)\.com\/.*tweets|graph\.facebook\.com|api\.linkedin\.com\/.*(posts|ugcposts|shares)|api\.sendgrid\.com\/v3\/mail|api\.mailgun\.net|api\.postmarkapp\.com\/email|api\.resend\.com\/emails|api\.twilio\.com\/.*messages|graph\.microsoft\.com\/.*(sendmail|messages)|gmail\.googleapis\.com\/.*send|\/api\/v1\/statuses|xrpc\/com\.atproto\.repo\.createrecord/i;

const SQL_DESTRUCTIVE = /\bDROP\s+(TABLE|DATABASE|SCHEMA|VIEW|COLLECTION)\b|\bTRUNCATE\s+(TABLE\s+)?[`"\w]|\bDELETE\s+FROM\b|\bFLUSH(ALL|DB)\b|\.dropDatabase\s*\(/i;

/** A delete through code rather than a delete command. */
const CODE_DELETE = /\b(rmtree|rmSync|rmdirSync|unlinkSync|os\.remove|os\.unlink|os\.rmdir|shutil\.rmtree|fs\.rm|fs\.unlink|fs\.promises\.(rm|unlink)|FileUtils\.rm(_rf|_r|_f)?|File\.delete|Remove-Item|send2trash|trashItem|removeItem|recycleURLs|rimraf|unlink|rmdir)\b|\.unlink\(/;
/** AppleScript or JXA deleting something: Finder's `delete`, `move … to
 * trash`, emptying the Trash, System Events' `delete`, JXA `.delete()`. */
const APPLESCRIPT_DELETE = /\bdelete\b|\bmove\b[\s\S]*\bto\s+(the\s+)?trash\b|\bempty\s+(the\s+)?trash\b|\.delete\s*\(|trashItem|removeItem|recycleURLs/i;

/** Folder names that are never "the folder the bot works in", however it was
 * set: they ARE the owner's own files. */
const PERSONAL_TOP = new Set(["Documents", "Desktop", "Downloads", "Pictures", "Movies", "Music", "Library", "Public", "iCloud Drive", "OneDrive", "Dropbox"]);

/** The same on Windows, compared without case, plus its own personal folders. */
const WIN_PERSONAL_TOP = new Set([...PERSONAL_TOP, "AppData", "Videos", "Favorites", "Contacts", "Links", "Saved Games", "Searches", "3D Objects"].map((name) => name.toLowerCase()));

const words = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const READ_VERBS = new Set(["list", "get", "retrieve", "search", "read", "fetch", "find", "describe", "view", "show", "count", "lookup", "check", "preview", "download", "export"]);

// ── paths ─────────────────────────────────────────────────────────────

// Windows paths are read in one canonical form, so the rest of this file can
// stay POSIX: `C:\Users\ada` is `/C:/Users/ada` and `\\server\share` is
// `/UNC/server/share`. Keys keep this form; the card shows the Windows one.
const WIN_ABS = /^[A-Za-z]:(?:[\\/]|$)/;
const WIN_CANON = /^\/(?:[A-Z]:|UNC)(?:\/|$)/;

function canonPath(path: string): string {
  if (WIN_ABS.test(path)) return `/${path[0]!.toUpperCase()}:${path.slice(2).replace(/\\/g, "/")}`;
  if (/^\\\\[^\\]/.test(path)) return `/UNC/${path.slice(2).replace(/\\/g, "/")}`;
  return path;
}

/** The machine's own spelling of a canonical path, for a resolver that
 * touches the disk. POSIX paths are returned unchanged. */
function nativePath(path: string): string {
  if (/^\/[A-Z]:(\/|$)/.test(path)) return `${path.slice(1, 3)}\\${path.slice(4).replace(/\//g, "\\")}`;
  if (/^\/UNC\//.test(path)) return `\\\\${path.slice(5).replace(/\//g, "\\")}`;
  return path;
}

const clean = (path: string) => posix.normalize(canonPath(path)).replace(/(.)\/+$/, "$1");
/** Windows paths compare without regard to letter case. */
const same = (path: string) => (WIN_CANON.test(path) ? path.toLowerCase() : path);

function isTooBroad(root: string, home: string): boolean {
  const r = clean(root);
  if (r === "/" || same(r) === same(clean(home))) return true;
  if (/^\/(Users|home|Volumes|mnt|media|private|var|System|Applications|opt|usr|etc)$/.test(r)) return true;
  if (/^\/Volumes\/[^/]+$/.test(r)) return true;
  if (/^\/[A-Z]:$/.test(r) || /^\/UNC(\/[^/]+){0,2}$/.test(r)) return true;
  if (/^\/[A-Z]:\/(Users|Windows|Program Files|Program Files \(x86\)|ProgramData)$/i.test(r)) return true;
  const h = same(clean(home));
  const rel = same(r).startsWith(`${h}/`) ? r.slice(h.length + 1) : undefined;
  return rel !== undefined && !rel.includes("/") && (PERSONAL_TOP.has(rel) || (WIN_CANON.test(r) && WIN_PERSONAL_TOP.has(rel.toLowerCase())));
}

function within(root: string, target: string): boolean {
  const r = same(clean(root)), t = same(clean(target));
  return t.startsWith(r === "/" ? "/" : `${r}/`) && t !== r;
}

function tildeOf(path: string, home: string): string {
  const h = clean(home);
  return same(path) === same(h) ? "~" : same(path).startsWith(`${same(h)}/`) ? `~${path.slice(h.length)}` : path;
}

/** A path as the owner would write it on this machine, for the card. */
function shownPath(path: string, home: string): string {
  const shown = tildeOf(path, home);
  if (!WIN_CANON.test(clean(home)) && !WIN_CANON.test(path)) return shown;
  return shown.startsWith("~") ? shown.replace(/\//g, "\\") : nativePath(shown);
}

interface Target {
  /** absolute, cleaned; undefined = could not be placed */
  path?: string;
  /** the literal text, for the card */
  text: string;
  /** a glob: the path is the literal directory the glob expands inside */
  glob?: boolean;
}

/** Turn one shell word into a place on disk. `$HOME`, `~` and `$PWD` are
 * understood; any other expansion is an unknown place. */
function resolveWord(word: Word, cwd: string | undefined, home: string): Target {
  const text = word.text;
  if (word.dynamic) {
    const m = /^(?:\$HOME|\$\{HOME\}|~)(\/.*)?$/.exec(text) ?? undefined;
    const pwd = /^(?:\$PWD|\$\{PWD\})(\/.*)?$/.exec(text) ?? undefined;
    if (m && !/[$`]/.test(m[1] ?? "")) return globTarget(`${home}${m[1] ?? ""}`, text);
    if (pwd && cwd && !/[$`]/.test(pwd[1] ?? "")) return globTarget(`${cwd}${pwd[1] ?? ""}`, text);
    return { text };
  }
  const windows = WIN_CANON.test(home);
  let raw = text;
  if (raw === "~" || raw.startsWith("~/") || (windows && raw.startsWith("~\\"))) raw = `${home}${raw.slice(1)}`;
  else if (raw.startsWith("~")) return { text }; // ~otheruser
  if (windows) {
    // a drive-relative path (`C:notes.txt`) depends on that drive's own
    // current folder, which is not known here
    if (/^[A-Za-z]:(?![\\/])/.test(raw)) return { text };
    raw = canonPath(raw).replace(/\\/g, "/");
    // `\temp\x` is on the current folder's drive
    if (raw.startsWith("/") && !WIN_CANON.test(raw)) {
      const drive = cwd && /^\/[A-Z]:/.exec(cwd)?.[0];
      if (!drive) return { text };
      raw = `${drive}${raw}`;
    }
  }
  if (!posix.isAbsolute(raw)) {
    if (!cwd) return { text };
    raw = posix.join(cwd, raw);
  }
  return globTarget(raw, text);
}

function globTarget(absolute: string, text: string): Target {
  const parts = clean(absolute).split("/");
  const firstGlob = parts.findIndex((part) => /[*?[]/.test(part));
  if (firstGlob === -1) return { path: clean(absolute), text };
  return { path: clean(parts.slice(0, firstGlob).join("/") || "/"), text, glob: true };
}

// ── shell ─────────────────────────────────────────────────────────────

interface Word {
  text: string;
  /** holds an unquoted-or-double-quoted `$` or a backtick: its value is not
   * knowable from the text */
  dynamic: boolean;
  /** A here-doc body, carried on the command that reads it as its input.
   * Never an operand: `cat > f <<EOF` names f, not the text. */
  heredoc?: true;
}

/** Programs that only read a here-doc as data: the body is the text going
 * into a file or a pipe, and nothing in it runs. Shells are here too,
 * because shellHit judges their body itself, as the line it is. */
const HEREDOC_DATA = /^(cat|tee|head|tail|wc|sort|uniq|grep|egrep|fgrep|rg|jq|yq|pbcopy|base64|sed|awk|cut|tr|column|fold|less|more|diff|printf|echo|git|gh)$/;
const SHELLS = /^(ba|z|da|k|fi)?sh$/;

/** Split a shell line into simple commands of words. Deliberately small: it
 * understands quotes and the usual separators, and marks anything it cannot
 * know (expansion, substitution) instead of guessing. `complex` is set when
 * the line uses syntax this does not model (subshells, here-docs, braces). */
function splitShell(line: string): { commands: Word[][]; complex: boolean; scan: string } {
  const commands: Word[][] = [];
  // Here-docs waiting for the end of their line, and every body read, with
  // the command that reads it, so `scan` can leave out the bodies that are
  // only data.
  let pendingDocs: Array<{ delim: string; dash: boolean; quoted: boolean; owner: Word[] }> = [];
  const bodies: Array<{ start: number; end: number; owner: Word[] }> = [];
  let current: Word[] = [];
  let word = "";
  let dynamic = false;
  let inWord = false;
  let complex = false;
  let quote: "'" | '"' | undefined;
  let skipNext = false;
  const endWord = () => {
    if (inWord) {
      if (skipNext) skipNext = false;
      else current.push({ text: word, dynamic });
    }
    word = "";
    dynamic = false;
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    skipNext = false;
    if (current.length) commands.push(current);
    current = [];
  };
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      else {
        if (quote === '"' && (ch === "$" || ch === "`")) dynamic = true;
        if (quote === '"' && ch === "\\" && i + 1 < line.length) { word += line[++i]; continue; }
        word += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; inWord = true; continue; }
    if (ch === "\\" && i + 1 < line.length) { word += line[++i]; inWord = true; continue; }
    if (ch === " " || ch === "\t") { endWord(); continue; }
    if (ch === "\n" && pendingDocs.length) {
      // THE BODY IS THE COMMAND'S INPUT, NOT MORE COMMANDS. Split on its
      // newlines, a ledger note saying "not moved to trash" or "Sean's" was
      // judged line by line as shell and read as a delete nobody could place.
      endCommand();
      let at = i + 1;
      for (const doc of pendingDocs) {
        const start = at;
        let end = line.length;
        let next = line.length;
        while (at <= line.length) {
          const nl = line.indexOf("\n", at);
          const stop = nl === -1 ? line.length : nl;
          const text = line.slice(at, stop);
          if ((doc.dash ? text.replace(/^\t+/, "") : text) === doc.delim) { end = at; next = stop; break; }
          if (nl === -1) { at = line.length + 1; break; }
          at = nl + 1;
        }
        const body = line.slice(start, Math.max(start, end - 1));
        doc.owner.push({ text: body, dynamic: !doc.quoted && /[$`]/.test(body), heredoc: true });
        bodies.push({ start, end: next, owner: doc.owner });
        at = next + 1;
      }
      pendingDocs = [];
      i = at - 2;
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "|" || ch === "&") { endCommand(); continue; }
    if (ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      // `$(`…`)` is a substitution inside a word; a bare paren is a subshell
      if (ch === "(" && word.endsWith("$")) { dynamic = true; word += ch; inWord = true; continue; }
      if (ch === ")" && dynamic && inWord) { word += ch; continue; }
      if (ch === "{" && word.endsWith("$")) { word += ch; inWord = true; continue; }
      if (ch === "}" && inWord && word.includes("${")) { word += ch; continue; }
      if (inWord && (ch === "{" || ch === "}")) { word += ch; continue; }
      complex = true;
      endCommand();
      continue;
    }
    if (ch === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
      // a here-doc: read its delimiter now, its body at the end of the line
      complex = true;
      endWord();
      let j = i + 2;
      const dash = line[j] === "-";
      if (dash) j += 1;
      while (line[j] === " " || line[j] === "\t") j += 1;
      let delim = "";
      let quoted = false;
      const q = line[j];
      if (q === "'" || q === '"') {
        quoted = true;
        const close = line.indexOf(q, j + 1);
        delim = line.slice(j + 1, close === -1 ? line.length : close);
        j = close === -1 ? line.length : close + 1;
      } else {
        while (j < line.length && !/[\s;&|<>()]/.test(line[j]!)) {
          if (line[j] === "\\" || line[j] === "'" || line[j] === '"') quoted = true;
          else delim += line[j];
          j += 1;
        }
      }
      if (delim) pendingDocs.push({ delim, dash, quoted, owner: current });
      i = j - 1;
      continue;
    }
    if (ch === "<" || ch === ">") {
      if (ch === "<" && line[i + 1] === "<") complex = true; // here-string
      // a redirect is not an operand: drop its fd number (`2>`) and the file
      // it names (`> out.log`, `2>/dev/null`, `>&2`)
      if (inWord && /^\d+$/.test(word)) { word = ""; inWord = false; }
      endWord();
      while (line[i + 1] === ">" || line[i + 1] === "<" || line[i + 1] === "&" || line[i + 1] === "|") i += 1;
      while (line[i + 1] === " " || line[i + 1] === "\t") i += 1;
      if (line[i] === "&" && /\d/.test(line[i + 1] ?? "")) { while (/\d/.test(line[i + 1] ?? "")) i += 1; continue; }
      skipNext = true;
      continue;
    }
    if (ch === "$" || ch === "`") dynamic = true;
    word += ch;
    inWord = true;
  }
  if (quote) complex = true;
  endCommand();
  // What the whole-line checks read: the line without the bodies that are
  // only data (or that shellHit judges as a line of their own). A body fed
  // to python, node, osascript or a database client stays: it is code.
  let scan = "";
  let from = 0;
  for (const body of bodies) {
    const name = program(body.owner.filter((word) => !word.heredoc))?.name ?? "";
    if (!HEREDOC_DATA.test(name) && !SHELLS.test(name)) continue;
    scan += line.slice(from, body.start);
    from = body.end;
  }
  scan += line.slice(from);
  return { commands, complex, scan };
}

const PREFIXES = new Set(["sudo", "doas", "command", "builtin", "nohup", "time", "nice", "exec", "env", "timeout", "caffeinate", "rtk", "stdbuf", "unbuffer", "ionice", "chronic"]);

/** Strip wrappers (`sudo`, `env X=1`, `timeout 5`) down to the real program. */
function program(cmd: Word[]): { name: string; args: Word[] } | undefined {
  let i = 0;
  while (i < cmd.length) {
    const w = cmd[i]!.text;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i += 1; continue; }
    const base = w.split("/").pop()!;
    if (PREFIXES.has(base)) {
      i += 1;
      // `rtk proxy <cmd>` is `<cmd>` run through the token proxy
      if (base === "rtk" && cmd[i]?.text === "proxy") i += 1;
      // their own options and a timeout's duration
      while (i < cmd.length && (cmd[i]!.text.startsWith("-") || (base === "timeout" && /^\d/.test(cmd[i]!.text)))) i += 1;
      continue;
    }
    break;
  }
  if (i >= cmd.length) return undefined;
  return { name: cmd[i]!.text.split("/").pop()!.replace(/\.exe$/i, ""), args: cmd.slice(i + 1) };
}

function operands(args: Word[]): Word[] {
  const out: Word[] = [];
  let endOfOptions = false;
  for (const a of args) {
    if (a.heredoc) continue;
    if (!endOfOptions && a.text === "--") { endOfOptions = true; continue; }
    if (!endOfOptions && a.text.startsWith("-") && a.text !== "-") continue;
    out.push(a);
  }
  return out;
}

interface Collected {
  deletes: Target[];
  /** a delete verb whose target could not be read at all */
  unknownDelete?: string;
  other?: StopHit;
}

/** Substitute `$NAME` / `${NAME}` from simple assignments seen earlier in
 * the line. A word stays dynamic while anything unknown is left in it
 * (another variable, `$(…)`, a backtick). */
function expand(word: Word, vars: ReadonlyMap<string, string>): Word {
  if (!word.dynamic) return word;
  let unknown = false;
  const text = word.text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced: string | undefined, bare: string | undefined) => {
    const value = vars.get((braced ?? bare)!);
    if (value === undefined) { unknown = true; return whole; }
    return value;
  });
  return { text, dynamic: unknown || /[$`]/.test(text) };
}

function shellHit(line: string, place: StopLinePlace, depth = 0): StopHit | null {
  const { commands, complex, scan } = splitShell(line);
  let cwd = place.cwd;
  const found: Collected = { deletes: [] };
  const sql = SQL_DESTRUCTIVE.exec(scan);
  if (sql) return { kind: "delete", place: "sql:shell", what: `Delete database data (${sql[0].trim()}): ${short(line)}` };
  // Simple assignments earlier in the same line (`f="…"; rm "$f"`,
  // `export f=…`) are known values, so a target spelled through one is
  // placed like a literal. Anything else with a `$` stays unknown.
  const vars = new Map<string, string>([["HOME", place.home]]);
  for (const raw of commands) {
    const cmd = raw.map((word) => expand(word, vars));
    const assigning = cmd[0]?.text && /^(export|local|declare|readonly|typeset)$/.test(cmd[0].text) ? cmd.slice(1) : cmd;
    if (assigning.length && assigning.every((word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text))) {
      for (const word of assigning) {
        const eq = word.text.indexOf("=");
        const name = word.text.slice(0, eq);
        if (word.dynamic) vars.delete(name);
        else vars.set(name, word.text.slice(eq + 1));
      }
      continue;
    }
    const prog = program(cmd);
    if (!prog) continue;
    const { name, args } = prog;
    const ops = operands(args);
    // a delete written as code (python -c, node -e, swift, osascript): judged
    // by the literal paths it names, and stopped when it names none
    const script = args.map((word) => word.text).join(" ");
    if (name === "osascript" ? APPLESCRIPT_DELETE.test(script) : /^(python\d*(\.\d+)?|node|nodejs|deno|bun|ruby|perl|php|swift|pwsh|powershell|lua)$/.test(name) && CODE_DELETE.test(script)) {
      if (args.some((word) => word.dynamic)) { found.unknownDelete ??= short(line); continue; }
      const posix = [...script.matchAll(/POSIX\s+file\s+"([^"]+)"/gi)].map((m) => m[1]!);
      const literals = posix.length ? posix : [...script.matchAll(/['"]((?:~|\/|\.\.?\/)[^'"]*)['"]/g)].map((m) => m[1]!);
      if (!literals.length) found.unknownDelete ??= short(line);
      for (const lit of literals) found.deletes.push(resolveWord({ text: lit, dynamic: false }, cwd, place.home));
      continue;
    }
    if (name === "cd") {
      const to = ops[0];
      cwd = !to ? place.home : resolveWord(to, cwd, place.home).path;
      continue;
    }
    // a line handed to another shell is judged as that line
    if (SHELLS.test(name)) {
      const c = args.findIndex((a) => a.text === "-c" || a.text === "-lc" || a.text === "-lic" || a.text === "-ic");
      if (c !== -1 && args[c + 1] && depth < 3) {
        const inner = shellHit(args[c + 1]!.text, { ...place, cwd }, depth + 1);
        if (inner) return inner;
        continue;
      }
      // `bash <<'EOF'`: the body is the script
      const body = args.find((a) => a.heredoc);
      if (body && depth < 3) {
        const inner = shellHit(body.text, { ...place, cwd }, depth + 1);
        if (inner) return inner;
        continue;
      }
    }
    const hit = commandHit(name, args, ops, cwd, place, found, line);
    if (hit) return hit;
  }
  if (found.other) return found.other;
  // a delete through code (python -c, node -e): judged by the literal paths
  // it names, and by nothing at all when it names none
  if (!found.deletes.length && !found.unknownDelete && complex && CODE_DELETE.test(scan)) {
    const literals = [...scan.matchAll(/['"]((?:~|\/|\.\.?\/)[^'"]*)['"]/g)].map((m) => m[1]!);
    if (!literals.length) found.unknownDelete = short(line);
    for (const lit of literals) found.deletes.push(resolveWord({ text: lit, dynamic: false }, cwd, place.home));
  }
  if (complex && !found.unknownDelete && /\b(rm|rmdir|unlink|trash|shred|srm)\b|-delete\b/.test(scan) && !found.deletes.length) {
    found.unknownDelete = short(line);
  }
  return deleteHit(found, place);
}

// ── PowerShell and cmd (Windows) ───────────────────────────────────────
//
// A Windows engine runs its commands in PowerShell, where a backslash is a
// path separator and the backtick is the escape. Read as POSIX shell, a
// `C:\Users\…` path loses its separators and `$p` is never resolved, so the
// card could not say where a delete lands. Same rule as the POSIX reader:
// what it cannot know it marks unknown, and an unknown delete still stops.

/** A `$` from a single-quoted string or an escape: literal, never expanded. */
const LITERAL_DOLLAR = "\u0000";

interface PsCommand {
  words: Word[];
  /** fed by the previous command through `|` */
  piped: boolean;
}

function splitPowerShell(line: string): { commands: PsCommand[]; complex: boolean } {
  const commands: PsCommand[] = [];
  let current: Word[] = [];
  let word = "";
  let dynamic = false;
  let inWord = false;
  let complex = false;
  let quote: "'" | '"' | undefined;
  let skipNext = false;
  let piped = false;
  /** inside a .NET call's argument list: `[IO.File]::Delete(…)` */
  let call = 0;
  let opaqueCall = false;
  const endWord = () => {
    if (inWord) {
      if (skipNext) skipNext = false;
      else current.push({ text: word, dynamic: dynamic || opaqueCall });
    }
    word = "";
    dynamic = false;
    inWord = false;
  };
  const endCommand = (pipeNext: boolean) => {
    endWord();
    skipNext = false;
    if (current.length) commands.push({ words: current, piped });
    piped = current.length ? pipeNext : piped && pipeNext;
    current = [];
  };
  /** `$(…)` taken whole: its value is never known here. */
  const subexpression = (at: number): number => {
    let depth = 0;
    for (let j = at; j < line.length; j += 1) {
      if (line[j] === "(") depth += 1;
      else if (line[j] === ")" && --depth === 0) { word += line.slice(at, j + 1); return j; }
    }
    complex = true;
    word += line.slice(at);
    return line.length;
  };
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === "'" && line[i + 1] === "'") { word += "'"; i += 1; }
      else if (ch === "'") quote = undefined;
      else word += ch === "$" ? LITERAL_DOLLAR : ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"' && line[i + 1] === '"') { word += '"'; i += 1; }
      else if (ch === '"') quote = undefined;
      else if (ch === "`" && i + 1 < line.length) { i += 1; word += line[i] === "$" ? LITERAL_DOLLAR : line[i]; }
      else if (ch === "$" && line[i + 1] === "(") { dynamic = true; word += "$"; i = subexpression(i + 1); }
      else { if (ch === "$") dynamic = true; word += ch; }
      continue;
    }
    if (ch === "@" && (line[i + 1] === '"' || line[i + 1] === "'") && (line[i + 2] === "\n" || line[i + 2] === "\r")) { complex = true; }
    if (ch === "'" || ch === '"') { quote = ch; inWord = true; continue; }
    if (ch === "`" && i + 1 < line.length) { i += 1; word += line[i] === "$" ? LITERAL_DOLLAR : line[i]; inWord = true; continue; }
    if (ch === "#" && !inWord) { while (i + 1 < line.length && line[i + 1] !== "\n") i += 1; continue; }
    if (ch === " " || ch === "\t" || ch === ",") { endWord(); continue; }
    if (ch === "\n" || ch === "\r" || ch === ";") { endCommand(false); continue; }
    if (ch === "|") { if (line[i + 1] === "|") { i += 1; endCommand(false); } else endCommand(true); continue; }
    if (ch === "&") { if (line[i + 1] === "&") i += 1; endCommand(false); continue; }
    if (ch === "$" && line[i + 1] === "(") { dynamic = true; inWord = true; word += "$"; i = subexpression(i + 1); continue; }
    if (ch === "$" && line[i + 1] === "{") {
      const close = line.indexOf("}", i);
      if (close === -1) { complex = true; word += line.slice(i); break; }
      dynamic = true; inWord = true; word += line.slice(i, close + 1); i = close; continue;
    }
    if (ch === "=" && inWord && /^(\[[\w.]+\])?\$[\w:]+$/.test(word)) { endWord(); current.push({ text: "=", dynamic: false }); continue; }
    if (ch === "(") {
      if (call) { call += 1; opaqueCall = true; endWord(); continue; }
      if (inWord && /::\w+$/.test(word)) { endWord(); call = 1; continue; }
      endCommand(false);
      continue;
    }
    if (ch === ")") {
      if (call) { endWord(); call -= 1; if (!call) opaqueCall = false; continue; }
      endCommand(false);
      continue;
    }
    if (ch === "{" || ch === "}") { endCommand(false); continue; }
    if (ch === "<" || ch === ">") {
      if (inWord && /^[\d*]$/.test(word)) { word = ""; inWord = false; }
      endWord();
      while (line[i + 1] === ">" || line[i + 1] === "&") i += 1;
      if (line[i] === "&" && /\d/.test(line[i + 1] ?? "")) { while (/\d/.test(line[i + 1] ?? "")) i += 1; continue; }
      while (line[i + 1] === " " || line[i + 1] === "\t") i += 1;
      skipNext = true;
      continue;
    }
    if (ch === "$") dynamic = true;
    word += ch;
    inWord = true;
  }
  if (quote || call) complex = true;
  endCommand(false);
  return { commands, complex };
}

const PS_VAR = /\$(?:\{([^}]*)\}|(?:(env|global|script|local|private):)?([A-Za-z_]\w*))/gi;

/** Substitute PowerShell variables: ones assigned earlier in the line, the
 * home folder (`$HOME`, `$env:USERPROFILE`, `$env:HOME`) and `$PWD`. A word
 * stays dynamic while anything unknown is left in it. */
function expandPs(word: Word, vars: ReadonlyMap<string, string>, home: string, cwd: string | undefined): Word {
  const restore = (text: string) => text.split(LITERAL_DOLLAR).join("$");
  if (!word.dynamic) return { text: restore(word.text), dynamic: false };
  let unknown = /\$\(/.test(word.text);
  const text = word.text.replace(PS_VAR, (whole, braced: string | undefined, scope: string | undefined, bare: string | undefined) => {
    let name = bare ?? "";
    let env = scope?.toLowerCase() === "env";
    if (braced !== undefined) {
      const m = /^(?:(env|global|script|local|private):)?(.+)$/i.exec(braced);
      env = m?.[1]?.toLowerCase() === "env";
      name = m?.[2] ?? braced;
    }
    const key = name.toLowerCase();
    let value: string | undefined;
    if (env) value = key === "userprofile" || key === "home" ? home : undefined;
    else if (key === "home") value = home;
    else if (key === "pwd") value = cwd;
    else value = vars.get(key);
    if (value === undefined) { unknown = true; return whole; }
    return value;
  });
  return { text: restore(text), dynamic: unknown };
}

const PS_DELETE = new Set(["remove-item", "rm", "del", "erase", "rd", "rmdir", "ri"]);
const PS_PATH_PARAMS = /^-(path|literalpath|lp|pspath|p)$/i;
/** Parameters that take a value that is not a place. */
const PS_VALUE_PARAMS = /^-(filter|include|exclude|erroraction|ea|errorvariable|ev|warningaction|wa|warningvariable|wv|informationaction|infa|informationvariable|iv|outvariable|ov|outbuffer|ob|pipelinevariable|pv|credential|stream|progressaction|proga|depth|attributes|childpath|additionalchildpath)$/i;
const PS_LIST = new Set(["get-childitem", "gci", "ls", "dir", "get-item", "gi"]);
const PS_CD = new Set(["set-location", "sl", "cd", "chdir", "push-location", "pushd"]);
const DOTNET_DELETE = /^\[(system\.)?io\.(file|directory)\]::delete$|^\[(microsoft\.visualbasic\.)?(fileio\.)?filesystem\]::delete(file|directory)$/i;

/** The places a cmdlet names: `-Path`/`-LiteralPath` (also `-Path:x`) and
 * every positional word. An unknown parameter is taken as a switch, so the
 * word after it still counts as a place: a wrong guess stops, never passes. */
function psPaths(args: Word[]): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (!a.dynamic && /^-[A-Za-z]/.test(a.text)) {
      const colon = a.text.indexOf(":");
      if (colon !== -1) {
        const name = a.text.slice(0, colon);
        if (PS_PATH_PARAMS.test(name)) out.push({ text: a.text.slice(colon + 1), dynamic: a.dynamic });
        continue;
      }
      if (PS_PATH_PARAMS.test(a.text)) { if (args[i + 1]) out.push(args[i + 1]!); i += 1; continue; }
      if (PS_VALUE_PARAMS.test(a.text)) { i += 1; continue; }
      continue;
    }
    out.push(a);
  }
  return out;
}

function psValue(args: Word[], names: RegExp): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (!names.test(args[i]!.text)) continue;
    for (let j = i + 1; j < args.length && !/^-[A-Za-z]/.test(args[j]!.text); j += 1) out.push(args[j]!);
  }
  return out;
}

/** `%NAME%` in a cmd line: the home folder and the current folder only. */
function expandCmd(word: Word, home: string, cwd: string | undefined): Word {
  let unknown = word.dynamic;
  const text = word.text.replace(/%([^%\s]+)%/g, (whole, name: string) => {
    const key = name.toLowerCase();
    const value = key === "userprofile" || key === "home" ? home : key === "cd" ? cwd : undefined;
    if (value === undefined) { unknown = true; return whole; }
    return value;
  });
  return { text, dynamic: unknown };
}

/** Split a cmd line: `&`, `&&`, `||`, `|` separate; double quotes group; `^`
 * escapes. */
function splitCmd(line: string): Word[][] {
  const commands: Word[][] = [];
  let current: Word[] = [];
  let word = "";
  let inWord = false;
  let quoted = false;
  const endWord = () => { if (inWord) current.push({ text: word, dynamic: false }); word = ""; inWord = false; };
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) { if (ch === '"') quoted = false; else word += ch; continue; }
    if (ch === '"') { quoted = true; inWord = true; continue; }
    if (ch === "^" && i + 1 < line.length) { word += line[++i]; inWord = true; continue; }
    if (ch === " " || ch === "\t") { endWord(); continue; }
    if (ch === "&" || ch === "|" || ch === "\n" || ch === "\r") {
      endWord();
      if (current.length) commands.push(current);
      current = [];
      if (line[i + 1] === ch) i += 1;
      continue;
    }
    word += ch;
    inWord = true;
  }
  endWord();
  if (current.length) commands.push(current);
  return commands;
}

/** One cmd command (`del /f /q x`, `rd /s /q x`). */
function cmdHit(words: Word[], cwd: string | undefined, place: StopLinePlace, found: Collected, line: string): StopHit | null {
  const cmd = words.map((w) => expandCmd(w, place.home, cwd));
  const name = (cmd[0]?.text ?? "").split(/[\\/]/).pop()!.replace(/\.exe$/i, "").toLowerCase();
  const args = cmd.slice(1);
  if (/^(del|erase|rd|rmdir)$/.test(name)) {
    const targets = args.filter((w) => !/^\/[A-Za-z?]$/.test(w.text));
    if (!targets.length) found.unknownDelete ??= short(line);
    for (const t of targets) {
      if (t.dynamic) found.unknownDelete ??= short(line);
      else found.deletes.push(resolveWord(t, cwd, place.home));
    }
    return null;
  }
  if (!name) return null;
  return commandHit(name, args, operands(args), cwd, place, found, line);
}

function psHit(line: string, place: StopLinePlace, depth = 0): StopHit | null {
  const sql = SQL_DESTRUCTIVE.exec(line);
  if (sql) return { kind: "delete", place: "sql:shell", what: `Delete database data (${sql[0].trim()}): ${short(line)}` };
  const { commands, complex } = splitPowerShell(line);
  let cwd = place.cwd;
  const found: Collected = { deletes: [] };
  const vars = new Map<string, string>();
  const expandAll = (ws: Word[]) => ws.map((w) => expandPs(w, vars, place.home, cwd));
  const addDeletes = (targets: Word[]) => {
    if (!targets.length) { found.unknownDelete ??= short(line); return; }
    for (const t of targets) {
      // an unknown value (a variable never set here, `$_`, `$(…)`) is not a
      // place: the card says so instead of showing the variable's name
      if (t.dynamic) found.unknownDelete ??= short(line);
      else found.deletes.push(resolveWord(t, cwd, place.home));
    }
  };
  let previous: { name: string; paths: Word[] } | undefined;
  for (const { words: raw, piped } of commands) {
    const first = raw[0]?.text.replace(/^\[[\w.]+\]/, "") ?? "";
    const variable = /^\$(?:\{(?:(?:global|script|local|private):)?([^}]+)\}|(?:(?:global|script|local|private):)?([A-Za-z_]\w*))$/i.exec(first);
    if (variable) {
      const name = (variable[1] ?? variable[2]!).toLowerCase();
      vars.delete(name);
      if (raw[1]?.text === "=") {
        const value = expandAll(raw.slice(2));
        if (value.length === 1 && !value[0]!.dynamic) vars.set(name, value[0]!.text);
        else if (/^join-path$/i.test(value[0]?.text ?? "")) {
          const parts = psPaths(value.slice(1)).length ? value.slice(1).filter((w) => !/^-[A-Za-z]/.test(w.text)) : [];
          if (parts.length >= 2 && parts.every((w) => !w.dynamic)) vars.set(name, parts.map((w) => w.text).join("\\"));
        }
      }
      previous = undefined;
      continue;
    }
    const cmd = expandAll(raw);
    let at = 0;
    while (at < cmd.length && (cmd[at]!.text === "." || cmd[at]!.text === "&")) at += 1;
    const head = cmd[at];
    if (!head) continue;
    const name = head.text.split(/[\\/]/).pop()!.replace(/\.exe$/i, "").toLowerCase();
    const args = cmd.slice(at + 1);
    if (/^(set-variable|sv|new-variable|nv|clear-variable|clv|remove-variable|rv)$/.test(name)) { vars.clear(); continue; }
    if (PS_DELETE.has(name)) {
      const paths = psPaths(args);
      if (!paths.length && piped && previous && PS_LIST.has(previous.name)) {
        // `Get-ChildItem <dir> | Remove-Item`: the items under that folder
        const listed = previous.paths.length ? previous.paths : [{ text: ".", dynamic: false }];
        for (const p of listed) {
          if (p.dynamic) { found.unknownDelete ??= short(line); continue; }
          const t = resolveWord(p, cwd, place.home);
          found.deletes.push(/^(get-item|gi)$/.test(previous.name) ? t : { ...t, glob: true });
        }
      } else addDeletes(paths);
    } else if (DOTNET_DELETE.test(name)) {
      addDeletes(args.slice(0, 1));
    } else if (PS_CD.has(name)) {
      const to = psPaths(args)[0];
      cwd = !to ? cwd : to.dynamic ? undefined : resolveWord(to, cwd, place.home).path;
    } else if (name === "cmd") {
      const c = args.findIndex((a) => /^\/[ck]$/i.test(a.text));
      if (c !== -1) {
        const rest = args.slice(c + 1);
        const lines = rest.length === 1 ? splitCmd(rest[0]!.text) : [rest];
        for (const words of lines) {
          const hit = cmdHit(words, cwd, place, found, line);
          if (hit) return hit;
        }
      }
    } else if (/^(powershell|pwsh)$/.test(name)) {
      const c = args.findIndex((a) => /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(a.text));
      if (c !== -1 && args[c + 1] && depth < 3) {
        const inner = psHit(args.slice(c + 1).map((a) => a.text).join(" "), { ...place, cwd }, depth + 1);
        if (inner) return inner;
      }
    } else if (/^(ba|z|da|k|fi)?sh$/.test(name)) {
      const c = args.findIndex((a) => /^-\w*c$/.test(a.text));
      if (c !== -1 && args[c + 1] && depth < 3) {
        const inner = shellHit(args[c + 1]!.text, { ...place, cwd }, depth + 1);
        if (inner) return inner;
      }
    } else if (/^(invoke-restmethod|irm|invoke-webrequest|iwr)$/.test(name)) {
      const method = psValue(args, /^-method$/i)[0]?.text.toUpperCase() ?? "GET";
      const uri = psValue(args, /^-uri$/i)[0]?.text ?? args.find((a) => /^https?:\/\//i.test(a.text))?.text;
      if (uri) found.other ??= httpHit("curl", [{ text: "-X", dynamic: false }, { text: method, dynamic: false }, { text: uri, dynamic: false }]) ?? undefined;
    } else if (name === "send-mailmessage") {
      const recipients = psValue(args, /^-(to|cc|bcc)$/i).map((w) => normalizeRecipient(w.text)).filter((r) => r.includes("@"));
      const hit = messageHit("email", recipients, place, false, `Send an email: ${short(line)}`);
      if (hit) return hit;
    } else if (name === "clear-recyclebin") {
      return { kind: "delete", what: `Empty the Recycle Bin: ${short(line)}` };
    } else if (/^(format-volume|clear-disk|remove-partition|initialize-disk)$/.test(name)) {
      return { kind: "delete", what: `Erase a disk: ${short(line)}` };
    } else {
      const hit = commandHit(name, args, operands(args), cwd, place, found, line);
      if (hit) return hit;
    }
    previous = { name, paths: psPaths(args) };
  }
  if (found.other) return found.other;
  // a delete this reader did not follow: a method on an object
  // (`(Get-Item x).Delete()`), a here-string, text run through Invoke-Expression
  if (!found.deletes.length && !found.unknownDelete) {
    const methodDelete = /\.(Delete|DeleteFile|DeleteDirectory|MoveToRecycleBin)\s*\(/i.test(line);
    const hidden = (complex || /\b(iex|invoke-expression)\b/i.test(line)) && /\b(remove-item|del|erase|rd|rmdir|ri|rm)\b|::delete/i.test(line);
    if (methodDelete || hidden) found.unknownDelete = short(line);
  }
  return deleteHit(found, place);
}

function short(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function commandHit(name: string, args: Word[], ops: Word[], cwd: string | undefined, place: StopLinePlace, found: Collected, line: string): StopHit | null {
  const add = (words: Word[]) => {
    if (!words.length) { found.unknownDelete ??= short(line); return; }
    for (const w of words) found.deletes.push(resolveWord(w, cwd, place.home));
  };
  switch (name) {
    case "rm": case "rmdir": case "unlink": case "trash": case "shred": case "srm": case "del": case "erase": case "rd":
      add(ops);
      return null;
    case "Remove-Item": case "ri":
      add(ops);
      return null;
    case "xargs":
      if (ops.some((w) => /^(rm|rmdir|unlink|trash|shred)$/.test(w.text))) found.unknownDelete ??= short(line);
      return null;
    case "find": {
      const deletes = args.some((a) => a.text === "-delete") ||
        args.some((a, i) => /^-(exec|execdir|ok)$/.test(a.text) && /^(rm|rmdir|unlink|trash|shred)$/.test(args[i + 1]?.text.split("/").pop() ?? ""));
      if (!deletes) return null;
      const starts: Word[] = [];
      for (const a of args) { if (a.text.startsWith("-") || a.text === "!" || a.text === "(") break; starts.push(a); }
      add(starts.length ? starts : [{ text: ".", dynamic: false }]);
      return null;
    }
    case "mv": {
      if (ops.length < 2) return null;
      const dest = ops[ops.length - 1]!;
      const destPath = resolveWord(dest, cwd, place.home).path;
      if (dest.text === "/dev/null" || (destPath && /\/\.Trash(\/|$)/.test(destPath))) add(ops.slice(0, -1));
      return null;
    }
    case "rsync":
      if (args.some((a) => a.text.startsWith("--delete")) && ops.length) add([ops[ops.length - 1]!]);
      return null;
    case "git":
      return gitHit(args, cwd, place, found, line);
    case "gh":
      if (args.some((a) => a.text === "delete") || args.some((a, i) => (a.text === "-X" || a.text === "--method") && /^delete$/i.test(args[i + 1]?.text ?? ""))) {
        return { kind: "delete", place: "app:github", what: `Delete something on GitHub: ${short(line)}` };
      }
      return ghPostHit(args, cwd, place, line);
    case "dd":
      if (args.some((a) => /^of=\/dev\//.test(a.text))) return { kind: "delete", what: `Erase a disk: ${short(line)}` };
      return null;
    case "diskutil":
      if (args.some((a) => /^(erase\w*|zeroDisk|randomDisk|secureErase|partitionDisk|reformat)$/i.test(a.text))) return { kind: "delete", what: `Erase a disk: ${short(line)}` };
      return null;
    case "wipefs": case "format": case "fdisk": case "sgdisk":
      return { kind: "delete", what: `Erase a disk: ${short(line)}` };
    case "curl": case "wget": case "http": case "https": case "xh": case "httpie":
      found.other ??= httpHit(name, args) ?? undefined;
      return null;
    case "stripe": {
      const [resource, action] = ops.map((w) => w.text.toLowerCase());
      const payNouns = /^(charges|payouts|refunds|transfers|payment_intents|subscriptions|invoices|topups)$/;
      if ((resource && payNouns.test(resource) && /^(create|confirm|capture|pay|finalize)$/.test(action ?? "")) ||
        (resource === "post" && /\/v1\/(charges|payouts|refunds|transfers|payment_intents|subscriptions|invoices\/[^/]+\/pay)/.test(action ?? ""))) {
        return { kind: "pay", what: `Make a payment through Stripe: ${short(line)}` };
      }
      return null;
    }
    case "sendmail": case "mail": case "mailx": case "mutt": case "msmtp": {
      const recipients = ops.map((w) => normalizeRecipient(w.text)).filter((r) => r.includes("@"));
      return messageHit(`email`, recipients, place, false, `Send an email: ${short(line)}`);
    }
    default:
      if (/^mkfs(\.\w+)?$/.test(name)) return { kind: "delete", what: `Erase a disk: ${short(line)}` };
      return null;
  }
}

/** `gh` posting in someone's view: an issue, pull request, review, comment
 * or release is public on a public repository, and visible to everyone on
 * the repository either way. It stops the first time per repository; once
 * the owner allowed one, that repository is a known place like a known
 * recipient. A plain `git push` is not a post and is not judged here. */
function ghPostHit(args: Word[], cwd: string | undefined, place: StopLinePlace, line: string): StopHit | null {
  const texts = args.map((a) => a.text);
  const [group, action] = operands(args).map((w) => w.text);
  const posting =
    (group === "issue" && /^(comment|create|new)$/.test(action ?? "")) ||
    (group === "pr" && /^(comment|create|new|review)$/.test(action ?? "")) ||
    (group === "release" && /^(create|new)$/.test(action ?? "")) ||
    (group === "discussion" && /^(create|comment)$/.test(action ?? ""));
  let repo: string | undefined;
  const flag = texts.findIndex((t) => t === "-R" || t === "--repo");
  if (flag !== -1) repo = texts[flag + 1];
  const joined = texts.find((t) => t.startsWith("--repo="));
  if (joined) repo = joined.slice("--repo=".length);
  let apiPost = false;
  if (group === "api") {
    const path = operands(args)[1]?.text ?? "";
    const method = (() => { const i = texts.findIndex((t) => t === "-X" || t === "--method"); return i === -1 ? "" : (texts[i + 1] ?? "").toUpperCase(); })();
    const hasFields = texts.some((t) => /^(-f|-F|--field|--raw-field|--input)$/.test(t));
    apiPost = (method === "POST" || (!method && hasFields)) && /(^|\/)(issues|pulls|comments|releases|reviews|discussions)(\/|$)/.test(path);
    const fromPath = /^\/?repos\/([^/]+\/[^/]+)\//.exec(path)?.[1];
    if (fromPath) repo = fromPath;
  }
  if (!posting && !apiPost) return null;
  repo ??= cwd && place.repoOf ? place.repoOf(cwd) : undefined;
  const where = repo ? `github:${repo.replace(/\.git$/, "").toLowerCase()}` : undefined;
  if (where && place.knownRecipients.has(where)) return null;
  return {
    kind: "message",
    ...(where ? { place: `public:${where}`, recipients: [where] } : {}),
    what: `Post on GitHub${repo ? ` in ${repo}` : ", and Murage cannot tell which repository"}, where others can read it: ${short(line, 100)}`,
  };
}

function gitHit(args: Word[], cwd: string | undefined, place: StopLinePlace, found: Collected, line: string): StopHit | null {
  let i = 0;
  let repo = cwd;
  while (i < args.length && args[i]!.text.startsWith("-")) {
    const flag = args[i]!.text;
    if (flag === "-C" && args[i + 1]) { repo = resolveWord(args[i + 1]!, cwd, place.home).path; i += 2; continue; }
    if (flag === "-c" || flag === "--git-dir" || flag === "--work-tree") { i += 2; continue; }
    i += 1;
  }
  const sub = args[i]?.text;
  const rest = args.slice(i + 1);
  const has = (re: RegExp) => rest.some((a) => re.test(a.text));
  const where = repo ? `git:${repo}` : undefined;
  const repoName = repo ? shownPath(repo, place.home) : "this repository";
  switch (sub) {
    case "push":
      if (has(/^(--force|-f|--force-with-lease(=.*)?|--force-if-includes|--mirror|--prune)$/) || rest.some((a) => /^-[a-z]*f[a-z]*$/.test(a.text)) || has(/^\+/)) {
        return { kind: "delete", place: where, what: `Overwrite the remote history of ${repoName} (${short(line, 80)})` };
      }
      if (has(/^(--delete|-d)$/) || has(/^:[^/]/)) return { kind: "delete", place: where, what: `Delete a remote branch of ${repoName} (${short(line, 80)})` };
      return null;
    case "reset":
      if (has(/^--hard$/)) return { kind: "delete", place: where, what: `Throw away uncommitted work in ${repoName} (${short(line, 80)})` };
      return null;
    case "branch":
      if (has(/^-D$/) || (has(/^(-d|--delete)$/) && has(/^(-r|--remotes|-f|--force)$/)) || rest.some((a) => /^-[a-zA-Z]*D[a-zA-Z]*$/.test(a.text))) {
        return { kind: "delete", place: where, what: `Delete a branch of ${repoName} for good (${short(line, 80)})` };
      }
      return null;
    case "clean": {
      const specs = operands(rest).filter((w) => !/^-/.test(w.text));
      if (!repo) { found.unknownDelete ??= short(line); return null; }
      const targets = specs.length ? specs.map((w) => resolveWord(w, repo, place.home)) : [{ path: repo, text: tildeOf(repo, place.home), glob: true }];
      found.deletes.push(...targets);
      return null;
    }
    case "rm":
      for (const w of operands(rest)) found.deletes.push(resolveWord(w, repo, place.home));
      return null;
    default:
      return null;
  }
}

function deleteHit(found: Collected, place: StopLinePlace): StopHit | null {
  const real = (path: string) => {
    try { return place.realpath ? clean(place.realpath(path)) : path; } catch { return path; }
  };
  // the home folder by both spellings: a linked home (macOS /var ->
  // /private/var) must not make ~/Documents look like an ordinary folder
  const realHome = real(clean(place.home));
  const tooBroad = (path: string) => isTooBroad(path, place.home) || isTooBroad(path, realHome);
  const roots = place.roots.filter((root) => root).map(clean).filter((root) => posix.isAbsolute(root) && !tooBroad(root));
  const inside = (t: Target) => {
    if (!t.path) return false;
    const p = real(t.path);
    return roots.some((root) => within(root, p) || (t.glob === true && clean(root) === p));
  };
  const outside = found.deletes.filter((t) => !inside(t));
  if (found.unknownDelete && !outside.length) {
    return { kind: "delete", what: `Delete something Murage cannot place, so it may be outside its folder: ${found.unknownDelete}` };
  }
  if (!outside.length) return null;
  const glob = WIN_CANON.test(clean(place.home)) ? "\\…" : "/…";
  const shown = outside.map((t) => (t.path ? shownPath(t.path, place.home) + (t.glob ? glob : "") : t.text));
  const list = shown.slice(0, 3).join(", ") + (shown.length > 3 ? ` and ${shown.length - 3} more` : "");
  const count = outside.length === 1 ? "1 item" : `${outside.length} items`;
  // the place a "for this task" grant would cover: the folder that holds
  // every target, never the home folder or a disk root
  let scope: string | undefined;
  if (!found.unknownDelete && outside.every((t) => t.path)) {
    // each target's folder, or the target itself when its folder is the home
    // folder, Documents or a disk root (a grant over all of those is not
    // what one card asked about)
    const parents = outside.map((t) => {
      const path = real(t.path!);
      const parent = t.glob ? path : posix.dirname(path);
      return tooBroad(parent) && !t.glob ? path : parent;
    });
    let common = parents[0]!;
    for (const p of parents.slice(1)) while (!(p === common || p.startsWith(`${common}/`))) common = posix.dirname(common);
    // at least two folders deep, not counting a Windows drive
    const depth = common.split("/").filter(Boolean).length - (WIN_CANON.test(common) ? 1 : 0);
    if (!tooBroad(common) && common !== "/" && depth >= 2) scope = common;
  }
  const unknown = found.unknownDelete ? " (and more Murage cannot place)" : "";
  return { kind: "delete", place: scope, what: `Delete ${count} outside its folder: ${list}${unknown}` };
}

function httpHit(name: string, args: Word[]): StopHit | null {
  const url = args.map((a) => a.text).find((t) => /^https?:\/\//i.test(t) || /^[\w.-]+\.[a-z]{2,}\//i.test(t));
  if (!url) return null;
  let host = "";
  try { host = new URL(/^https?:/i.test(url) ? url : `https://${url}`).hostname; } catch { return null; }
  const texts = args.map((a) => a.text);
  const method = (() => {
    const i = texts.findIndex((t) => t === "-X" || t === "--request");
    if (i !== -1) return (texts[i + 1] ?? "").toUpperCase();
    const joined = texts.find((t) => /^-X[A-Z]+$/.test(t));
    if (joined) return joined.slice(2);
    if (/^(http|https|xh|httpie)$/.test(name)) {
      const verb = texts.find((t) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(t));
      if (verb) return verb;
      if (texts.some((t) => /^[\w.-]+(=|:=)/.test(t))) return "POST";
      return "GET";
    }
    if (texts.some((t) => /^(-d|--data(-\w+)?|-F|--form|--json|--post-data|--post-file)$/.test(t) || /^--data(-\w+)?=/.test(t))) return "POST";
    return "GET";
  })();
  if (method === "GET" || method === "HEAD") return null;
  if (PAYMENT_HOSTS.test(host)) {
    const data = texts.join(" ");
    const payee = /\b(customer|destination|recipient|payee)=([\w@.-]+)/.exec(data)?.[2];
    return { kind: "pay", ...(payee ? { place: `${host}:${payee.toLowerCase()}` } : {}), what: `Make a payment request to ${host}${payee ? ` for ${payee}` : ""}` };
  }
  if (MESSAGE_URLS.test(url)) return { kind: "message", what: `Send a message through ${host}, and Murage cannot tell to whom` };
  return null;
}

// ── connected-app tools ───────────────────────────────────────────────

interface ToolCall {
  /** lowercased app: the MCP server, or a Composio slug's toolkit */
  app: string;
  /** the tool's own name, without the server prefix */
  name: string;
  args: Record<string, unknown>;
}

/** An engine names MCP tools `mcp__server__tool` (Claude, Codex), `server:
 * tool` or `server/tool` (some ACP engines). */
function toolCalls(tool: string, input: unknown): ToolCall[] {
  const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  let app = "";
  let name = tool.trim();
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) { app = mcp[1]!.toLowerCase(); name = mcp[2]!; }
  else {
    const ns = /^([\w-]+)[:/.]\s*([\w-]+)$/.exec(name);
    if (ns) { app = ns[1]!.toLowerCase(); name = ns[2]!; }
  }
  // Composio's one tool carries every connected-app call it makes
  if (/^composio_multi_execute_tool$/i.test(name) && Array.isArray(args.tools)) {
    return (args.tools as unknown[]).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const call = item as { tool_slug?: unknown; arguments?: unknown };
      if (typeof call.tool_slug !== "string") return [];
      const slug = call.tool_slug;
      const inner = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments) ? (call.arguments as Record<string, unknown>) : {};
      return [{ app: slug.split("_")[0]!.toLowerCase(), name: slug.split("_").slice(1).join("_") || slug, args: inner }];
    });
  }
  // a bare name like GMAIL_SEND_EMAIL names its app first
  if (!app && /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(name)) { app = name.split("_")[0]!.toLowerCase(); name = name.split("_").slice(1).join("_"); }
  return [{ app, name, args }];
}

function stringValues(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value];
  // chat ids are often numbers (Telegram)
  if (typeof value === "number" && Number.isFinite(value)) return [String(value)];
  if (depth > 2 || !value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((v) => stringValues(v, depth + 1));
  const obj = value as Record<string, unknown>;
  for (const key of ["email", "address", "id", "name", "handle", "username"]) if (typeof obj[key] === "string") return [obj[key] as string];
  return [];
}

/** One spelling per recipient: lowercased, `mailto:` and display names
 * removed, so "Boss <boss@x.com>" and "BOSS@x.com" are the same person. */
export function normalizeRecipient(value: string): string {
  let v = value.trim();
  const angle = /<([^>]+)>/.exec(v);
  if (angle) v = angle[1]!;
  return v.replace(/^mailto:/i, "").trim().toLowerCase();
}

const RECIPIENT_KEYS = ["to", "recipient", "recipients", "recipient_email", "recipient_id", "to_email", "to_number", "email", "emails", "cc", "bcc",
  "channel", "channel_id", "channel_name", "chat_id", "conversation_id", "user", "user_id", "users", "phone", "phone_number", "number",
  "target", "room", "room_id", "group", "group_id", "receiver", "receiver_id", "peer", "username"];
const REPLY_KEYS = ["thread_ts", "thread_id", "threadid", "in_reply_to", "reply_to", "reply_to_message_id", "reply_to_id", "parent_id", "comment_id"];

function recipientsOf(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of Object.keys(args)) {
    if (!RECIPIENT_KEYS.includes(key.toLowerCase())) continue;
    for (const s of stringValues(args[key])) for (const part of s.split(/[,;]/)) if (part.trim()) out.push(normalizeRecipient(part));
  }
  return [...new Set(out)];
}

function messageHit(app: string, recipients: string[], place: StopLinePlace, reply: boolean, fallback: string, explicitExtra: string[] = []): StopHit | null {
  if (reply) {
    // a reply stays in its conversation; only people it ADDS are new
    const added = explicitExtra.filter((r) => !place.knownRecipients.has(r));
    if (!added.length) return null;
    return { kind: "message", place: added.sort().join(","), recipients: explicitExtra, what: `Add someone new to a conversation: ${added.join(", ")}` };
  }
  if (!recipients.length) return { kind: "message", what: `${fallback}, and Murage cannot tell who it goes to` };
  const fresh = recipients.filter((r) => !place.knownRecipients.has(r));
  if (!fresh.length) return null;
  return { kind: "message", place: fresh.sort().join(","), recipients, what: `Message someone it has not written to before: ${fresh.join(", ")}${app && app !== "email" ? ` (${app})` : ""}` };
}

function appHit(call: ToolCall, place: StopLinePlace): StopHit | null {
  if (MURAGE_SERVERS.has(call.app)) return null;
  const w = words(call.name);
  const all = new Set(w);
  const app = call.app || w[0] || "app";
  const label = `${call.app ? `${call.app} ` : ""}${w.join(" ")}`.trim();
  const readOnly = READ_VERBS.has(w[0] ?? "") && !all.has("delete");

  // SQL through a tool: the statement is the action
  for (const key of ["query", "sql", "statement", "statements"]) {
    const text = stringValues(call.args[key]).join("\n");
    const sql = SQL_DESTRUCTIVE.exec(text);
    if (sql) {
      const db = typeof call.args.project_id === "string" ? `:${call.args.project_id}` : typeof call.args.database === "string" ? `:${call.args.database}` : "";
      return { kind: "delete", place: `sql:${app}${db}`, what: `Delete database data (${sql[0].trim()}) through ${app}` };
    }
  }
  if (readOnly) return null;

  // paying
  const payApp = PAYMENT_APPS.test(app);
  const clearPay = ["charge", "payout", "refund", "purchase", "buy", "pay", "checkout"].some((v) => all.has(v)) && !all.has("charger");
  const providerPay = payApp && ["create", "confirm", "capture", "send", "finalize", "execute"].some((v) => all.has(v)) &&
    ["payment", "intent", "transfer", "transfers", "payout", "payouts", "subscription", "invoice", "order", "money", "charge", "charges", "refund", "refunds"].some((n) => all.has(n));
  const moneyTransfer = all.has("transfer") && (payApp || all.has("money") || all.has("funds"));
  if (clearPay || providerPay || moneyTransfer || all.has("money") && all.has("send")) {
    const payee = ["customer", "customer_id", "destination", "recipient", "recipient_id", "payee", "beneficiary", "receiver", "to", "email", "account", "charge", "payment_intent"]
      .map((key) => call.args[key])
      .find((v): v is string => typeof v === "string" && v.trim().length > 0);
    return { kind: "pay", ...(payee ? { place: `${app}:${payee.trim().toLowerCase()}` } : {}), what: `Make a payment (${label})${payee ? ` for ${payee}` : ""}` };
  }

  // deleting in a connected app (a file tool with a path is judged by path)
  const deleteVerb = ["delete", "trash", "destroy", "purge", "erase", "wipe", "empty", "expunge"].some((v) => all.has(v)) ||
    (all.has("remove") && ["file", "files", "message", "messages", "email", "emails", "mail", "record", "records", "row", "rows", "document", "doc", "item", "items",
      "event", "events", "contact", "contacts", "page", "post", "comment", "attachment", "folder", "repo", "repository", "branch", "database", "table", "bucket", "object", "user", "member"].some((n) => all.has(n)));
  if (deleteVerb) {
    if (!call.app) return null; // a bare engine tool: handled as a path delete
    return { kind: "delete", place: `app:${app}`, what: `Delete in a connected app (${label})` };
  }

  // messaging
  const isDraft = all.has("draft") && !all.has("send");
  if (isDraft) return null;
  const publicApp = PUBLIC_APPS.test(app) || all.has("tweet") || all.has("retweet");
  const postVerb = ["post", "tweet", "retweet", "publish", "share", "submit", "comment", "reply", "create", "send", "upload"].some((v) => all.has(v));
  if (publicApp && postVerb) {
    return { kind: "message", place: `public:${app}`, what: `Post publicly on ${app} (${label})` };
  }
  if (["broadcast", "campaign", "newsletter"].some((n) => all.has(n)) && ["send", "schedule", "publish"].some((v) => all.has(v))) {
    return { kind: "message", place: `public:${app}`, what: `Send a mass email or broadcast (${label})` };
  }
  const sendVerb = ["send", "reply", "forward", "dm", "notify", "invite"].some((v) => all.has(v)) ||
    (all.has("post") && (all.has("message") || all.has("chat"))) || (all.has("create") && ["message", "reply"].some((n) => all.has(n)));
  if (!sendVerb) return null;
  const argKeys = Object.keys(call.args).map((k) => k.toLowerCase());
  const reply = all.has("reply") || argKeys.some((k) => REPLY_KEYS.includes(k) && call.args[k] !== undefined && call.args[k] !== "");
  const extras = reply ? recipientsOf(Object.fromEntries(Object.entries(call.args).filter(([k]) => ["cc", "bcc", "to", "recipients"].includes(k.toLowerCase())))) : [];
  return messageHit(app, recipientsOf(call.args), place, reply, `Send a message (${label})`, extras);
}

// ── entry point ───────────────────────────────────────────────────────

function commandText(tool: string, input: unknown, summary: string): string | undefined {
  const bare = tool.toLowerCase().replace(/^mcp__.+__/, "").split(/[./]/).pop()!;
  const obj = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
  const raw = obj?.command ?? obj?.cmd ?? obj?.script;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && raw.every((part) => typeof part === "string")) {
    // ["bash", "-lc", "…"] is a shell line; anything else is argv
    const argv = raw as string[];
    if (argv.length >= 3 && /(^|\/)(ba|z)?sh$/.test(argv[0]!) && /^-\w*c$/.test(argv[1]!)) return argv.slice(2).join(" ");
    // ["powershell.exe", "-NoProfile", "-Command", "…"] is a PowerShell line
    const ps = /(^|[\\/])(powershell|pwsh)(\.exe)?$/i.test(argv[0]!) ? argv.findIndex((part) => /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(part)) : -1;
    if (ps !== -1 && argv[ps + 1] !== undefined) return argv.slice(ps + 1).join(" ");
    return argv.map((part) => (/[\s'"$`]/.test(part) ? `'${part.replace(/'/g, "'\\''")}'` : part)).join(" ");
  }
  // a shell tool that reported no command: the card text is the command
  if (COMMAND_TOOLS.has(bare)) return summary;
  return undefined;
}

/** The paths a bare engine file-delete tool names (`delete_file`, ACP kind
 * `delete`), from its structured input. */
function deleteToolPaths(tool: string, input: unknown): string[] | undefined {
  const bare = tool.toLowerCase();
  const w = new Set(words(bare));
  const isDelete = bare === "delete" || ((w.has("delete") || w.has("remove") || w.has("trash")) && (w.has("file") || w.has("files") || w.has("dir") || w.has("directory") || w.has("path")));
  if (!isDelete) return undefined;
  const obj = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const out: string[] = [];
  for (const key of ["path", "paths", "file_path", "filePath", "target", "file", "files", "directory", "dir"]) {
    for (const s of stringValues(obj[key])) out.push(s);
  }
  const locations = obj.locations;
  if (Array.isArray(locations)) for (const loc of locations) if (loc && typeof (loc as { path?: unknown }).path === "string") out.push((loc as { path: string }).path);
  return out;
}

/** The place with its folders in the canonical form this file reads; the
 * resolvers still get the machine's own spelling. */
function canonPlace(place: StopLinePlace): StopLinePlace {
  const { realpath, repoOf } = place;
  return {
    ...place,
    cwd: place.cwd ? clean(place.cwd) : place.cwd,
    home: clean(place.home),
    roots: place.roots.map((root) => (root ? clean(root) : root)),
    ...(realpath ? { realpath: (path: string) => canonPath(realpath(nativePath(path))) } : {}),
    ...(repoOf ? { repoOf: (dir: string) => repoOf(nativePath(dir)) } : {}),
  };
}

/** Does this permission request cross the stop line? Null means it does not
 * and Full access may approve it; a hit says which kind, where, and in plain
 * words what the bot is about to do. */
export function classifyStopLine(tool: string, input: unknown, summary: string, given: StopLinePlace): StopHit | null {
  const place = canonPlace(given);
  const command = commandText(tool, input, summary);
  // a Windows engine's commands run in PowerShell
  if (command !== undefined) return WIN_CANON.test(place.home) ? psHit(command, place) : shellHit(command, place);
  const paths = deleteToolPaths(tool, input);
  if (paths) {
    const found: Collected = { deletes: [] };
    if (!paths.length) found.unknownDelete = tool;
    for (const p of paths) found.deletes.push(resolveWord({ text: p, dynamic: false }, place.cwd, place.home));
    return deleteHit(found, place);
  }
  const hits = toolCalls(tool, input).map((call) => appHit(call, place)).filter((hit): hit is StopHit => hit !== null);
  if (!hits.length) return null;
  if (hits.length === 1) return hits[0]!;
  // several stops in one call: Allow once only, and the card lists them
  return { kind: hits[0]!.kind, what: `${hits[0]!.what}, and ${hits.length - 1} more`, recipients: hits.flatMap((h) => h.recipients ?? []) };
}

/** The grant "Allow for this task" or "Always allow" records for a hit, or
 * undefined when the hit has no place to scope it to (then only "Allow once"
 * is offered). A bare tool name is never the key for these three kinds. */
export function stopLineKey(hit: StopHit): string | undefined {
  if (!hit.place) return undefined;
  // a public post is keyed by where it is public: `stop:public:github:o/r`
  return hit.kind === "message" && hit.place.startsWith("public:") ? `stop:${hit.place}` : `stop:${hit.kind}:${hit.place}`;
}

/** Is a stop-line key a grant over this hit? Same kind always; a delete key
 * covers its folder's whole subtree; every other place must match exactly. */
export function stopLineKeyCovers(key: string, hit: StopHit): boolean {
  if (!hit.place) return false;
  if (key.startsWith("stop:public:")) return hit.kind === "message" && `stop:${hit.place}` === key;
  const m = /^stop:(delete|pay|message):(.+)$/.exec(key);
  if (!m || m[1] !== hit.kind) return false;
  const granted = m[2]!;
  if (granted === hit.place) return true;
  // a Windows folder (`/C:/Users/…`) is the same folder in any letter case
  return hit.kind === "delete" && granted.startsWith("/") && (same(hit.place) === same(granted) || same(hit.place).startsWith(`${same(granted)}/`));
}

export function isStopLineKey(key: string): boolean {
  return /^stop:(delete|pay|message|public):./.test(key);
}
