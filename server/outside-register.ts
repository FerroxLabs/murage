// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-MEANS-IT (1.0.20, design r4 section 5): the registration rules R1-R8, written at the scan before the text runs.
// Pure: the disk is reached only through the per-text TextBudget (shared with Match and 6.2) and the PATH lookup hook.
// Every destination is registered twice (r3): the lexical path P and Q, the realpath of P's deepest existing ancestor
// joined with the rest. Past the budget, fail closed: the text's unresolved destinations become a `span` on every
// filesystem root for the turn. Strip-only TypeScript.

import { decodeAnsiC, listB, installPrograms } from "./outside-scan.ts";
import { installDestinations, installerFolders, resolveWord, type RegistryEntry, type RegistryKind, type TextBudget } from "./download-registry.ts";

export interface RegisterContext {
  cwd: string;
  home?: string;
  /** the server clock at the scan (since = now - 2 s) */
  now: number;
  /** the turn that stamps `until` when it ends */
  turn?: string;
  /** the turn is marked (R6, R8 apply) */
  marked: boolean;
  /** the text is a 6.2 read-only shape (R6 does not apply) */
  readOnly: boolean;
  budget: TextBudget;
  /** filesystem roots: `/`, or every drive root present at boot */
  roots: readonly string[];
  /** R7 (4): the installer in the engine's PATH (the 6.2 lookup); null when not found */
  lookupProgram?: (name: string) => string | null;
}

const NET_OUT = new Set(["curl", "wget", "scp", "sftp", "rsync", "invoke-webrequest", "iwr", "invoke-restmethod", "irm", "start-bitstransfer", "aria2c"]);
const NET = new Set(`curl wget aria2c axel http https httpie xh lynx w3m links links2 elinks ftp tftp sftp scp nc ncat netcat socat telnet ssh mosh
  rsync gh glab hub fetch openssl dig nslookup whois invoke-webrequest iwr invoke-restmethod irm start-bitstransfer bitsadmin certutil mail mailx
  sendmail docker podman rclone lftp ncftp ncftpget tnftp s3cmd s5cmd aws gsutil gcloud az azcopy kubectl helm oc curlie httpx hurl grpcurl
  websocat wscat yt-dlp youtube-dl gallery-dl sshfs smbclient ftpget ftpput busybox toybox`.split(/\s+/).filter(Boolean));
const OUT_VALUE = new Set(["--output", "--output-document", "-outfile", "-destination"]);
const UNNAMED_FLAGS = new Set(["-j", "--output-dir", "-p", "-r", "-m", "--mirror", "-i", "--remote-name-all", "-k", "--directory-prefix"]);
const EXTRACT = new Set(`tar bsdtar gtar unzip funzip 7z 7za 7zz 7zr unrar unar gunzip gzip bunzip2 bzip2 unxz xz unzstd zstd lz4 unlzma
  lzma cpio pax ar ditto jar expand-archive`.split(/\s+/).filter(Boolean));
const EXTRACT_DIR = new Set(["-C", "-d", "--directory", "-destinationpath"]);
const COPIERS = new Set(["cp", "mv", "ln", "install", "rsync", "ditto", "copy-item", "move-item"]);
const BACKGROUND = new Set(["nohup", "setsid", "disown", "at", "batch", "screen", "tmux", "launchctl", "systemd-run", "start-process", "start-job"]);
const GIT_READ = new Set(["status", "diff", "log", "show", "blame", "grep", "shortlog", "describe", "ls-files", "ls-tree", "cat-file", "rev-parse", "reflog", "branch", "tag"]);
const GIT_VALUED = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const CLONE_VALUED = new Set(["-b", "--branch", "-o", "--origin", "-c", "--config", "--depth", "--reference", "--separate-git-dir", "-j", "--jobs",
  "--filter", "--template", "-u", "--upload-pack", "--shallow-since", "--shallow-exclude"]);
const DEV = /^\/dev\//i;

const prog = (word: string): string => word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1).toLowerCase().replace(/\.exe$/, "");
const operands = (words: readonly string[], valued: ReadonlySet<string>): string[] => {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.startsWith("-")) { if (valued.has(w)) i++; continue; }
    out.push(w);
  }
  return out;
};
/** The value of an option in a simple command: `-o x`, `-o=x`, `--output=x`; attached `-ox` when `attached`. A one-letter
 *  option keeps its case (curl `-O` takes no value, wget `-O` does; tar `-C` is not `-c`); longer names are lower-cased. */
function optionValues(words: readonly string[], names: ReadonlySet<string>, attached: readonly string[] = []): string[] {
  const out: string[] = [];
  words.forEach((word, i) => {
    const w = /^-[A-Za-z](=|$)/.test(word) ? word : word.toLowerCase();
    const eq = w.indexOf("=");
    if (eq > 0 && names.has(w.slice(0, eq))) out.push(word.slice(eq + 1));
    else if (names.has(w) && i + 1 < words.length) out.push(words[i + 1]!);
    else for (const a of attached) if (w.startsWith(a) && w.length > a.length && !w.startsWith("--")) out.push(word.slice(a.length));
  });
  return out;
}

/** The redirect targets of a text (`>`, `>>`, `&>`, `>|`, `N>`), not `>&N` and not a `/dev/` stream. */
function redirectTargets(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[^<>&|])(?:&>>?|\d*>>?\|?)\s*("[^"]*"|'[^']*'|[^\s;&|<>()]+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const target = m[1]!.replace(/^["']|["']$/g, "");
    if (target && !target.startsWith("&") && !DEV.test(target)) out.push(target);
  }
  return out;
}

/** A text that keeps running after the turn: a lone `&` or a detaching word. */
export function runsInBackground(text: string): boolean {
  if (/(^|[^&>|])&(?![&>])/.test(text.replace(/&>|>&|\d>&\d/g, ""))) return true;
  return listB(text.toLowerCase()).some((seg) => seg.some((w) => BACKGROUND.has(prog(w))));
}

/** R1-R4, R6-R8 for one shell text (R5 is registerToolWrite). The caller adds the result to the registry. */
export function registerText(raw: string, ctx: RegisterContext): RegistryEntry[] {
  const text = decodeAnsiC(raw).normalize("NFKC");
  const since = ctx.now - 2000;
  const background = runsInBackground(text);
  const stamp = background || !ctx.turn ? {} : { turn: ctx.turn };
  const out: RegistryEntry[] = [];
  let spent = false;
  const entry = (p: string, kind: RegistryKind, extra: Partial<RegistryEntry> = {}) => out.push({ path: p, kind, since, ...stamp, ...extra });
  /** P and Q for a destination word (resolved against cwd). */
  const both = (word: string, kind: RegistryKind, extra: Partial<RegistryEntry> = {}) => {
    if (!word || DEV.test(word)) return;
    const p = resolveWord(ctx.cwd, word, ctx.home);
    entry(p, kind, extra);
    const q = ctx.budget.deepestReal(p);
    if (q === "hit") spent = true;
    else if (q.toLowerCase() !== p.toLowerCase()) entry(q, kind, extra);
  };
  /** tree when the folder does not exist at the scan (one lstat), else window */
  const folder = (word: string, extra: Partial<RegistryEntry> = {}) => {
    const p = resolveWord(ctx.cwd, word, ctx.home);
    const stat = ctx.budget.lstat(p);
    if (stat === "failed" || stat === "spent") { spent = true; both(word, "window", extra); return; }
    both(word, stat === null ? "tree" : "window", extra);
  };
  const spanRoots = () => { for (const root of ctx.roots) entry(root, "span"); };

  const segments = listB(text);
  const textHasNet = segments.some((seg) => seg.some((w) => NET.has(prog(w))));
  const parents = new Set<string>();

  for (const seg of segments) {
    const at = seg.findIndex((w) => NET.has(prog(w)) || EXTRACT.has(prog(w)) || prog(w) === "git" || prog(w) === "gh" || COPIERS.has(prog(w)) || prog(w) === "tee" || prog(w) === "dd");
    const name = at >= 0 ? prog(seg[at]!) : "";
    const args = at >= 0 ? seg.slice(at + 1) : [];
    // R1 / R2 NET outputs
    if (NET.has(name)) {
      const named = [...optionValues(args, OUT_VALUE), ...optionValues(args, new Set(name === "wget" ? ["-o", "-O"] : ["-o"]), name === "wget" ? ["-O", "-o"] : ["-o"])];
      // the last `o` of a short cluster takes the next word (`-fsSLo f`)
      const clusterEnd = name === "wget" ? /^-[A-Za-z]*[oO]$/ : /^-[A-Za-z]*o$/;
      args.forEach((w, i) => { if (clusterEnd.test(w) && w.length > 2 && i + 1 < args.length && !args[i + 1]!.includes("://")) named.push(args[i + 1]!); });
      const remoteName = (name === "curl" && args.some((w) => w === "-O" || w === "--remote-name" || /^-[a-zA-Z]*O[a-zA-Z]*$/.test(w)))
        || (name === "wget" && !args.some((w) => w === "-O" || w.startsWith("--output-document")));
      if (remoteName) for (const url of args.filter((w) => w.includes("://"))) {
        const last = url.replace(/[?#].*$/, "").replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").split("/").filter(Boolean).pop();
        named.push(last && !last.includes(":") ? last : "index.html");
      }
      if ((name === "scp" || name === "sftp" || name === "rsync")) {
        const ops = operands(args, new Set(["-p", "-i", "-o", "-f", "-s", "-e"]));
        const last = ops[ops.length - 1];
        if (last && !last.includes(":") && ops.length > 1) named.push(last);
      }
      const unnamed = !NET_OUT.has(name) || (name === "aria2c" && !args.some((w) => w === "-o" || w.startsWith("--out")))
        || args.some((w) => UNNAMED_FLAGS.has(w.toLowerCase().split("=")[0]!)) || named.some((w) => /[#{[$]/.test(w));
      for (const w of named) if (!/[#{[$]/.test(w)) both(w, "file");
      if (unnamed) {
        const dirs = optionValues(args, new Set(["-P", "--output-dir", "--directory-prefix"]));
        if (dirs.length) for (const d of dirs) both(d, "window"); else both(".", "window");
      }
    }
    // R3 clones
    if (name === "git" || name === "gh") {
      const ops = operands(args, name === "git" ? new Set([...GIT_VALUED, ...CLONE_VALUED]) : CLONE_VALUED);
      const sub = ops[0]?.toLowerCase();
      const cloneOps = name === "gh" ? (sub === "repo" && ops[1]?.toLowerCase() === "clone" ? ops.slice(2) : null) : sub === "clone" ? ops.slice(1) : null;
      if (cloneOps && cloneOps.length) {
        const dest = cloneOps[1] ?? cloneOps[0]!.replace(/[\\/]+$/, "").split(/[\\/:]/).pop()!.replace(/\.git$/i, "");
        both(dest, "tree", { cloned: true });
      }
      if (name === "git" && sub === "submodule") {
        if (ops[1]?.toLowerCase() === "add" && ops[2]) both(ops[3] ?? ops[2].replace(/[\\/]+$/, "").split(/[\\/:]/).pop()!.replace(/\.git$/i, ""), "tree", { cloned: true });
        else both(".", "window", { cloned: true });
      }
      if (name === "git" && sub === "worktree" && ops[1]?.toLowerCase() === "add" && ops[2]) both(ops[2], "tree", { cloned: true });
      // R8 repo entries on a marked turn
      if (name === "git" && ctx.marked && sub !== undefined && !(GIT_READ.has(sub) && (sub !== "branch" && sub !== "tag" || ops.length === 1))) {
        const root = [...seg.slice(0, at).filter((w) => /^git_dir=/i.test(w)).map((w) => w.slice(8)), ...optionValues(args, new Set(["-C", "--git-dir", "--work-tree"]))];
        if (root.length) both(root[0]!.replace(/[\\/]\.git$/i, ""), "repo");
        else {
          let dir = resolveWord(ctx.cwd, ".");
          for (let level = 0; level < 16; level++) {
            const stat = ctx.budget.lstat(dir === "/" ? "/.git" : `${dir}/.git`);
            if (stat === "failed" || stat === "spent") { spent = true; break; }
            if (stat) { both(dir, "repo"); break; }
            const up = dir.replace(/\/[^/]*$/, "") || "/";
            if (up === dir) break;
            dir = up;
          }
        }
      }
    }
    // R4 EXTRACT
    if (EXTRACT.has(name)) {
      const dirs = optionValues(args, EXTRACT_DIR, name.startsWith("7z") ? ["-o"] : []);
      if (dirs.length) for (const d of dirs) folder(d); else folder(".");
    }
    // R6 targets the scan can name
    if (name === "tee" && (textHasNet || (ctx.marked && !ctx.readOnly))) for (const w of operands(args, new Set())) both(w, "file");
    if (ctx.marked && !ctx.readOnly) {
      if (name === "dd") for (const w of args) if (w.toLowerCase().startsWith("of=")) both(w.slice(3), "file");
      if (COPIERS.has(name)) {
        const targets = optionValues(args, new Set(["-t", "--target-directory", "-destination"]));
        const ops = operands(args, new Set(["-t", "--target-directory", "-destination", "-s", "-m", "-o", "-g", "--suffix", "-e"]));
        if (ops.length > 1 && !ops[ops.length - 1]!.includes(":")) targets.push(ops[ops.length - 1]!);
        for (const t of targets) both(t, "file");
      }
      for (const word of seg) {
        const w = word.startsWith("-") && word.includes("=") ? word.slice(word.indexOf("=") + 1) : word;
        if (!/[\\/]/.test(w) || w.includes("://") || DEV.test(w)) continue;
        const p = resolveWord(ctx.cwd, w, ctx.home);
        parents.add(p.replace(/\/[^/]*$/, "") || "/");
      }
    }
  }
  // R1 / R6 redirect targets
  if (textHasNet || (ctx.marked && !ctx.readOnly)) for (const target of redirectTargets(text)) both(target, "file");
  // R6 windows: the working folder and the parents of every path word, collected once and sorted
  if (ctx.marked && !ctx.readOnly) {
    both(".", "window");
    for (const parent of [...parents].sort()) both(parent, "window");
  }
  // R7 installs: a span on every root; named destinations; the installer's own folder and prefix root
  for (const seg of segments) {
    const programs = installPrograms(seg.join(" "));
    if (!programs.length) continue;
    spanRoots();
    for (const dest of installDestinations(seg, ctx.cwd, ctx.home)) folder(dest);
    for (const program of programs) {
      const lexical = ctx.lookupProgram?.(seg.find((w) => prog(w) === program) ?? program) ?? null;
      if (!lexical) continue;
      const real = ctx.budget.realpath(lexical);
      if (real === "failed" || real === "spent") { spent = true; continue; }
      for (const f of installerFolders(lexical, real)) both(f, "window");
    }
  }
  if (spent) spanRoots();
  return out;
}

/** R5: a path an engine file tool wrote while the turn is marked: a `file` entry, lexical and realpath. */
export function registerToolWrite(absolutePath: string, ctx: Pick<RegisterContext, "cwd" | "now" | "turn" | "budget" | "roots" | "home">): RegistryEntry[] {
  const since = ctx.now - 2000;
  const stamp = ctx.turn ? { turn: ctx.turn } : {};
  const p = resolveWord(ctx.cwd, absolutePath, ctx.home);
  const out: RegistryEntry[] = [{ path: p, kind: "file", since, ...stamp }];
  const q = ctx.budget.deepestReal(p);
  if (q === "hit") for (const root of ctx.roots) out.push({ path: root, kind: "span", since, ...stamp });
  else if (q.toLowerCase() !== p.toLowerCase()) out.push({ path: q, kind: "file", since, ...stamp });
  return out;
}
