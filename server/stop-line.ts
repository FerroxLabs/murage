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
const CODE_DELETE = /\b(rmtree|rmSync|rmdirSync|unlinkSync|os\.remove|os\.unlink|os\.rmdir|shutil\.rmtree|fs\.rm|fs\.unlink|FileUtils\.rm|File\.delete|Remove-Item|send2trash)\b/;

/** Folder names that are never "the folder the bot works in", however it was
 * set: they ARE the owner's own files. */
const PERSONAL_TOP = new Set(["Documents", "Desktop", "Downloads", "Pictures", "Movies", "Music", "Library", "Public", "iCloud Drive", "OneDrive", "Dropbox"]);

const words = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const READ_VERBS = new Set(["list", "get", "retrieve", "search", "read", "fetch", "find", "describe", "view", "show", "count", "lookup", "check", "preview", "download", "export"]);

// ── paths ─────────────────────────────────────────────────────────────

const clean = (path: string) => posix.normalize(path).replace(/(.)\/+$/, "$1");

function isTooBroad(root: string, home: string): boolean {
  const r = clean(root);
  if (r === "/" || r === clean(home)) return true;
  if (/^\/(Users|home|Volumes|mnt|media|private|var|System|Applications|opt|usr|etc)$/.test(r)) return true;
  if (/^\/Volumes\/[^/]+$/.test(r)) return true;
  const rel = r.startsWith(`${clean(home)}/`) ? r.slice(clean(home).length + 1) : undefined;
  return rel !== undefined && !rel.includes("/") && PERSONAL_TOP.has(rel);
}

function within(root: string, target: string): boolean {
  const r = clean(root), t = clean(target);
  return t.startsWith(r === "/" ? "/" : `${r}/`) && t !== r;
}

function tildeOf(path: string, home: string): string {
  const h = clean(home);
  return path === h ? "~" : path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
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
  let raw = text;
  if (raw === "~" || raw.startsWith("~/")) raw = `${home}${raw.slice(1)}`;
  else if (raw.startsWith("~")) return { text }; // ~otheruser
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
}

/** Split a shell line into simple commands of words. Deliberately small: it
 * understands quotes and the usual separators, and marks anything it cannot
 * know (expansion, substitution) instead of guessing. `complex` is set when
 * the line uses syntax this does not model (subshells, here-docs, braces). */
function splitShell(line: string): { commands: Word[][]; complex: boolean } {
  const commands: Word[][] = [];
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
    if (ch === "<" || ch === ">") {
      if (ch === "<" && line[i + 1] === "<") complex = true; // here-doc
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
  return { commands, complex };
}

const PREFIXES = new Set(["sudo", "doas", "command", "builtin", "nohup", "time", "nice", "exec", "env", "timeout", "caffeinate"]);

/** Strip wrappers (`sudo`, `env X=1`, `timeout 5`) down to the real program. */
function program(cmd: Word[]): { name: string; args: Word[] } | undefined {
  let i = 0;
  while (i < cmd.length) {
    const w = cmd[i]!.text;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i += 1; continue; }
    const base = w.split("/").pop()!;
    if (PREFIXES.has(base)) {
      i += 1;
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

function shellHit(line: string, place: StopLinePlace, depth = 0): StopHit | null {
  const { commands, complex } = splitShell(line);
  let cwd = place.cwd;
  const found: Collected = { deletes: [] };
  const sql = SQL_DESTRUCTIVE.exec(line);
  if (sql) return { kind: "delete", place: "sql:shell", what: `Delete database data (${sql[0].trim()}): ${short(line)}` };
  for (const cmd of commands) {
    const prog = program(cmd);
    if (!prog) continue;
    const { name, args } = prog;
    const ops = operands(args);
    if (name === "cd") {
      const to = ops[0];
      cwd = !to ? place.home : resolveWord(to, cwd, place.home).path;
      continue;
    }
    // a line handed to another shell is judged as that line
    if (/^(ba|z|da|k|fi)?sh$/.test(name)) {
      const c = args.findIndex((a) => a.text === "-c" || a.text === "-lc" || a.text === "-lic" || a.text === "-ic");
      if (c !== -1 && args[c + 1] && depth < 3) {
        const inner = shellHit(args[c + 1]!.text, { ...place, cwd }, depth + 1);
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
  if (!found.deletes.length && !found.unknownDelete && CODE_DELETE.test(line)) {
    const literals = [...line.matchAll(/['"]((?:~|\/|\.\.?\/)[^'"]*)['"]/g)].map((m) => m[1]!);
    if (!literals.length) found.unknownDelete = short(line);
    for (const lit of literals) found.deletes.push(resolveWord({ text: lit, dynamic: false }, cwd, place.home));
  }
  if (complex && !found.unknownDelete && /\b(rm|rmdir|unlink|trash|shred|srm)\b|-delete\b/.test(line) && !found.deletes.length) {
    found.unknownDelete = short(line);
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
      return null;
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
  const repoName = repo ? tildeOf(repo, place.home) : "this repository";
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
  const roots = place.roots.filter((root) => root && posix.isAbsolute(root) && !tooBroad(root)).map(clean);
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
  const shown = outside.map((t) => (t.path ? tildeOf(t.path, place.home) + (t.glob ? "/…" : "") : t.text));
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
    if (!tooBroad(common) && common !== "/" && common.split("/").length > 2) scope = common;
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

/** Does this permission request cross the stop line? Null means it does not
 * and Full access may approve it; a hit says which kind, where, and in plain
 * words what the bot is about to do. */
export function classifyStopLine(tool: string, input: unknown, summary: string, place: StopLinePlace): StopHit | null {
  const command = commandText(tool, input, summary);
  if (command !== undefined) return shellHit(command, place);
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
  return hit.place ? `stop:${hit.kind}:${hit.place}` : undefined;
}

/** Is a stop-line key a grant over this hit? Same kind always; a delete key
 * covers its folder's whole subtree; every other place must match exactly. */
export function stopLineKeyCovers(key: string, hit: StopHit): boolean {
  const m = /^stop:(delete|pay|message):(.+)$/.exec(key);
  if (!m || m[1] !== hit.kind || !hit.place) return false;
  const granted = m[2]!;
  if (granted === hit.place) return true;
  return hit.kind === "delete" && granted.startsWith("/") && hit.place.startsWith(`${granted}/`);
}

export function isStopLineKey(key: string): boolean {
  return /^stop:(delete|pay|message):./.test(key);
}
