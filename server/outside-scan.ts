// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-MEANS-IT (1.0.20, design r4): the pure text checks of the owner No limits lane.
//   - plainWipe (2.2): the accident guard on a text the reader could not follow. It only keeps a card that cards today.
//   - outsideScanMarks (4): the marking scan. One linear pass over the whole text (never cut by a reader stop); a hit
//     marks the turn as having seen outside content. Over-marking only adds cards.
//   - readOnlyShape (6.2): the closed read-only shapes, the only shell texts that run on a tainted turn.
// Nothing here touches the disk. The registry, the session edits and the PATH lookup come in as hooks, so the caller
// (external-marks.ts, auto-approve.ts) owns every syscall and its budget. Strip-only TypeScript.

import path from "node:path";

/** 1.0.10 (NOLIMITS-CARDS fix round): `$'...'` (ANSI-C quoting) written out as bash reads it: `\xHH`, `\NNN`,
 * `\uHHHH`, `\UHHHHHHHH`, `\cX` and the one-letter escapes. An escape it does not know is kept as its letter.
 * Lives here (moved from auto-approve.ts unchanged) so this module imports nothing of the gate. */
export function decodeAnsiC(text: string): string {
  const ONE: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v" };
  return text.replace(/\$'((?:[^'\\]|\\[\s\S])*)'/g, (_whole, body: string) => body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c[\s\S]|[\s\S])/g, (_esc, esc: string) => {
    const lead = esc[0]!;
    if ((lead === "x" || lead === "u" || lead === "U") && esc.length > 1) {
      const point = parseInt(esc.slice(1), 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : "";
    }
    if (/[0-7]/.test(lead)) return String.fromCharCode(parseInt(esc, 8) & 0xff);
    if (lead === "c" && esc.length === 2) return String.fromCharCode(esc.charCodeAt(1) & 0x1f);
    return ONE[lead] ?? lead;
  }));
}

const words = (list: string): Set<string> => new Set(list.split(/\s+/).filter(Boolean));

/** The folded text both checks read: `$'…'` decoded, NFKC, lower case. */
function folded(text: string): string {
  return decodeAnsiC(text).normalize("NFKC").toLowerCase();
}

/** The parts of a word a list is checked against: the word, its basename after the last `/` or `\` with one `.exe`
 * taken off, and for an option word the word without its leading `-` and the value after its first `=`. */
function partsOf(word: string): string[] {
  const out = [word];
  const base = word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1).replace(/\.exe$/i, "");
  if (base && base !== word) out.push(base);
  if (word.startsWith("-")) {
    const bare = word.replace(/^-+/, "");
    if (bare) out.push(bare);
    const eq = word.indexOf("=");
    if (eq >= 0 && eq < word.length - 1) out.push(...partsOf(word.slice(eq + 1)));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// 2.2 plainWipe

const WIPE = words(`rm rmdir unlink shred srm dd mkfs newfs wipefs fdisk sfdisk parted gpart diskutil format diskpart
  format-volume clear-disk remove-item ri del erase rd deltree rmtree rmsync rmdirsync unlinksync rimraf removedirs
  remove removefile deletefile removedirectory delete truncate`);
const DELETE_OPTIONS = words("delete delete-after delete-before delete-during delete-excluded");
const RECURSE_AFTER = words("remove-item ri rm del rd gci get-childitem");
const DEV_OK = ["null", "zero", "random", "urandom", "stdin", "stdout", "stderr", "tty", "ptmx", "fd/", "pts/", "shm/"];
const DEVICE_SPELLINGS = ["physicaldrive", "harddisk", "\\\\.\\", "//./", "rdisk", ":(){", ":|:"];

/** A `/dev/` the text names that is not one of the plain streams. */
function namesDevice(s: string): boolean {
  for (let at = s.indexOf("/dev/"); at >= 0; at = s.indexOf("/dev/", at + 1)) {
    const rest = s.slice(at + 5);
    if (!DEV_OK.some((ok) => rest.startsWith(ok))) return true;
  }
  return false;
}

/** 2.2: true when a text the reader could not follow still reads, in plain words, as a wipe. Reads every byte. */
export function plainWipe(text: string): boolean {
  const raw = folded(text);
  if (namesDevice(raw) || DEVICE_SPELLINGS.some((spelling) => raw.includes(spelling))) return true;
  const s = raw.replace(/["'`\\]/g, "");
  if (namesDevice(s) || DEVICE_SPELLINGS.some((spelling) => s.includes(spelling))) return true;
  // words read twice: backslashes taken out (`r\m`), and backslashes as folder marks (`C:\x\rm.exe`)
  return wipeWords(s) || wipeWords(raw.replace(/["'`]/g, "").replace(/\\/g, "/"));
}

function wipeWords(s: string): boolean {
  let recurseArmed = false;
  for (const segment of s.split(/[;&|\n]/)) {
    let git = false;
    for (const word of segment.split(/[\s(){}<>,=:.[\]]+/)) {
      if (!word) continue;
      const parts = partsOf(word);
      for (const part of parts) {
        if (WIPE.has(part) || part.startsWith("mkfs") || DELETE_OPTIONS.has(part)) return true;
        if (git && part === "clean") return true;
        if (recurseArmed && part === "recurse") return true;
      }
      if (parts.includes("git")) git = true;
      if (parts.some((part) => RECURSE_AFTER.has(part))) recurseArmed = true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------
// 4 The marking scan

export type OutsideMark = "network command" | "package install" | "git" | "archive" | "interpreter" | "downloaded file" | "cloned folder";

const NET = words(`curl wget aria2c axel http https httpie xh lynx w3m links links2 elinks ftp tftp sftp scp nc ncat netcat
  socat telnet ssh mosh rsync gh glab hub fetch openssl dig nslookup whois invoke-webrequest iwr invoke-restmethod irm
  start-bitstransfer bitsadmin certutil mail mailx sendmail npx pnpx uvx pipx docker podman rclone lftp ncftp ncftpget
  tnftp s3cmd s5cmd aws gsutil gcloud az azcopy kubectl helm oc curlie httpx hurl grpcurl websocat wscat yt-dlp youtube-dl
  gallery-dl sshfs smbclient ftpget ftpput busybox toybox`);
const PWSH_NET = `webclient httpclient webrequest restmethod xmlhttp winhttp bitstransfer tcpclient udpclient net.sockets
  downloadstring downloadfile downloaddata openread -comobject add-type install-module install-package install-script
  save-module save-package import-module`.split(/\s+/).filter(Boolean);
const EXTRACT = words(`tar bsdtar gtar unzip funzip 7z 7za 7zz 7zr unrar unar gunzip gzip bunzip2 bzip2 unxz xz unzstd zstd
  lz4 unlzma lzma cpio pax ar ditto jar expand-archive`);
const INTERP_WORDS = words(`node nodejs deno bun bunx tsx ts-node pwsh powershell osascript jxa r rscript awk gawk mawk nawk
  swift jshell groovy julia elixir erl escript runghc expect iex invoke-expression
  ipython bb clojure clj racket guile sbcl ghci scala kotlin qjs hhvm cscript wscript mshta`);
// GrokBuild #7: a free-threaded (`t`) or debug (`d`) python build after its version digits (`python3.13t`, `pypy3.10d`)
const INTERP_RE = [/^(python|pypy|py)(?:[0-9.]*w?|[0-9.]*[0-9](?:t|d|td)w?)$/,/^(ruby|irb|jruby)[0-9.]*w?$/, /^perl[0-9.]*$/, /^php[0-9.]*$/, /^(lua|luajit)[0-9.]*$/, /^(tclsh|wish)[0-9.]*$/];
const SHELLS = words("sh bash zsh dash ksh mksh fish csh tcsh pwsh powershell cmd source .");
const GIT_LOCAL = words(`status diff log show branch tag rev-parse ls-files blame grep add commit restore checkout switch stash
  config init mv rm reset merge rebase cherry-pick describe shortlog`);
const GIT_VALUED = words("-c -C --git-dir --work-tree --namespace --exec-path");

/** INSTALL (ruling 5): a program word and an install word anywhere later in the same simple command. */
const INSTALLERS: Record<string, Set<string> | "any"> = {
  npm: words("install i ci add update upgrade dlx create exec link rebuild"),
  pnpm: words("install i ci add update upgrade dlx create exec link rebuild"),
  yarn: words("install i ci add update upgrade dlx create exec link rebuild"),
  bun: words("install i ci add update upgrade dlx create exec link rebuild"),
  pip: words("install download sync add"), pip3: words("install download sync add"), uv: words("install download sync add"),
  cargo: words("install add fetch update build"),
  go: words("get install download"),
  brew: words("install upgrade tap fetch reinstall"),
  gem: words("install update"),
  bundle: words("install update"),
};
for (const any of "apt apt-get yum dnf apk pacman port winget choco scoop nix composer conda mamba".split(" ")) INSTALLERS[any] = "any";
const RUNS_ALONE = words("npx pnpx bunx uvx pipx");

const isInterp = (part: string): boolean => INTERP_WORDS.has(part) || INTERP_RE.some((re) => re.test(part));
// H6 allowlist S8: an option word is searched for NET and EXTRACT words only (an interpreter hit was never used, and a
// LONG interpreter hit could shadow a SHORT NET hit: `-vSnodenc`)
const SHORT_HITS = [...NET, ...EXTRACT].filter((w) => w.length < 3);
const LONG_HITS = [...NET, ...EXTRACT].filter((w) => w.length >= 3);

/** 1.0.19 4.1: the awk family (marks only as NET), and the interpreters that always evaluate a string. */
const AWK = words("awk gawk mawk nawk");
const EVALUATORS = words("invoke-expression iex");
/** GrokBuild #13: the REPLs that source a fixed init file before the script (`./.Rprofile`, `startup.jl`, `.irbrc`, `.ghci`,
 *  `.sbclrc`, `~/.guile`, `.erlang`, `user.clj`), each with the plain flags that turn it off (none: always marks). */
const INIT_OFF: Readonly<Record<string, readonly string[]>> = {
  r: ["--no-init-file", "--vanilla"], rscript: [], julia: ["--startup-file=no"], irb: ["-f"],
  ghci: ["-ignore-dot-ghci"], sbcl: ["--no-userinit"], guile: ["-q"], erl: [], clj: [], clojure: [],
};

/** H6 ALLOWLIST (designs/NOLIMITS-S1S2-H6-ALLOWLIST.md; NOLIMITS 1.0.18). No option of any interpreter is parsed.
 *  Layer 1 (MurageMain order 11-06): M1, a text that names an interpreter is unmarked only when the WHOLE original text is
 *  plain words with single spaces (`[A-Za-z0-9_./:@+,=-]`) in the shape `<interp> <script> [operands]` (S2/S3 below), and
 *  M2, a command-prefix assignment or an env-setting word marks `interpreter` on ANY text.
 *  Layer 2: S2, an interpreter at ANY word index (wrappers need no grammar) is unmarked only when the words after it are
 *  (a) none, (b) exactly `--version` or `--help`, or (c) a script word per S3, led only by `run` (deno, bun) or `-file`/`-f`
 *  (pwsh). S3, a script word is a literal path: no leading `-`, only `[\p{L}\p{N} ._/@%+~:\\-]`, no `scheme:`, not under
 *  /dev or /proc, and for deno/bun a JS/TS file, for pwsh a `.ps1`. Disk existence is not read (a box or a remote runner
 *  cannot be stat'ed). S4, a script whose basename appears elsewhere in the same word list marks (write-then-run). S5,
 *  S11 R1/R2 and the env ruling E1-E3 are raw-text checks in `outsideScanMarks`. */
type ScriptFamily = "deno" | "pwsh" | "other";
const SCRIPT_CHARS = /^[\p{L}\p{N} ._/@%+~:\\-]+$/u;
/** S3 (on a folded word). */
function scriptWord(word: string, family: ScriptFamily): boolean {
  if (word.startsWith("-") || !SCRIPT_CHARS.test(word)) return false;
  // GrokBuild #5: a folder runs its `__main__.py` / `package.json` main (`python3 .`, `node lib/`); #6: a zipapp, egg,
  // wheel, phar or jar runs the code inside it
  if (/^\.\.?$/.test(word) || /[\\/]\.{0,2}$/.test(word)) return false;
  if (/\.(?:pyz|pyzw|zip|egg|whl|phar|jar)$/.test(word)) return false;
  if (/^[a-z][a-z0-9+.-]+:/.test(word)) return false;
  if (/^\/+(?:dev|proc)(?:\/|$)/.test(path.posix.normalize(word.replace(/\\/g, "/")))) return false;
  if (family === "deno") return /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(word);
  if (family === "pwsh") return word.endsWith(".ps1");
  return true;
}
const baseName = (word: string): string => word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1);
/** S4: each folded basename's count over one word list. */
function basenameCounts(segments: readonly (readonly string[])[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const segment of segments) for (const word of segment) { const b = baseName(word); counts.set(b, (counts.get(b) ?? 0) + 1); }
  return counts;
}

/** S2 + S3 + S4: true when the interpreter `part` at `segment[index]` is NOT in the safe shape (the run marks). */
function interpInline(part: string, segment: readonly string[], index: number, counts?: ReadonlyMap<string, number>): boolean {
  if (AWK.has(part)) return false;
  if (EVALUATORS.has(part)) return true;
  const rest = segment.slice(index + 1);
  if (rest.length === 1 && (rest[0] === "--version" || rest[0] === "--help")) return false;
  const family: ScriptFamily = part === "deno" || part === "bun" ? "deno" : part === "pwsh" || part === "powershell" ? "pwsh" : "other";
  // GrokBuild #11: a profile loads on every pwsh/powershell run (`-NoProfile` stays marked: design 4.1 and 4.3 rows)
  if (family === "pwsh") return true;
  // GrokBuild #13: a REPL that sources a fixed init file is unmarked only with the flag that turns the file off leading
  const off = INIT_OFF[part];
  // list A splits on `=` (`--startup-file=no` arrives as two words)
  const split = off !== undefined && rest.length > 1 && off.includes(`${rest[0]}=${rest[1]}`);
  if (off !== undefined && !split && !off.includes(rest[0] ?? "")) return true;
  let lead = off === undefined ? 0 : split ? 2 : 1;
  if (rest.length === lead) return false;
  if (family === "deno" && rest[lead] === "run") lead++;
  const script = rest[lead];
  if (script === undefined || !scriptWord(script, family)) return true;
  return (counts?.get(baseName(script)) ?? 0) > 1;
}

const interpPart = (word: string): string | undefined => partsOf(word).find((p) => isInterp(p) && !AWK.has(p));
/** M1 (layer 1): the whole ORIGINAL text is plain single-spaced words in the shape `<interp> <script> [operands]`. */
const PLAIN_TEXT = /^[A-Za-z0-9_./:@+,=-]+( [A-Za-z0-9_./:@+,=-]+)*$/;
function plainRun(text: string): boolean {
  if (!PLAIN_TEXT.test(text)) return false;
  const ws = text.toLowerCase().split(" ");
  if (ws[0]!.startsWith("-")) return false;
  const part = interpPart(ws[0]!);
  return part !== undefined && !interpInline(part, ws, 0, basenameCounts([ws]));
}

/** M2 (layer 1, ungated): a command-prefix assignment or an env-setting word, on the folded text with `" ' \ ^` removed. */
const M2_PREFIX = /(?:^|[;&|\n({`]|\$\()\s*(?:(?:then|do|else|elif|time|!)\s+)*[a-z_][a-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const M2_BUILTINS = words("export declare typeset readonly local setenv read mapfile readarray");
const M2_PROGRAMS = words("env setx");
function envMechanism(view: string): boolean {
  if (M2_PREFIX.test(view)) return true;
  if (/(?:^|[\s;&|(){}`])printf\s(?:[^;&|\n]*\s)?-v/.test(view)) return true;
  if (/(?:^|[\s;&|(){}`])set\s+(?:-[a-z]*a[a-z]*(?=$|[\s;&|)])|-o\s+allexport|(?:\/[a-z]+\s+)?[a-z_][a-z0-9_]*=)/.test(view)) return true;
  if (view.includes("setenvironmentvariable") || view.includes("environment]") || /(?:^|[^a-z0-9_])env:/.test(view)) return true;
  const ws = view.replace(/\$\(/g, " ").split(/[\s;&|(){}<>`]+/).filter(Boolean);
  if (ws.some((w) => M2_BUILTINS.has(w) || M2_PROGRAMS.has(baseName(w).replace(/\.exe$/, "")))) return true;
  return ws.includes("set-item") || (ws.includes("new-item") && view.includes("env"));
}

/** The env ruling (MurageMain 11-06, replaces S11 R2's SAFE_ENV) and Astra acct4's folds. */
const ASSIGN = /(?:^|[\s;&|(){}`'"])([a-z_][a-z0-9_]*)(?:\[[^\]]*\])?\+?=/;
const ENVDRIVE = /(?:^|[^a-z0-9_])env:([a-z_][a-z0-9_]*)/;
const BRACE = /\$\{([a-z_][a-z0-9_]*):?=/;
/** `eval` as a word of its own (not `evaluate`, `eval.py` or `scripts/eval`). */
const EVAL_WORD = /(?<![\p{L}\p{N}_./\\-])eval(?![\p{L}\p{N}_./\\-])/u;
const DENY_ENV = `node_options node_path pythonstartup pythonpath pythonhome pythoninspect perl5opt perl5lib perllib perl5db rubyopt
  rubylib lua_init lua_init_5_1 lua_init_5_2 lua_init_5_3 lua_init_5_4 lua_path lua_cpath bash_env ld_preload ld_library_path
  dyld_insert_libraries dyld_library_path java_tool_options _java_options jdk_java_options phprc php_ini_scan_dir tcllibpath
  r_profile r_profile_user r_environ julia_load_path julia_depot_path erl_aflags erl_flags erl_zflags elixir_erl_options
  bun_options zdotdir pythonuserbase gem_home gem_path env`.split(/\s+/).filter(Boolean); // GrokBuild #15: the last five
const DENY_SET: ReadonlySet<string> = new Set(DENY_ENV);
const DENY_RE = new RegExp(`(?<![a-z0-9_])(?:${DENY_ENV.join("|")})(?![a-z0-9_])`);
const ENV_WORDS = words("env export declare typeset setenv readonly local");
const ENV_ITEMS = ["setenvironmentvariable", "[environment]", "set-item", "new-item", "set-content", "env:"];

/** E2 / E3: the text before the last interpreter-or-shell token (quotes and backticks removed, backslashes kept). The
 *  whole text when no token is found, on that view or on the view with its quotes kept (`py\thon3`, `py""thon3`). */
function beforeLastRunner(raw: string): string {
  const token = (t: string) => { const n = t.replace(/^-+/, "").replace(/\.exe$/, ""); return (isInterp(n) && !AWK.has(n)) || SHELLS.has(n); };
  const last = (s: string): number => { let at = -1; for (const m of s.matchAll(/[\p{L}\p{N}_.+-]+/gu)) if (token(m[0])) at = m.index!; return at; };
  const view = raw.replace(/["'`]/g, "");
  const at = last(view);
  return at < 0 || last(raw) < 0 ? view : view.slice(0, at);
}

/** The S11 gate and Astra acct4 fold 5's wider gate for the env rules. */
function namesRunner(raw: string): { interp: boolean; shell: boolean } {
  let interp = false;
  let shell = false;
  for (const segments of [listA(raw), listB(raw), listBW(raw)]) for (const segment of segments) segment.forEach((w, i) => {
    for (const p of partsOf(w)) {
      if (isInterp(p) && !AWK.has(p)) interp = true;
      if (p === "." ? i === 0 && w === "." : SHELLS.has(p)) shell = true;
    }
  });
  return { interp, shell };
}

/** S11 R1, the env ruling (E1-E3, DENY_ENV, ENVDRIVE, BRACE, Astra acct4 folds 1-5), S5, M1 and M2, on `raw`. */
function rawInterpreterMarks(text: string, raw: string): boolean {
  const view = raw.replace(/["'\\^]/g, "");
  if (envMechanism(view)) return true;
  // Astra acct5 r1 #6 + MurageMain inverted rule (11-06): `eval` and an assignment ANYWHERE mark, inside an eval body and
  // inside quotes too (`eval BASH_ENV=/w/hook.sh; ./build.sh` keeps the export attribute; no runner word is named)
  if (EVAL_WORD.test(raw) || EVAL_WORD.test(view)) return true;
  for (const s of [raw, view]) if (ASSIGN.test(s) || ENVDRIVE.test(s) || BRACE.test(s)) return true;
  const gate = namesRunner(raw);
  if (gate.interp && (raw.includes("`") || raw.includes("$("))) return true;
  if (gate.interp && raw.includes("<")) return true;
  if (gate.interp || gate.shell) {
    if (DENY_RE.test(raw) || DENY_RE.test(raw.replace(/["'`\\^]/g, ""))) return true;
    if (ENV_ITEMS.some((item) => view.includes(item))) return true;
    const before = beforeLastRunner(raw);
    if (before.includes("\\") || before.includes("^")) return true;
    if (before.split(/[\s;&|(){}<>`]+/).some((w) => ENV_WORDS.has(baseName(w).replace(/\.exe$/, "")))) return true;
  }
  return gate.interp && !plainRun(text);
}

/** S7: an interpreter bound to a variable (`P=python3; $P -c x`, `alias p=python3`). */
function boundInterp(segments: readonly (readonly string[])[]): boolean {
  return segments.some((segment) => segment.some((w) => {
    const m = /^[a-z_][a-z0-9_]*=(.+)$/.exec(w);
    return m !== null && interpPart(m[1]!) !== undefined;
  }));
}

/** S7: listBW is read for interpreter runs only. */
function interpPass(segments: readonly (readonly string[])[], marks: Set<OutsideMark>): void {
  const counts = basenameCounts(segments);
  for (const segment of segments) segment.forEach((word, index) => {
    for (const part of partsOf(word)) if (isInterp(part) && interpInline(part, segment, index, counts)) marks.add("interpreter");
  });
  if (boundInterp(segments)) marks.add("interpreter");
}

/** 4.1: text piped into an interpreter (`curl x | python3`, `cat x.py | node`), or a heredoc handed to one. */
function streamedInterp(s: string): boolean {
  const pieces = s.replace(/["'`\\]/g, "").split(/(\|\||&&|\|&|[;&|\n])/);
  const interpIn = (piece: string) => piece.split(/[\s(){}<>,=:$]+/).filter(Boolean).some((w) => partsOf(w).some((p) => isInterp(p) && !AWK.has(p)));
  for (let i = 2; i < pieces.length; i += 2) if ((pieces[i - 1] === "|" || pieces[i - 1] === "|&") && interpIn(pieces[i]!)) return true;
  return s.includes("<<") && s.split("<<").slice(0, -1).some((before) => interpIn(before.split(/\|\||&&|[;&|\n]/).pop() ?? ""));
}

/** An option word that hides a NET or EXTRACT word (`env -vvvvvScurl h`, `env -vSnc h 80`). */
function optionHides(word: string): OutsideMark | null {
  if (!word.startsWith("-")) return null;
  const bare = word.replace(/^-+/, "");
  const hidden = LONG_HITS.find((hit) => bare.includes(hit)) ?? SHORT_HITS.find((hit) => bare.endsWith(hit));
  if (hidden === undefined) return null;
  return NET.has(hidden) ? "network command" : "archive";
}

/** What the caller knows about the turn. Every hook is optional; a hook that is absent marks nothing for its class. */
export interface OutsideScanHooks {
  /** a PowerShell text (PWSH-NET applies) */
  pwsh?: boolean;
  /** the folder the text runs in (TE-RUN resolves relative words against it) */
  cwd?: string;
  /** absolute paths the engine session edited (TE-RUN, 6.2) */
  sessionEdits?: ReadonlySet<string>;
  /** DL (5): the registry lookup for one word, or for the folder a text with no path word reads (`cwd` passed). Words
   * and the cwd come in their ORIGINAL case (MurageMain ruling, 11-05): the registry folds its own keys, and its disk
   * checks (lstat, realpath) need the real name on a case-sensitive disk. `searched` (step 2c): the word is a folder
   * operand of a step-4 form, or the implied cwd. */
  registry?: (word: string, implied: boolean, searched: boolean) => "downloaded file" | "cloned folder" | null;
  /** DL step 5: called once per simple command holding a `git` part, with each `-C` / `--git-dir` / `--work-tree` /
   * `GIT_DIR=` value as written, or `undefined` (the repo above the cwd). */
  repo?: (root: string | undefined) => "downloaded file" | "cloned folder" | null;
  /** GrokBuild #10, #12, #14 (bun/deno config, sitecustomize): the home folder the engine runs with. */
  home?: string;
  /** GrokBuild #5, #6, #8, #10, #12-#14, #17: one disk read of an absolute path (with `cwd`), null when nothing is there. It
   *  follows symlinks; `magic` asks for the first two bytes. Absent: python, bun and deno runs mark (their startup files
   *  cannot be seen) and a package script run is judged on its text only. A throw marks (the caller's catch). */
  probe?: (absolute: string, magic: boolean) => DiskProbe | null;
  /** GrokBuild #16: the engine process was started with a DENY_ENV variable (noteEngineEnv), so every text that names an
   *  interpreter or a shell marks. */
  engineEnv?: boolean;
  /** GrokBuild #8 (1.0.18 close): a bare program name's first file on the PATH the engine runs with (not realpath'd: the
   *  probe follows it). `undefined`: that PATH is not known (the run marks); `null`: not found. */
  lookupProgram?: (name: string) => string | null | undefined;
  /** GrokBuild #8: the temp folders a copied binary could sit in. Not read since Astra acct5 r1 #3 (every native program
   *  outside the system roots marks, wherever it sits); kept so the wire's ScanDisk shape is unchanged. */
  temp?: readonly string[];
  /** GrokBuild #10 (1.0.18 close): the XDG_CONFIG_HOME bun reads `.bunfig.toml` from (beside `$HOME/.config`). */
  xdgConfig?: string;
}

/** What `probe` reports: the kind of the file the path names after symlinks, its realpath, whether it changed since the
 *  running turn began, and (asked with `magic`, the same 2-byte read) whether it starts `PK` (a zip) or a native
 *  executable header (ELF, Mach-O, PE). */
export interface DiskProbe { kind: "file" | "dir" | "other"; real: string; fresh: boolean; zip: boolean; native?: boolean }

// GrokBuild #16 (finisher ruling 11-06: NODE_OPTIONS is never stripped from an engine, it carries memory flags; fail closed
// instead): cloudTurnEnvironment, the env every engine driver spawns with, notes whether it carries a DENY_ENV name with a
// value. Sticky for the process: one such engine turns the relief off for every later text.
// MurageMain ruling 11-06 (amends aad56adb6): only a CODE-LOADING value marks. The option-carrying names mark only with a
// flag that loads code (Murage's own memory flags such as `--max-old-space-size` never mark); every other DENY_ENV name
// (startup files, library paths, BASH_ENV, ENV, ...) marks with any value.
let engineEnvDeny = false;
// GrokBuild #10 (1.0.18 close): every XDG_CONFIG_HOME an engine was started with (bun reads `.bunfig.toml` there). Past the
// cap the bun family marks.
const ENGINE_XDG_MAX = 16;
const engineXdg = new Set<string>();
let engineXdgOverflow = false;
/** Astra acct5 r1 H7: NODE_OPTIONS split the way Node splits it (node_options.cc ParseNodeOptionsEnvVar): a space ends a word
 *  outside double quotes, a double quote toggles quoting and is dropped, and inside quotes a backslash takes the next
 *  character. Null when Node would refuse the value (an open quote, a trailing escape): the caller marks. */
export function nodeOptionWords(value: string): string[] | null {
  const out: string[] = [];
  let quoted = false;
  let fresh = true;
  for (let i = 0; i < value.length; i++) {
    let c = value[i]!;
    if (c === "\\" && quoted) {
      if (i + 1 === value.length) return null;
      c = value[++i]!;
    } else if (c === " " && !quoted) { fresh = true; continue; }
    else if (c === "\"") { quoted = !quoted; continue; }
    if (fresh) { out.push(c); fresh = false; } else out[out.length - 1] += c;
  }
  return quoted ? null : out;
}
/** The words an option variable can mean, a superset: Node's split, each word split again at any white space, and the value
 *  with every quote and backslash dropped split at white space. Null when Node's split fails. */
function optionWords(value: string): string[] | null {
  const node = nodeOptionWords(value);
  if (node === null) return null;
  return [...node, ...node.flatMap((w) => w.split(/\s+/)), ...value.replace(/["'\\]/g, "").split(/\s+/)].filter((w) => w !== "");
}
// The code-loading options. Node: --require/-r, --import, --loader/--experimental-loader, and --env-file(-if-exists) (a file
// that may carry its own NODE_OPTIONS). Bun: --preload, --require/-r, --import, --config/-c (a bunfig holding preloads),
// --env-file. A memory flag (--max-old-space-size, --stack-size, ...) never matches.
const NODE_LOADING = /^(?:--require|-r|--import|--loader|--experimental-loader|--env-file|--env-file-if-exists)(?:=|$)|^-r./;
const BUN_LOADING = /^(?:--preload|--require|-r|--import|--config|-c|--env-file)(?:=|$)|^-[rc]./;
const wordsLoad = (value: string, re: RegExp): boolean => { const ws = optionWords(value); return ws === null || ws.some((w) => re.test(w)); };
/** RUBYOPT: Ruby splits it at white space (quotes dropped here, a superset) and reads switch clusters: `-r` (require) or `-I`
 *  (a load path that decides what a later require loads) anywhere in a cluster loads code; `-W`, `-E` and `-K` take the rest
 *  of their cluster as a value. */
function rubyLoads(value: string): boolean {
  for (const w of value.replace(/["'\\]/g, "").split(/\s+/)) {
    if (!w.startsWith("-") || w.startsWith("--")) continue;
    for (const c of w.slice(1)) {
      if (c === "r" || c === "I") return true;
      if (c === "W" || c === "E" || c === "K") break;
    }
  }
  return false;
}
/** Java: an agent, a boot class path, a patched module, a system class loader, or an `@argfile` (options read from a file). */
const javaLoads = (value: string): boolean =>
  /-javaagent|-agentlib|-agentpath|-xbootclasspath|--patch-module|-djava\.system\.class\.loader/i.test(value.replace(/["'\\]/g, "")) || /(?:^|[\s"'])@/.test(value);
const ENV_LOADS: Readonly<Record<string, (value: string) => boolean>> = {
  node_options: (value) => wordsLoad(value, NODE_LOADING),
  rubyopt: rubyLoads,
  bun_options: (value) => wordsLoad(value, BUN_LOADING),
  java_tool_options: javaLoads,
  _java_options: javaLoads,
  jdk_java_options: javaLoads,
};
export function engineEnvLoadsCode(name: string, value: string | undefined): boolean {
  const key = name.toLowerCase();
  if (value === undefined || value.trim() === "" || !DENY_SET.has(key)) return false;
  // the null device loads nothing (Murage's own neutral pin, CLAUDE_OVERLAY_NEUTRAL BASH_ENV=/dev/null)
  if (/^(?:\/dev\/null|nul)$/i.test(value.trim())) return false;
  const loads = ENV_LOADS[key];
  return loads === undefined || loads(value);
}
export function noteEngineEnv(env: Readonly<Record<string, string | undefined>>): void {
  if (Object.entries(env).some(([name, value]) => engineEnvLoadsCode(name, value))) engineEnvDeny = true;
  const xdg = Object.entries(env).find(([name]) => name.toUpperCase() === "XDG_CONFIG_HOME")?.[1];
  if (xdg !== undefined && xdg !== "" && !engineXdg.has(xdg)) {
    if (engineXdg.size >= ENGINE_XDG_MAX || !path.isAbsolute(xdg)) engineXdgOverflow = true;
    else engineXdg.add(xdg);
  }
}
export function engineEnvDenied(): boolean { return engineEnvDeny; }

// Astra acct5 r1 H2 / GrokBuild r1 G1: the PATH each thread's engine process was started with, noted by spawnCli (the one
// engine spawn point) for the thread a driver names, and by a driver that adopts a live process for a turn. The shell scan
// looks a bare program up on THIS PATH (outside-wire lookupProgramFor), never on the server's: a thread never noted (or
// noted with an unknown PATH) is an unknown lookup, and the run marks.
const ENGINE_PATHS_MAX = 4096;
const enginePathByThread = new Map<string, string | null>();
/** The PATH a child gets from `env` (exactly `PATH` on Mac and Linux, any spelling on Windows). No PATH at all: the default
 *  search path execvp uses on Mac and Linux, unknown (null) on Windows. */
export function enginePathFromEnv(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): string | null {
  const value = platform === "win32" ? Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1] : env.PATH;
  if (value !== undefined) return value;
  return platform === "win32" ? null : platform === "darwin" ? "/usr/bin:/bin" : "/bin:/usr/bin";
}
export function noteEnginePath(threadId: string, value: string | null | undefined): void {
  if (enginePathByThread.size >= ENGINE_PATHS_MAX && !enginePathByThread.has(threadId)) enginePathByThread.delete(enginePathByThread.keys().next().value!);
  enginePathByThread.set(threadId, value ?? null);
}
/** undefined: the thread was never noted; null: noted, its PATH unknown. */
export function enginePathOf(threadId: string): string | null | undefined { return enginePathByThread.get(threadId); }
/** Tests only. */
export function forgetEngineEnv(): void { engineEnvDeny = false; engineXdg.clear(); engineXdgOverflow = false; enginePathByThread.clear(); }

// ---------------------------------------------------------------------------------------------------------------------
// GrokBuild review (ba3d38869) of the H6 allowlist: the disk and text checks of cases 3-5, 8-10, 12, 14 and 17.

class ProbeBudgetSpent extends Error {}
type Probe = (absolute: string, magic?: boolean) => DiskProbe | null;
const PROBE_MAX = 512;
/** GrokBuild #8: PATH lookups per text; past the cap the text marks. */
const LOOKUP_MAX = 32;
const ANCESTORS_MAX = 24;
/** The text's one probe, cached and capped (a spent cap marks); undefined without `probe` and an absolute `cwd`. */
function probeOf(hooks: OutsideScanHooks): Probe | undefined {
  const { probe, cwd } = hooks;
  if (!probe || !cwd || !path.isAbsolute(cwd)) return undefined;
  const seen = new Map<string, DiskProbe | null>();
  let spent = 0;
  return (absolute, magic = false) => {
    const key = `${magic ? 1 : 0}${absolute}`;
    if (seen.has(key)) return seen.get(key)!;
    if (++spent > PROBE_MAX) throw new ProbeBudgetSpent();
    const hit = probe(absolute, magic);
    seen.set(key, hit);
    return hit;
  };
}
/** A folder and its parents up to the root; null when deeper than the cap (the caller marks). */
function ancestors(dir: string): string[] | null {
  const out: string[] = [];
  for (let at = path.resolve(dir); out.length < ANCESTORS_MAX; at = path.dirname(at)) {
    out.push(at);
    if (path.dirname(at) === at) return out;
  }
  return null;
}
const PY_STARTUP = ["sitecustomize.py", "sitecustomize.pyc", "sitecustomize", "usercustomize.py", "usercustomize.pyc", "usercustomize"];
const DENO_CONFIG = ["deno.json", "deno.jsonc", "import_map.json"];

/** Grok r1 G4 (MurageMain 11-06): `site` imports a sitecustomize / usercustomize from ANY site dir, the user site included.
 *  The dirs asked: the user site (Linux, macOS, Windows), the system and Homebrew/framework prefixes, and the prefix of
 *  the interpreter itself (a venv or a pyenv build: the word's own folder and its realpath's). A named version (`python3.12`)
 *  asks its own dirs; a bare `python3` asks 3.6-3.19 and the free-threaded `t` builds. One present marks. A bare name the
 *  engine PATH cannot resolve (no lookup, or an unknown PATH) or no home marks: its site dirs cannot be read. Isolated mode
 *  (`-I`) is not parsed: it stays marked by the option rule (fail closed). */
const PY_MINORS = Array.from({ length: 14 }, (_, i) => i + 6);
function pythonSiteMarks(part: string, word: string, hooks: OutsideScanHooks, at: Probe): boolean {
  const named = /^(?:python|pypy)(\d+\.\d+)(t?)/.exec(part);
  const versions = named ? [`${named[1]}${named[2]}`] : [...PY_MINORS.map((m) => `3.${m}`), ...PY_MINORS.filter((m) => m >= 13).map((m) => `3.${m}t`)];
  let file: string | null | undefined;
  if (/[\\/]/.test(word)) file = path.resolve(hooks.cwd!, word);
  else file = hooks.lookupProgram ? hooks.lookupProgram(word) : undefined;
  if (file === undefined || hooks.home === undefined) return true;
  const bins: string[] = [];
  if (file !== null) {
    const hit = at(file);
    if (hit !== null) for (const f of new Set([file, hit.real])) bins.push(path.dirname(f));
  }
  const prefixes = [...new Set(bins.map((b) => path.dirname(b)))];
  const home = hooks.home;
  const dirs = ["/usr/lib/python3/dist-packages", "/usr/local/lib/python3/dist-packages"];
  for (const v of versions) {
    const py = `python${v}`;
    const plain = v.replace(/t$/, "");
    dirs.push(path.join(home, ".local/lib", py, "site-packages"), path.join(home, "Library/Python", plain, "lib/python/site-packages"),
      path.join(home, "AppData/Roaming/Python", `Python${plain.replace(".", "")}`, "site-packages"),
      `/usr/lib/${py}`, `/usr/lib/${py}/site-packages`, `/usr/lib/${py}/dist-packages`, `/usr/local/lib/${py}`, `/usr/local/lib/${py}/site-packages`,
      `/usr/local/lib/${py}/dist-packages`, `/opt/homebrew/lib/${py}/site-packages`, `/Library/Frameworks/Python.framework/Versions/${plain}/lib/${py}/site-packages`);
    for (const p of prefixes) dirs.push(path.join(p, "lib", py), path.join(p, "lib", py, "site-packages"));
  }
  // Windows layout: python.exe sits in the prefix (or in a venv's Scripts folder)
  for (const b of bins) dirs.push(path.join(b, "Lib"), path.join(b, "Lib/site-packages"), path.join(path.dirname(b), "Lib/site-packages"));
  return [...new Set(dirs)].some((d) => at(d)?.kind === "dir" && PY_STARTUP.some((n) => at(path.join(d, n)) !== null));
}

/** #5, #6, #10, #12, #14 on a text plainRun passed (the only shape an interpreter runs unmarked in), in its original case:
 *  true when the run marks. No probe: the python, bun and deno families mark. */
function plainDiskMarks(text: string, hooks: OutsideScanHooks, at: Probe | undefined): boolean {
  const ws = text.split(" ");
  const part = interpPart(ws[0]!.toLowerCase())!;
  const rest = ws.slice(1);
  if (rest.length === 1 && /^--(?:version|help)$/i.test(rest[0]!)) return false;
  const python = INTERP_RE[0]!.test(part);
  if (!at) return python || part === "bun" || part === "deno";
  const cwd = hooks.cwd!;
  let lead = INIT_OFF[part] !== undefined ? 1 : 0;
  if ((part === "bun" || part === "deno") && rest[lead]?.toLowerCase() === "run") lead++;
  const script = rest[lead] === undefined ? undefined : path.resolve(cwd, rest[lead]!);
  if (script !== undefined) {
    const hit = at(script, true);
    if (hit && (hit.kind !== "file" || hit.zip)) return true;
  }
  const scriptDir = script === undefined ? cwd : path.dirname(script);
  const has = (dirs: readonly string[], names: readonly string[]) => dirs.some((d) => names.some((n) => at(path.join(d, n)) !== null));
  if (python) return has([...new Set([cwd, scriptDir])], PY_STARTUP) || pythonSiteMarks(part, ws[0]!, hooks, at);
  if (part === "bun") {
    const up = ancestors(cwd);
    if (up === null || has(up, ["bunfig.toml"]) || hooks.home === undefined || engineXdgOverflow) return true;
    // GrokBuild #10 (1.0.18 close): `$HOME/.bunfig.toml` and `$XDG_CONFIG_HOME/.bunfig.toml`, for this server's XDG, the
    // default `$HOME/.config` and every XDG an engine was started with
    const xdg = [hooks.home, path.join(hooks.home, ".config"), ...(hooks.xdgConfig && path.isAbsolute(hooks.xdgConfig) ? [hooks.xdgConfig] : []), ...engineXdg];
    return has([...new Set(xdg)], [".bunfig.toml"]);
  }
  if (part === "deno") {
    const a = ancestors(cwd);
    const b = ancestors(scriptDir);
    return a === null || b === null || has([...new Set([...a, ...b])], DENO_CONFIG);
  }
  return false;
}

/** #8 (1.0.18 close): a segment's program, resolved, is an interpreter or marks. The program is the first word past any
 *  `NAME=value` words; behind a wrapper (`nice`, `timeout 5`, `sudo -u x`, ...) every later non-option word is asked (a
 *  superset: over-marks only). A path is probed from the cwd; a bare name is looked up on the engine's PATH
 *  (`lookupProgram`; an unknown PATH marks). It marks when its realpath is an interpreter (`./runner` -> python3, a bare
 *  `runner` on PATH -> node), when it changed this turn, or (Astra acct5 r1 #3) when it is a native executable or an
 *  interpreter path outside the system roots (SYSTEM_ROOTS), whatever its age or place. */
const WRAPPERS = words(`nice nohup time timeout gtimeout stdbuf ionice chrt taskset env sudo doas exec command builtin caffeinate setsid
  xargs unbuffer flock chronic nocache watch parallel entr`);
/** Grok r1 G5: a finder that runs a program per match, and the options that start that program. */
const FINDERS = words("find gfind fd fdfind");
const FIND_EXEC = words("-exec -execdir -ok -okdir -x --exec -X --exec-batch");
const NOT_PROGRAMS = words("cd echo printf pwd test [ true false type export set unset alias read source . eval if then else elif fi for while until do done case esac in function return exit");
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Astra acct5 r1 #3 + MurageMain inverted rule (11-06): the only trusted program roots. A realpath under one of them that
 *  was not written this turn is a known system binary; every other native program marks (a copied interpreter keeps no
 *  name to read). Windows System32 sits beside Program Files (the Windows twin of /usr/bin). */
const SYSTEM_ROOTS = ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew", "/usr/local/Cellar", "/home/linuxbrew/.linuxbrew",
  "c:/program files", "c:/program files (x86)", "c:/windows/system32"];
function systemBinary(real: string): boolean {
  const p = real.replace(/\\/g, "/");
  const lower = p.toLowerCase();
  return SYSTEM_ROOTS.some((root) => (root.startsWith("c:") ? lower === root || lower.startsWith(root + "/") : p === root || p.startsWith(root + "/")));
}
/** `named`: the word is itself an interpreter name given by a path (`/opt/node/bin/node`). */
function programMarks(hit: DiskProbe, named: boolean): boolean {
  if (hit.kind !== "file") return false;
  // Astra acct5 r1 #1 (S4 parity): a program written earlier this turn marks, a script as much as a binary
  if (hit.fresh) return true;
  if (!named && interpPart(baseName(hit.real).toLowerCase()) !== undefined) return true;
  if (systemBinary(hit.real)) return false;
  // outside the system roots: an interpreter by path or an unidentified native binary marks, whatever its age or place.
  // A non-native file (a script with a shebang) that was not written this turn is the accepted residual.
  return named || hit.native === true;
}
/** Astra acct5 r1 #1: a segment that runs an interpreter or a shell (by name, behind a wrapper too). */
const runsCode = (segment: readonly string[]): boolean =>
  segment.some((w) => partsOf(w.toLowerCase()).some((p) => (isInterp(p) && !AWK.has(p)) || SHELL_RUNNERS.has(p)));
function runnerResolves(text: string, hooks: OutsideScanHooks, at: Probe): boolean {
  const cwd = hooks.cwd!;
  const edited = (file: string): boolean => hooks.sessionEdits?.has(file) === true;
  let lookups = 0;
  for (const segment of listB(decodeAnsiC(text).normalize("NFKC"))) {
    let i = 0;
    while (i < segment.length && ASSIGNMENT.test(segment[i]!)) i++;
    const first = segment[i];
    if (first === undefined) continue;
    // Grok r1 G5 (MurageMain 11-06): a wrapper (and `find -exec`, `fd -x`) is judged by its target: every later non-option
    // word is asked (a superset: over-marks only), and a target that cannot be resolved (built at run time, or a bare name
    // with no engine PATH) marks
    const program = baseName(first).toLowerCase().replace(/\.exe$/, "");
    const operand = (w: string): boolean => !w.startsWith("-") && !ASSIGNMENT.test(w);
    const execAt = FINDERS.has(program) ? segment.findIndex((w, j) => j > i && FIND_EXEC.has(w)) : -1;
    const targets = WRAPPERS.has(program) ? segment.slice(i + 1).filter(operand) : execAt > 0 ? segment.slice(execAt + 1).filter(operand) : [];
    for (const [k, w] of [first, ...targets].entries()) {
      const target = k > 0;
      if (w.startsWith("-")) continue;
      if (target && /[$`]/.test(w)) return true;
      const named = interpPart(w.toLowerCase()) !== undefined;
      const byPath = /[\\/]/.test(w);
      let file: string | null | undefined;
      if (byPath) file = path.resolve(cwd, w);
      else {
        if (NOT_PROGRAMS.has(w.toLowerCase()) || !/^[\p{L}\p{N}_.+@-]+$/u.test(w)) continue;
        if (!hooks.lookupProgram) { if (target && !named) return true; continue; }
        if (++lookups > LOOKUP_MAX) return true;
        file = hooks.lookupProgram(w);
        // a bare interpreter name is judged by the text rules; an unknown PATH marks every other bare program
        if (file === undefined) { if (named) continue; return true; }
        if (file === null) continue;
      }
      if (edited(file)) return true;
      const hit = at(file, true);
      if (!hit) continue;
      // a bare interpreter name on the PATH marks only when that file was written this turn
      if (named && !byPath ? hit.kind === "file" && hit.fresh : programMarks(hit, named)) return true;
    }
    // Astra acct5 r1 #1 (S4 parity): a file written earlier this turn and handed to an interpreter or a shell marks. Every
    // later word is asked (a superset: over-marks only).
    if (runsCode(segment)) {
      for (const w of segment.slice(i + 1)) {
        if (w.startsWith("-") || /[$`]/.test(w)) continue;
        const file = path.resolve(cwd, w);
        if (edited(file) || at(file)?.fresh === true) return true;
      }
    }
  }
  return false;
}

const SHELL_RUNNERS = words("sh bash zsh dash ksh mksh fish");
const COMMAND_PREFIX = words("builtin command exec then do else elif time ! { sudo");
const shellWord = (w: string): boolean => SHELL_RUNNERS.has(baseName(w).replace(/\.exe$/, ""));
/** The short-option cluster after a shell word, up to its first operand, holds `letter`. */
function shellOption(segment: readonly string[], index: number, letter: string): boolean {
  for (let j = index + 1; j < segment.length; j++) {
    const w = segment[j]!;
    if (!w.startsWith("-") || w === "-" || w === "--") return false;
    if (!w.startsWith("--") && /^-[a-z]+$/.test(w) && w.includes(letter)) return true;
  }
  return false;
}
/** A long option among the options after a shell word, up to its first operand. */
function longShellOption(segment: readonly string[], index: number, option: string): boolean {
  for (let j = index + 1; j < segment.length; j++) {
    const w = segment[j]!;
    if (!w.startsWith("-") || w === "-" || w === "--") return false;
    if (w === option) return true;
  }
  return false;
}
const LOGIN_ARGV0 = /^-(?:sh|bash|zsh|dash|ksh|mksh|fish|csh|tcsh)$/;
/** #3: `source x` or `. x` in command position, or a shell reading its commands from stdin (`sh -s`). #4: a shell `-c` or
 *  `eval` in a text holding a command substitution (its body is built at run time). #9: a path run as a program, or a
 *  script handed to a shell, whose name the same text also names as an operand (it created the file, then runs it). */
function textRunMarks(raw: string): boolean {
  const segments = listB(raw);
  const subst = raw.includes("`") || raw.includes("$(");
  const operands = new Map<string, number>();
  for (const segment of segments) segment.forEach((w, i) => { if (i > 0) operands.set(baseName(w), (operands.get(baseName(w)) ?? 0) + 1); });
  for (const segment of segments) {
    for (let i = 0; i < segment.length; i++) {
      const w = segment[i]!;
      if ((w === "source" || w === ".") && (i === 0 || COMMAND_PREFIX.has(segment[i - 1]!))) return true;
      if (subst && w === "eval") return true;
      if (shellWord(w) && (shellOption(segment, i, "s") || (subst && shellOption(segment, i, "c")))) return true;
      // Grok r1 G3 (MurageMain 11-06): an interactive or login shell reads rc files the text does not hold (-i, -l,
      // --login, `exec -l`, a leading-dash argv0 such as `exec -a -bash` or `-bash`): it marks, always
      if (shellWord(w) && (shellOption(segment, i, "i") || shellOption(segment, i, "l") || longShellOption(segment, i, "--login"))) return true;
      if (w === "exec" && shellOption(segment, i, "l")) return true;
      // a leading-dash argv0 in command position or as `exec -a`'s name (`du -sh` is no shell)
      if (LOGIN_ARGV0.test(w) && (i === 0 || segment[i - 1] === "-a")) return true;
      if (shellWord(w)) {
        const script = segment.slice(i + 1).find((s) => !s.startsWith("-"));
        if (script !== undefined && (operands.get(baseName(script)) ?? 0) > 1) return true;
      }
    }
    const program = segment[0];
    if (program !== undefined && /[\\/]/.test(program) && (operands.get(baseName(program)) ?? 0) > 0) return true;
  }
  return false;
}

/** #17 (MurageMain ruling 11-06): a package script run is a script file run (unmarked), unless the manifest, a lockfile or
 *  an rc file its runner reads was written earlier in the same turn (`fresh` on the disk) or is named in the same text. */
const NPM_FILES = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock", ".yarnrc",
  ".yarnrc.yml", ".npmrc", ".pnpmfile.cjs", "bun.lock", "bun.lockb"];
const CARGO_FILES = ["Cargo.toml", "Cargo.lock", ".cargo/config.toml", ".cargo/config", "build.rs"];
const RUNNER_FILES: Readonly<Record<string, readonly string[]>> = { npm: NPM_FILES, pnpm: NPM_FILES, yarn: NPM_FILES, cargo: CARGO_FILES };
/** Astra acct5 r1 #5 + MurageMain inverted rule (11-06: no more option parsing): an option that moves a runner's manifest
 *  root or picks workspace members (`npm --prefix`/`-C`/`-w`, `pnpm --dir`/`-C`/`--filter`/`-r`, `yarn --cwd`/`workspace`,
 *  `cargo --manifest-path`/`-C`/`-p`/`--workspace`) marks: the root the run reads is not the proven one. Case kept
 *  (`cargo build -r` is `--release`, `pnpm -r` is `--recursive`). */
const ROOT_MOVERS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: words("--prefix -C -w -ws --workspace --workspaces --include-workspace-root"),
  pnpm: words("--dir -C --filter -F --recursive -r -w --workspace-root"),
  yarn: words("--cwd workspace workspaces"),
  cargo: words("--manifest-path -C -p --package --workspace --all"),
};
const HOME_RC = [".npmrc", ".yarnrc", ".yarnrc.yml", ".bunfig.toml", ".cargo/config.toml", ".cargo/config"];
/** Grok r1 G6 (MurageMain 11-06): a monorepo task runner picks workspace members itself. */
const WORKSPACE_RUNNERS = words("lerna nx turbo");
function rootMoves(text: string): boolean {
  for (const segment of listB(decodeAnsiC(text).normalize("NFKC"))) {
    if (segment.some((w) => partsOf(w.toLowerCase()).some((p) => WORKSPACE_RUNNERS.has(p)))) return true;
    const at = segment.findIndex((w) => partsOf(w.toLowerCase()).some((p) => p in ROOT_MOVERS));
    if (at < 0) continue;
    const movers = ROOT_MOVERS[partsOf(segment[at]!.toLowerCase()).find((p) => p in ROOT_MOVERS)!]!;
    if (segment.slice(at + 1).some((w) => movers.has(w.startsWith("-") && w.includes("=") ? w.slice(0, w.indexOf("=")) : w))) return true;
  }
  return false;
}
/** Astra acct5 r1 #5: a folder change in command position (`cd`, `pushd`, `popd`, `chdir`, PowerShell `Set-Location`
 *  and its aliases). Read on the folded text. */
const DIR_MOVERS = words("cd pushd popd chdir set-location sl push-location pop-location");
function changesDir(raw: string): boolean {
  return listB(raw).some((segment) => segment.some((w, i) => DIR_MOVERS.has(w) && (i === 0 || COMMAND_PREFIX.has(segment[i - 1]!))));
}
/** Grok r1 G8 (MurageMain 11-06): a folder change whose target is not a literal (`cd -`, `$VAR`, `~user`, a substitution,
 *  a glob, `popd`/`pop-location`) leaves the cwd unknown, and an unknown cwd marks whatever runs next. */
function unknownDir(raw: string): boolean {
  if (raw.includes("`") || raw.includes("$(")) return true;
  return listB(raw).some((segment) => segment.some((w, i) => {
    if (!DIR_MOVERS.has(w) || !(i === 0 || COMMAND_PREFIX.has(segment[i - 1]!))) return false;
    if (w === "popd" || w === "pop-location") return true;
    const target = segment.slice(i + 1).find((t) => t === "-" || !t.startsWith("-"));
    if (target === undefined) return false;
    return target === "-" || /[$`*?[]/.test(target) || /^~[^/]/.test(target);
  }));
}
/** Astra acct5 r1 #5 + MurageMain inverted rule: a `cd` before a package, interpreter, shell or by-path run marks (the run's
 *  folder is not the one the scan resolves against). */
function cdBeforeRun(raw: string): boolean {
  if (!changesDir(raw)) return false;
  if (unknownDir(raw)) return true;
  const gate = namesRunner(raw);
  if (gate.interp || gate.shell) return true;
  return listB(raw).some((segment) => segment.some((w, i) => (i === 0 && /[\\/]/.test(w)) || partsOf(w).some((p) => p in RUNNER_FILES)));
}
/** #17 (1.0.18 close): a package run with no known absolute cwd marks. With a disk, every manifest, lockfile and rc file
 *  in the cwd and ALL its parents (a workspace root above the nearest manifest), and the home rc files, are asked; one
 *  written this turn marks. A root option or a `cd` marks before any disk read (Astra acct5 r1 #5). */
function packageRunMarks(raw: string, text: string, hooks: OutsideScanHooks, at: Probe | undefined): boolean {
  const segments = listB(raw);
  const runners = new Set<string>();
  for (const segment of segments) for (const w of segment) {
    if (w.startsWith("-")) continue;
    for (const p of partsOf(w)) if (p in RUNNER_FILES) runners.add(p);
  }
  if (runners.size === 0) return false;
  const files = [...new Set([...runners].flatMap((r) => RUNNER_FILES[r]!))];
  const lower = new Set(files.map((f) => baseName(f).toLowerCase()));
  if (segments.some((segment) => segment.some((w) => lower.has(baseName(w))))) return true;
  if (!hooks.cwd || !path.isAbsolute(hooks.cwd)) return true;
  if (rootMoves(text) || changesDir(raw)) return true;
  if (!at) return false;
  const up = ancestors(hooks.cwd);
  if (up === null || up.some((d) => files.some((f) => at(path.join(d, f))?.fresh === true))) return true;
  return hooks.home !== undefined && HOME_RC.some((f) => at(path.join(hooks.home!, f))?.fresh === true);
}

/** `env` options: true when one splits a string into the command (`-S`, `--split-string` and its prefixes), read past
 *  the valued `-u NAME` / `-C DIR` (folded: `-c`) and their long forms, up to the command. */
function envSplits(segment: readonly string[], index: number): boolean {
  for (let j = index + 1; j < segment.length; j++) {
    const w = segment[j]!;
    if (w === "--") return false;
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = w.slice(2, eq < 0 ? undefined : eq);
      if (name.startsWith("s")) return true;
      if (eq < 0 && (name.startsWith("u") || name.startsWith("ch"))) j++;
      continue;
    }
    if (w.startsWith("-") && w.length > 1) {
      for (let k = 1; k < w.length; k++) {
        const c = w[k]!;
        if (c === "s") return true;
        if (c === "u" || c === "c") { if (k === w.length - 1) j++; break; }
      }
      continue;
    }
    if (w.includes("=")) continue;
    return false;
  }
  return false;
}

/** Step 4 forms: a folder operand is searched recursively. */
const SEARCHERS = new Set(["rg", "ag", "ack", "ugrep", "find", "tree", "ls", "dir", "gci", "get-childitem"]);
const GREPS = new Set(["grep", "egrep", "fgrep"]);

/** One segment is a step-4 form: a searcher, a grep with -r/-R/--recursive, or a PowerShell `-Recurse`. */
function searchForm(words: readonly string[]): boolean {
  const lower = words.map((w) => w.toLowerCase());
  const programs = lower.flatMap((w) => partsOf(w));
  if (programs.some((p) => SEARCHERS.has(p))) return true;
  if (lower.some((w) => w === "-recurse")) return true;
  return programs.some((p) => GREPS.has(p)) && lower.some((w) => w === "--recursive" || /^-[a-z]*r[a-z]*$/i.test(w));
}

/** Step 5 repo root operands: `-C <d>`, `--git-dir <d>` / `--git-dir=<d>`, `--work-tree …`, a `GIT_DIR=<d>` word. */
function gitRoots(segment: readonly string[]): string[] {
  const out: string[] = [];
  segment.forEach((word, index) => {
    const next = segment[index + 1];
    if ((word === "-C" || word === "--git-dir" || word === "--work-tree") && next !== undefined) out.push(next);
    const eq = /^(--git-dir|--work-tree|GIT_DIR)=(.+)$/i.exec(word);
    if (eq) out.push(eq[2]!);
  });
  return out;
}

/** The checks that need words in their ORIGINAL case (ruling 11-05): DL words for the registry, step 5 repo roots, and
 * TE-RUN against `sessionEdits` (which holds paths as the engine wrote them). The same two word lists and `${…}` bodies
 * the marking scan reads, built from the decoded text without folding; every part of every word is asked. Returns true
 * when a segment is a step-4 search form (the cwd is then asked as implied, step 4). */
function originalCaseScan(text: string, hooks: OutsideScanHooks, marks: Set<OutsideMark>, depth: number): boolean {
  const raw = decodeAnsiC(text).normalize("NFKC");
  let searches = false;
  for (const segments of [listA(raw), listB(raw)]) {
    const textRuns = segments.some((seg) => seg.some((w) => partsOf(w.toLowerCase()).some((p) => SHELLS.has(p) || isInterp(p))));
    for (const segment of segments) {
      const searched = searchForm(segment);
      if (searched) searches = true;
      segment.forEach((word, index) => {
        if (hooks.registry) {
          const operand = searched && !word.startsWith("-");
          for (const part of partsOf(word)) {
            const hit = hooks.registry(part, false, operand);
            if (hit) marks.add(hit);
          }
        }
        if (hooks.sessionEdits?.size) {
          const resolved = path.resolve(hooks.cwd ?? "/", word);
          if (hooks.sessionEdits.has(resolved) && (textRuns || (index === 0 && word.startsWith("./")))) marks.add("interpreter");
        }
      });
      if (hooks.repo && segment.some((w) => partsOf(w.toLowerCase()).some((p) => p === "git" || p.startsWith("git-")))) {
        const roots = gitRoots(segment);
        for (const root of roots.length ? roots : [undefined]) {
          const hit = hooks.repo(root);
          if (hit) marks.add(hit);
        }
      }
    }
  }
  if (depth < 4) for (const body of braceBodies(raw)) if (originalCaseScan(body, hooks, marks, depth + 1)) searches = true;
  return searches;
}

/** List A (r1): quotes and backslashes removed, then split on blanks, the operators and `$`. Segmented by `; & | \n`. */
function listA(s: string): string[][] {
  return s.replace(/["'`\\]/g, "").split(/[;&|\n]/).map((segment) => segment.split(/[\s(){}<>,=:$]+/).filter(Boolean));
}

/** List B (ruling 5): split on unquoted blanks and operators, then quotes removed, so `cat 'saved page.txt'` gives the
 * word `saved page.txt`. Segmented on unquoted `; & | \n ( )`. Exported for the registration rules (outside-register.ts),
 * which read the words in their own case. */
export function listB(s: string): string[][] {
  return splitWords(s, false);
}

/** H6 allowlist S7: listB with `\` kept as a literal character (`C:\Python312\python.exe`). Read for interpreter runs only. */
function listBW(s: string): string[][] {
  return splitWords(s, true);
}

function splitWords(s: string, keepBackslash: boolean): string[][] {
  const segments: string[][] = [];
  let segment: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  const endWord = () => { if (word) segment.push(word); word = ""; };
  const endSegment = () => { endWord(); if (segment.length) segments.push(segment); segment = []; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < s.length && !keepBackslash) word += s[++i];
      else word += c;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "\\" && keepBackslash) word += c;
    else if (c === "\\" && i + 1 < s.length) word += s[++i];
    else if (/[;&|\n()]/.test(c)) endSegment();
    else if (/[\s<>`]/.test(c)) endWord();
    else word += c;
  }
  endSegment();
  return segments;
}

/** The bodies of `${…}` in a text, outermost first. */
function braceBodies(s: string): string[] {
  const out: string[] = [];
  for (let at = s.indexOf("${"); at >= 0; at = s.indexOf("${", at + 2)) {
    let depth = 0;
    for (let i = at + 1; i < s.length; i++) {
      if (s[i] === "{") depth++;
      else if (s[i] === "}" && --depth === 0) { out.push(s.slice(at + 2, i)); break; }
    }
  }
  return out;
}

function scanSegments(segments: string[][], s: string, hooks: OutsideScanHooks, marks: Set<OutsideMark>): void {
  const textRuns = segments.some((seg) => seg.some((w) => partsOf(w).some((p) => SHELLS.has(p) || isInterp(p))));
  const counts = basenameCounts(segments);
  for (const segment of segments) {
    let installer: Set<string> | "any" | null = null;
    let gitAt = -1;
    let gitSub: string | null = null;
    let skipValue = false;
    segment.forEach((word, index) => {
      const parts = partsOf(word);
      const hidden = optionHides(word);
      if (hidden) marks.add(hidden);
      for (const part of parts) {
        if (NET.has(part)) marks.add("network command");
        if (EXTRACT.has(part)) marks.add("archive");
        // H6 allowlist S2-S4: an interpreter marks unless the words after it are the safe shape
        if (isInterp(part) && interpInline(part, segment, index, counts)) marks.add("interpreter");
        if (RUNS_ALONE.has(part)) marks.add("package install");
        if (installer !== null && (installer === "any" || installer.has(part))) marks.add("package install");
      }
      if (parts[0] === "env" || parts.includes("env")) {
        const next = segment.slice(index + 1).find((w) => w.startsWith("-"));
        if (next && (next === "--split-string" || next.startsWith("--split-string=") || (!next.startsWith("--") && next.includes("s")))) marks.add("interpreter");
        // 4.1: `env -S` past other options and their values (`env -u NAME -S…`)
        else if (envSplits(segment, index)) marks.add("interpreter");
      }
      // an option's own name is never the program (`node server.js --port 3000` is not MacPorts); its `=value` still counts
      const bareOption = word.startsWith("-") ? word.replace(/^-+/, "") : null;
      const program = parts.find((p) => p in INSTALLERS && p !== bareOption);
      if (program !== undefined && installer === null) installer = INSTALLERS[program]!;
      // GIT-REMOTE: `git` or `git-x`, its subcommand outside GIT_LOCAL
      if (gitAt < 0) {
        const gitPart = parts.find((p) => p === "git" || p.startsWith("git-"));
        if (gitPart !== undefined) {
          gitAt = index;
          if (gitPart.startsWith("git-")) gitSub = gitPart.slice(4);
        }
      } else if (gitSub === null) {
        if (skipValue) skipValue = false;
        else if (GIT_VALUED.has(word)) skipValue = true;
        else if (!word.startsWith("-")) gitSub = word;
      }
      if (hooks.sessionEdits?.size) {
        const resolved = path.resolve(hooks.cwd ?? "/", word);
        if (hooks.sessionEdits.has(resolved) && (textRuns || (index === 0 && word.startsWith("./")))) marks.add("interpreter");
      }
    });
    if (gitAt >= 0 && gitSub !== null && !GIT_LOCAL.has(gitSub)) marks.add("git");
    if (gitAt >= 0 && segment.some((w) => w.includes("::"))) marks.add("git");
  }
  if (s.includes("://") || s.includes("/dev/tcp/") || s.includes("/dev/udp/")) marks.add("network command");
}

/** 4: the marks a shell text gives the turn, in a stable order. Empty when it marks nothing. */
export function outsideScanMarks(text: string, hooks: OutsideScanHooks = {}, depth = 0): OutsideMark[] {
  // GrokBuild #1: a backslash-newline is joined everywhere, inside quotes too (a shell that re-reads the body joins it)
  const raw = folded(text).replace(/\\\r?\n/g, "");
  const marks = new Set<OutsideMark>();
  try {
    const at = probeOf(hooks);
    if (hooks.engineEnv) { const gate = namesRunner(raw); if (gate.interp || gate.shell) marks.add("interpreter"); }
    if (textRunMarks(raw) || cdBeforeRun(raw) || packageRunMarks(raw, text, hooks, at)) marks.add("interpreter");
    if (at && runnerResolves(text, hooks, at)) marks.add("interpreter");
    if (plainRun(text) && plainDiskMarks(text, hooks, at)) marks.add("interpreter");
  } catch (error) {
    if (!(error instanceof ProbeBudgetSpent)) throw error;
    marks.add("interpreter");
  }
  if (/(^|[\s'"=(;|&])(\\\\|\/\/)[a-z0-9_]/.test(raw)) marks.add("network command");
  if (hooks.pwsh && PWSH_NET.some((w) => raw.includes(w))) marks.add("network command");
  if (hooks.pwsh && raw.includes("[scriptblock]")) marks.add("interpreter");
  // H6 allowlist: the raw-text checks run BEFORE any tokenizing (M1, M2, S5, S11 R1, the env ruling E1-E3)
  if (rawInterpreterMarks(text, raw)) marks.add("interpreter");
  scanSegments(listA(raw), raw, hooks, marks);
  const b = listB(raw);
  scanSegments(b, raw, hooks, marks);
  if (boundInterp(b)) marks.add("interpreter");
  interpPass(listBW(raw), marks);
  if (streamedInterp(raw)) marks.add("interpreter");
  // 4.1: awk program text reaches the network only through `/inet` special files or a `|&` coprocess
  if ((raw.includes("/inet") || raw.includes("|&")) && listA(raw).some((seg) => seg.some((w) => partsOf(w).some((p) => AWK.has(p))))) marks.add("network command");
  if (depth < 4) for (const body of braceBodies(raw)) for (const mark of outsideScanMarks(body, hooks, depth + 1)) marks.add(mark);
  if (depth === 0 && (hooks.registry || hooks.repo || hooks.sessionEdits?.size)) {
    const searches = originalCaseScan(text, hooks, marks, 0);
    // step 4 (the agreed design): the cwd is the implied folder of a search form only. Asked for every search form,
    // with or without a folder operand (a superset of "no folder operand": over-marks only, needs no disk check).
    if (searches && hooks.registry && hooks.cwd) {
      const hit = hooks.registry(hooks.cwd, true, true);
      if (hit) marks.add(hit);
    }
  }
  const ORDER: OutsideMark[] = ["network command", "package install", "git", "archive", "interpreter", "downloaded file", "cloned folder"];
  return ORDER.filter((mark) => marks.has(mark));
}

/** The INSTALL hits of a text, each as its program word (R7 looks the program up in the engine's PATH). */
export function installPrograms(text: string): string[] {
  const out = new Set<string>();
  for (const segment of listB(folded(text))) {
    let program: string | null = null;
    for (const word of segment) {
      const parts = partsOf(word);
      if (program !== null) {
        const verbs = INSTALLERS[program]!;
        if (verbs === "any" || parts.some((p) => verbs.has(p))) { out.add(program); break; }
      } else {
        const hit = parts.find((p) => p in INSTALLERS);
        if (hit !== undefined) program = hit;
        else if (parts.some((p) => RUNS_ALONE.has(p))) { out.add(parts[parts.length - 1]!); break; }
      }
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------------------------------------------------
// 6.2 Read-only shapes

/** Per program: options with no value, options that take the next word (or `=value`), and an operand cap. From
 * NOLIMITS-LAUNCHERS-A section 4 (INSPECTORS). A program not here is not read-only. */
interface Inspector { flags: Set<string>; valued?: Set<string>; maxOperands?: number; check?: (operands: string[]) => boolean }
const I = (flags: string, valued = "", maxOperands?: number, check?: (operands: string[]) => boolean): Inspector =>
  ({ flags: words(flags), valued: words(valued), maxOperands, check });
const GREP = I("-r -R -n -i -l -L -c -v -w -x -E -F -o -h -H -s -q", "-A -B -C -m -e --include --exclude --exclude-dir --color");
const SUMS = I("", "-a");
const INSPECTORS: Record<string, Inspector> = {
  cat: I("-n -b -s -v -e -t -A -E -T"),
  head: I("-q -v -f -F", "-n -c"), tail: I("-q -v -f -F", "-n -c"),
  wc: I("-l -w -c -m -L"),
  ls: I("-1 -a -A -l -h -t -r -S -R -d -F -G -i -p -s -u -c", "--color"),
  pwd: I(""), true: I(""), false: I(""),
  echo: I("-n -e -E"), printf: I(""),
  basename: I("", "", 1), dirname: I("", "", 1),
  realpath: I("-f -e -m -n -z -s"), readlink: I("-f -e -m -n -z -s"),
  stat: I("-L -x", "-c -f"), file: I("-b -i -L --mime-type"),
  du: I("-s -h -a -c -k -m", "-d"), df: I("-h -k -P -T"),
  nl: I("", "-b"), tac: I(""), rev: I(""),
  uniq: I("-c -d -u -i", "", 1), cut: I("", "-d -f -c -b"), tr: I("-d -s -c"),
  sort: I("-n -r -u -f -h -V -s -b", "-k -t"),
  comm: I("-1 -2 -3", "", 2), cmp: I("-s -l", "", 4),
  diff: I("-u -r -q -N -w -b -B -i", "-U"), column: I("-t", "-s"),
  grep: GREP, egrep: GREP, fgrep: GREP,
  rg: I(`-i -n -l -c -v -w -F -S -s -a -H -N -o -u --hidden --no-ignore --files --json --no-heading --heading
    --fixed-strings --smart-case --count --files-with-matches --line-number`, "-e -g -t -T -A -B -C -m --sort --max-depth --glob --type"),
  jq: I("-r -c -S -e -n -s -j --tab", "--indent"),
  find: I("-print -print0 -not ! -o -a -empty -prune", "-name -iname -path -type -newer -mtime -mmin -size -maxdepth -mindepth"),
  sed: I("-n", "", undefined, (ops) => ops.length >= 1 && /^(\d+|\$)(,(\d+|\$))?p$/.test(ops[0]!)),
  which: I(""), type: I(""),
  date: I("", "", 1, (ops) => ops.every((op) => op.startsWith("+"))),
  id: I("", "", 0), whoami: I("", "", 0), hostname: I("", "", 0),
  uname: I("-a -s -r -m"), sw_vers: I(""),
  md5sum: SUMS, sha1sum: SUMS, sha256sum: SUMS, shasum: SUMS,
  xxd: I("-p", "-l -s -c -g", 1), od: I("-c -x", "-A -t -N"), hexdump: I("-C", "-n -s"), strings: I("-a", "-n"),
  cd: I("", "", 1), test: I(""), "[": I(""),
};
/** Shell builtins: never looked up in PATH. */
const BUILTINS = words("cd echo printf pwd test [ true false type");
const RO_REDIRECTS = /^(2>\/dev\/null|>\/dev\/null|&>\/dev\/null|2>&1|>&2)$/;

export interface ReadOnlyHooks {
  cwd?: string;
  sessionEdits?: ReadonlySet<string>;
  /** the registry check of 5 for a resolved path; true when it Matches */
  registryMatches?: (absolutePath: string) => boolean;
  /** 6.2 ruling 6: the program's first existing file in the PATH the engine runs with, realpath'd. `undefined` when
   * Murage does not know that PATH or the shared 64-syscall budget is spent: then the text is not read-only. `null`
   * when no file is found. */
  lookupProgram?: (name: string) => string | null | undefined;
}

/** The raw-text refusals of 6.2, outside single quotes. */
function rawRefuses(text: string): boolean {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'") { quoted = !quoted; continue; }
    if (quoted) continue;
    if ("*?{}$`".includes(c)) return true;
    if (c === "[" && !/(^|[\s;&|])\[(\s|$)/.test(text.slice(Math.max(0, i - 1), i + 2))) return true;
    if (c === "~" && i > 0 && !/[\s;&|]/.test(text[i - 1]!)) return true;
    if ((c === "<" || c === ">") && text[i + 1] === "(") return true;
    if (c === "<" && text[i + 1] === "<") return true;
    if (c === "&" && text[i + 1] !== "&" && text[i - 1] !== "&" && text[i + 1] !== ">" && text[i - 1] !== ">") return true;
    if (c === "\\" && text[i + 1] === "\n") return true;
    if (c === "\n") return true;
  }
  return quoted;
}

/** 6.2: true only for a text made of closed read-only commands. The caller has already checked that the base reader
 * returns null for it. Fails closed: anything it does not know is not read-only. */
export function readOnlyShape(text: string, hooks: ReadOnlyHooks = {}): boolean {
  if (rawRefuses(text)) return false;
  for (const segment of text.split(/\|\||&&|[|;]/)) {
    // redirects: only the fixed forms, and `< plain-path` (the path stays as an operand, an input)
    const bare = segment.split(/\s+/).filter((t) => !RO_REDIRECTS.test(t)).join(" ");
    if (bare.includes(">") || /<\s*</.test(bare)) return false;
    const plain = listB(bare.replace(/</g, " "))[0] ?? [];
    if (plain.length === 0 || listB(bare).length > 1) return false;
    const [program, ...rest] = plain;
    if (program === undefined || /^[a-z_][a-z0-9_]*=/i.test(program)) return false;
    if (program.includes("/") || program.includes("\\")) return false;
    const spec = INSPECTORS[program];
    if (!spec) return false;
    const operands: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const word = rest[i]!;
      if (/^[a-z_][a-z0-9_]*=/i.test(word) && program !== "find" && !word.startsWith("-")) {
        if (program !== "jq") return false;
      }
      if (word.startsWith("-") && word !== "-" && !(program === "test" || program === "[")) {
        const [name] = word.split("=", 1) as [string];
        if (spec.flags.has(word)) continue;
        if (spec.valued?.has(name)) { if (!word.includes("=")) i++; continue; }
        if (/^-[0-9]+$/.test(word) && (program === "head" || program === "tail")) continue;
        if (!word.startsWith("--") && word.length > 2 && [...word.slice(1)].every((l, at, all) => spec.flags.has(`-${l}`) || (at === all.length - 1 && spec.valued?.has(`-${l}`)))) {
          if (spec.valued?.has(`-${word[word.length - 1]}`)) i++;
          continue;
        }
        return false;
      }
      operands.push(word);
    }
    if (spec.maxOperands !== undefined && operands.length > spec.maxOperands) return false;
    if (spec.check && !spec.check(operands)) return false;
    if (program === "printf" && rest.includes("-v")) return false;
    for (const word of operands) {
      const resolved = path.resolve(hooks.cwd ?? "/", word);
      if (hooks.sessionEdits?.has(resolved)) return false;
    }
    if (!BUILTINS.has(program)) {
      if (!hooks.lookupProgram) return false;
      const found = hooks.lookupProgram(program);
      if (found === undefined) return false;
      if (found !== null) {
        if (hooks.cwd && (found === hooks.cwd || found.startsWith(hooks.cwd.endsWith(path.sep) ? hooks.cwd : hooks.cwd + path.sep))) return false;
        if (hooks.sessionEdits?.has(found)) return false;
        if (hooks.registryMatches?.(found)) return false;
      }
    }
  }
  return true;
}
