// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Spec §3.5: risky means deleting outside the workspace, spending, sending
// email or messages (the stop line, server/stop-line.ts), or credentials,
// which the stop line does not cover. A wrong "risky" costs one trip into
// the app; a wrong "low" is a lock-screen yes to something that mattered.
//
// H9 fix round 1: the brief's single pattern used \b, and `_` is a word
// character, so $OPENAI_API_KEY, env, ~/.ssh/config and the like all rated
// "low". Every rule below treats any non-alphanumeric (`_ $ < = / - .` and
// the rest) as a boundary instead. The patterns lean wide on purpose.
//
// Device finding 2026-09-27: Bash `rm -rf ~/Documents` rated "low". The stop
// line was consulted but judged the delete inside the bot's folder, because
// the isolated host's HOME was under /tmp, one of the stop line's roots; and
// nothing here looked for deletes. Destructive work is now risky on its own,
// whatever the stop line says: deletes, overwrites through a redirection, git
// that throws work away or rewrites a remote, deleting tools, and a tool that
// writes a file outside the workspace. The engine's own command is checked
// too, since the card text is cut at 4,000 characters.

import { classifyStopLine, type StopLinePlace } from "./stop-line.ts";
import { isReadOnlyCommand } from "./mobile-push-readonly.ts";

/** Not a letter or digit on either side: `_` separates, unlike \b. */
const word = (body: string) => new RegExp(`(?<![A-Za-z0-9])(?:${body})(?![A-Za-z0-9])`, "i");

const CREDENTIAL: RegExp[] = [
  // The brief's original pattern, kept as the first rule.
  /\b(?:passwords?|passwd|secrets?|tokens?|api[ _-]?keys?|credentials?|private[ _-]?keys?|keychain|ssh[ _-]?keys?|id_rsa|id_ed25519)\b|(?:^|[\s/"'])\.env\b|_TOKEN\b|_SECRET\b/i,
  // Credential words as separate segments, in any case: API_KEY, secret-tool,
  // print-access-token, aws_secret_access_key, <API_KEY>.
  word("passwords?|passwd|pass_?word|secrets?|tokens?|keys?|api[ _-]?keys?|apikeys?|credentials?|creds|private[ _-]?keys?|keychains?|ssh[ _-]?keys?|auth[ _-]?token"),
  // Env-var names with the word run together: $PGPASSWORD, ${MY_APIKEY},
  // SECRETS_DIR. Upper-case names anywhere; any case after `$`.
  // One quantifier only (fix round 2): a trailing [A-Z0-9_]* before the
  // lookahead made "KEYKEY…KEYa" quadratic, 4.9 s at 100k characters.
  /(?<![A-Za-z0-9_])[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)(?![a-z])/,
  /\$\{?[A-Za-z0-9_]*(?:key|secret|token|passw(?:or)?d|credential)/i,
  // Dumping the environment: bare env/printenv, /proc/*/environ, bare set or export.
  word("env|printenv"),
  /\/environ(?![A-Za-z0-9])|(?<![A-Za-z0-9])os\.(?:environ|getenv)(?![A-Za-z0-9])/i,
  /(?<![A-Za-z0-9])(?:(?:declare|typeset)\s+-[A-Za-z]*[xp]|compgen\s+-[A-Za-z]*e)/,
  // ps with BSD `e` (no dash) or macOS -E prints other processes' environments.
  /(?<![A-Za-z0-9])ps\s+(?:[A-Za-z]*e[A-Za-z]*|-[A-Za-z]*E[A-Za-z]*)(?![A-Za-z0-9-])/,
  /(?:^|[\s;&|(])(?:set|export(?:\s+-p)?)\s*(?:$|[;&|)])/,
  // .env files in any form: .env, .env.local, prod.env, .envrc, --env-file, dotenv.
  /\.env(?:rc)?(?![A-Za-z0-9])/i,
  word("--env-file|env-file|dotenv"),
  // SSH and key files, and the usual credential configs.
  /\.ssh(?![A-Za-z0-9])/i,
  word("id_(?:rsa|dsa|ecdsa|ed25519)(?:[_-]sk)?"),
  /\.(?:pem|key|p12|pfx|keystore|jks)(?![A-Za-z0-9])/i,
  /\.(?:netrc|npmrc|pypirc|pgpass|git-credentials|gnupg)(?![A-Za-z0-9])/i,
  /\.kube\/config|\.docker\/config\.json|gh\/hosts\.ya?ml|\.config\/gcloud(?![A-Za-z0-9])/i,
  // Whole credential directories.
  /\.(?:aws|azure)(?![A-Za-z0-9])/i,
  // auth.json anywhere under a dot-directory (.codex/auth.json and the like).
  // Bounded repeats only, so no input can make this backtrack far.
  /(?<![A-Za-z0-9])\.[A-Za-z0-9_-]{1,64}\/(?:[A-Za-z0-9_.-]{1,64}\/){0,8}auth\.json(?![A-Za-z0-9])/i,
  // Keychains and secret stores.
  /(?<![A-Za-z0-9])security\s+(?:find-|dump-|export(?![A-Za-z0-9])|unlock-)/i,
  /(?<![A-Za-z0-9])(?:op\s+(?:read|item|signin|inject)|pass\s+show|gh\s+auth|gcloud\s+auth|vault\s+(?:kv|read|login))(?![A-Za-z0-9])|op:\/\/|secretsmanager/i,
  /(?<![A-Za-z0-9])(?:kubectl\s+config\s+view|gcloud\s+config\s+config-helper)(?![A-Za-z0-9])/i,
];

/** A glob (`*` or `?`) in a word that also has `.s` or `id_`: `~/.s*\/id_*`
 *  reaches the SSH keys without naming them. Checked per word, without a
 *  regex, so it is linear whatever the input. */
function globNearKeys(text: string): boolean {
  for (const token of text.split(/\s+/)) {
    if (!token.includes("*") && !token.includes("?")) continue;
    const lower = token.toLowerCase();
    if (lower.includes(".s") || lower.includes("id_")) return true;
  }
  return false;
}

/** Longer than this is rated risky unchecked: the model writes the summary,
 *  and nothing upstream bounds it. Exported for tests. */
export const MAX_RISK_TEXT = 8192;
/** Every rule, each a linear-time check. Exported for the timing tests. */
export const CREDENTIAL_CHECKS: ReadonlyArray<(text: string) => boolean> = [
  ...CREDENTIAL.map((pattern) => (text: string) => pattern.test(text)),
  globNearKeys,
];

/** Not a letter, digit or `-` before (so `--rm` is not rm), and not a
 *  letter or digit after. */
const RM = /(?<![A-Za-z0-9-])rm(?![A-Za-z0-9])/i;
/** A command word at the start or after a separator: `dd`, `del`, `rd`. */
const AT_COMMAND = /(?<![^\s;&|(){}`])(?:dd|del|erase|rd|ri)(?=\s)/i;
/** Words that delete or run anything, not after `-` (so `git fetch --prune`
 *  and `mongo --eval` are left to their own rules). */
const VERB = /(?<![A-Za-z0-9-])(?:delete|destroy|prune|purge|dropdb|dropuser|flushall|flushdb|dropdatabase|unpublish|eval)(?![A-Za-z0-9])/i;

const DESTRUCTIVE: RegExp[] = [
  RM,
  word("rmdir|unlink|shred|srm|wipefs|rimraf|rmtree|trash|trash-put|tee|sudo|doas|truncate|mkfs|newfs|fdisk|diskutil|remove-item|clear-content|set-content|out-file|rmSync|rmdirSync|unlinkSync"),
  AT_COMMAND,
  VERB,
  // find's -delete
  /(?<![A-Za-z0-9-])-delete(?![A-Za-z0-9-])/i,
  // a delete from code: shutil.rmtree, os.remove, fs.rmSync, FileUtils.rm_rf, x.delete()
  /\.(?:remove|removedirs|unlink|unlinkSync|rmtree|rm|rm_r|rm_rf|rmdir|rmdirSync|rmSync|delete|deleteSync|deleteIfExists|trash)(?![A-Za-z0-9])/i,
  // SQL that drops or empties data
  /(?<![A-Za-z0-9])(?:drop\s+(?:table|database|schema|view|index|collection|user)|delete\s+from)(?![A-Za-z0-9])/i,
  // an HTTP DELETE; bounded, so a long run of spaces cannot backtrack far
  /(?:-X|--request)[\s=]{0,8}DELETE(?![A-Za-z0-9])/i,
  // a patch that deletes a file (Codex apply_patch)
  /\*\*\* Delete File:/i,
  // crontab -r removes the whole table
  /(?<![A-Za-z0-9])crontab\s+-[A-Za-z]*r/i,
  // a download run as code: $(curl …), <(wget …), `curl …`
  /(?:<\(|\$\(|`)\s*(?:curl|wget)(?![A-Za-z0-9])/i,
  // a shell or source fed a process substitution: bash <(…), source <(…), . <(…)
  /(?<![A-Za-z0-9])(?:(?:ba|z|da|k)?sh|source|\.)\s+<\(/i,
  // code that runs a command: os.system, subprocess, child_process, system(), exec(), eval()
  /(?<![A-Za-z0-9_])(?:os\.(?:system|popen|exec[a-z]*|spawn[a-z]*)|subprocess|child_process|execSync|execFileSync|spawnSync|system\s*\(|exec\s*\(|eval\s*\()/i,
];

const MAX_REDIRECTS = 16;
/** The files a `>` overwrites: not `>>`, not `2>&1`, not `=>` `->` `>=`, and
 *  not /dev/null. A scan, not a regex: linear whatever the input. Stops
 *  after MAX_REDIRECTS + 1, which is already too many to check. */
function redirectTargets(text: string): string[] {
  const out: string[] = [];
  for (let i = text.indexOf(">"); i !== -1 && out.length <= MAX_REDIRECTS; i = text.indexOf(">", i + 1)) {
    const prev = i > 0 ? text[i - 1] : "";
    const next = text[i + 1] ?? "";
    if (prev === ">" || prev === "<" || prev === "=" || prev === "-" || prev === "|" || next === ">" || next === "&" || next === "=") continue;
    let j = i + 1;
    if (text[j] === "|") j += 1;
    while (j < text.length && (text[j] === " " || text[j] === "\t")) j += 1;
    let k = j;
    while (k < text.length && !" \t\n\r;&|<>()".includes(text[k]!)) k += 1;
    const target = text.slice(j, k).replace(/^["']|["']$/g, "");
    if (!target || /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/.test(target)) continue;
    out.push(target);
  }
  return out;
}

/** The commands of a shell line as words: split at ; & | newline ( ) and
 *  backticks, then at whitespace. Linear. */
function commandWords(text: string): string[][] {
  return text.split(/[;&|\n()`]+/).map((segment) => segment.split(/\s+/).filter(Boolean));
}
const base = (token: string) => token.slice(token.lastIndexOf("/") + 1).toLowerCase();

/** git that throws work away or rewrites a remote: clean, reset --hard,
 *  push --force (and -f, +ref, :ref, --delete, --mirror), checkout -f, --
 *  or ., restore, worktree remove, branch -D, stash drop/clear and the like. */
function gitDiscards(text: string): boolean {
  if (!text.toLowerCase().includes("git")) return false;
  for (const tokens of commandWords(text.toLowerCase())) {
    const at = tokens.findIndex((token) => base(token) === "git");
    if (at === -1) continue;
    const rest = tokens.slice(at + 1);
    const has = new Set(rest);
    const shortFlag = (letter: string) => rest.some((token) => token.startsWith("-") && !token.startsWith("--") && token.includes(letter));
    if (has.has("clean") || has.has("restore") || has.has("filter-branch") || has.has("filter-repo")) return true;
    if (has.has("reset") && has.has("--hard")) return true;
    if (has.has("push") && (shortFlag("f") || shortFlag("d") || rest.some((token) => token.startsWith("--force") || token === "--delete" || token === "--mirror" || token === "--prune" || (token.length > 1 && (token.startsWith("+") || token.startsWith(":")))))) return true;
    if (has.has("checkout") && (shortFlag("f") || has.has("--force") || has.has("--") || has.has("."))) return true;
    if (has.has("switch") && (shortFlag("f") || has.has("--force") || has.has("--discard-changes"))) return true;
    if (has.has("worktree") && (has.has("remove") || has.has("prune"))) return true;
    if (has.has("branch") && shortFlag("d")) return true;
    if (has.has("stash") && (has.has("drop") || has.has("clear"))) return true;
    if (has.has("update-ref") && shortFlag("d")) return true;
    if (has.has("reflog") && has.has("expire")) return true;
  }
  return false;
}

/** rsync that deletes (--delete*, --del, --remove-source-files), and a
 *  recursive chmod/chown/chgrp. By words, per command. */
function commandFlags(text: string): boolean {
  const lower = text.toLowerCase();
  if (!lower.includes("rsync") && !lower.includes("ch")) return false;
  for (const tokens of commandWords(text)) {
    const names = new Set(tokens.map(base));
    if (names.has("rsync") && tokens.some((token) => token.startsWith("--del") || token === "--remove-source-files")) return true;
    if ((names.has("chmod") || names.has("chown") || names.has("chgrp")) && tokens.some((token) => token === "--recursive" || (/^-[A-Za-z]*R/.test(token)))) return true;
  }
  return false;
}

const SHELLS = /^(?:(?:ba|z|da|k|fi|c|tc)?sh|python[0-9.]*|perl|ruby|node|nodejs|deno|bun|php|pwsh|powershell|osascript)$/;
const PREFIXES = new Set(["sudo", "doas", "env", "command", "exec", "nohup", "time"]);
/** Something piped into a shell or an interpreter: `curl … | sh`,
 *  `base64 -d | bash`, `| sudo python3`. A scan: each `|` reads at most a
 *  few words, none past the next `|`. */
function pipesToShell(text: string): boolean {
  for (let i = text.indexOf("|"); i !== -1; i = text.indexOf("|", i + 1)) {
    if (text[i + 1] === "|" || (i > 0 && text[i - 1] === "|")) continue;
    let j = i + 1;
    for (let words = 0; words < 4; words += 1) {
      while (j < text.length && (text[j] === " " || text[j] === "\t" || text[j] === "\n" || text[j] === "\r")) j += 1;
      let k = j;
      while (k < text.length && !" \t\n\r;&|<>()".includes(text[k]!)) k += 1;
      const token = base(text.slice(j, k).replace(/^["']|["']$/g, ""));
      if (!token) break;
      if (SHELLS.test(token)) return true;
      if (!PREFIXES.has(token)) break;
      j = k;
    }
  }
  return false;
}

/** A shell line as commands of words, reading quotes: `'a b'` and `"a b"`
 *  are one word, a backslash escapes the next character, and ; & | newline
 *  ( ) and backticks end a command only outside quotes. One pass, linear. */
function shellCommands(text: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote = "";
  const endWord = () => { if (inWord) words.push(word); word = ""; inWord = false; };
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === "\"" && i + 1 < text.length) { i += 1; word += text[i]; }
      else word += c;
      continue;
    }
    if (c === "'" || c === "\"") { quote = c; inWord = true; continue; }
    if (c === "\\" && i + 1 < text.length) { i += 1; word += text[i]; inWord = true; continue; }
    if (c === " " || c === "\t" || c === "\r") { endWord(); continue; }
    if (";&|\n()`".includes(c)) { endCommand(); continue; }
    word += c;
    inWord = true;
  }
  endCommand();
  return commands;
}

const WRITERS = /(?<![A-Za-z0-9])(?:mv|cp|install|ditto|ln|sed|perl|tar|unzip|patch|rsync|scp|curl|wget)(?![A-Za-z0-9])/;
const LEADERS = new Set(["sudo", "doas", "env", "command", "builtin", "exec", "nohup", "time", "nice"]);

/** The value of an option: `-C dir`, `-Cdir`, `--directory=dir`, `--directory dir`. */
function optionValue(args: string[], short: string | undefined, long: string | undefined): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (short && a === short) { if (args[i + 1] !== undefined) out.push(args[i + 1]!); i += 1; continue; }
    if (short && a.startsWith(short) && !a.startsWith("--") && a.length > short.length && short.length === 2) { out.push(a.slice(2)); continue; }
    if (long && a === long) { if (args[i + 1] !== undefined) out.push(args[i + 1]!); i += 1; continue; }
    if (long && a.startsWith(`${long}=`)) out.push(a.slice(long.length + 1));
  }
  return out;
}

/** The files a shell command writes, moves, links, extracts into or
 *  downloads to, or undefined when the line runs no such command:
 *  mv (every path), cp/install/ditto/ln/rsync/scp (the destination or -t),
 *  sed -i and perl -i (the files), tar -x/-c (-C, or the archive it
 *  creates), unzip -d, patch (its files and -d, else the folder),
 *  curl -o and wget -O. Read per command at the command word (after sudo,
 *  env or VAR=value), so `npm install` is not `install`. */
function writeTargets(text: string): string[] | undefined {
  if (!WRITERS.test(text)) return undefined;
  const out: string[] = [];
  let found = false;
  for (const tokens of shellCommands(text)) {
    let at = 0;
    while (at < tokens.length && (LEADERS.has(base(tokens[at]!)) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[at]!) || (at > 0 && tokens[at]!.startsWith("-") && LEADERS.has(base(tokens[at - 1]!))))) at += 1;
    if (base(tokens[at] ?? "") === "git" && tokens[at + 1] === "mv") at += 1;
    const name = base(tokens[at] ?? "");
    const args = tokens.slice(at + 1);
    const plain = args.filter((a) => !a.startsWith("-") && a !== "");
    const flags = args.filter((a) => a.startsWith("-"));
    const last = plain.length ? [plain[plain.length - 1]!] : [];
    let targets: string[] | undefined;
    if (name === "mv") targets = plain;
    else if (name === "cp" || name === "install" || name === "ditto" || name === "ln" || name === "rsync" || name === "scp") {
      const into = optionValue(args, "-t", "--target-directory");
      targets = into.length ? into : name === "install" && flags.some((f) => f === "-d" || f === "--directory") ? plain : last;
    } else if (name === "sed" || name === "perl") {
      if (flags.some((f) => f.startsWith("--in-place") || (!f.startsWith("--") && f.includes("i")))) targets = plain;
    } else if (name === "tar") {
      // the mode letters: every short flag but -C (its folder), and a bare first word (`tar xzf`)
      const mode = [...flags.filter((f) => !f.startsWith("--") && !f.startsWith("-C")), args[0] && !args[0].startsWith("-") ? args[0] : ""].join("");
      const extract = /x/.test(mode) || flags.includes("--extract") || flags.includes("--get");
      const create = /[cru]/.test(mode) || flags.includes("--create") || flags.includes("--append") || flags.includes("--update");
      if (extract) {
        const into = optionValue(args, "-C", "--directory");
        targets = into.length ? into : ["."];
      }
      if (create) {
        const bundle = args.findIndex((a) => /^-?[A-Za-z]*f$/.test(a) && !a.startsWith("--"));
        targets = [...(targets ?? []), ...optionValue(args, undefined, "--file"), ...(bundle !== -1 && args[bundle + 1] !== undefined ? [args[bundle + 1]!] : [])];
      }
    } else if (name === "unzip") {
      const into = optionValue(args, "-d", undefined);
      targets = into.length ? into : ["."];
    }
    else if (name === "patch") {
      const dir = optionValue(args, "-d", "--directory");
      targets = [...dir, ...optionValue(args, "-o", "--output"), ...plain.slice(0, 1)];
      if (!targets.length) targets = ["."];
    } else if (name === "curl") {
      const to = [...optionValue(args, "-o", "--output")];
      if (to.length || flags.some((f) => f === "-O" || f === "--remote-name")) targets = to.length ? to : ["."];
    } else if (name === "wget") {
      const to = optionValue(args, "-O", "--output-document");
      targets = to.length ? to.filter((t) => t !== "-") : undefined;
    }
    if (targets === undefined) continue;
    found = true;
    // a command that writes but names nothing: nobody can say where
    if (!targets.length) return [""];
    out.push(...targets);
    if (out.length > MAX_REDIRECTS) break;
  }
  return found ? out : undefined;
}

// B1 (device/review finding 2026-10-01): `python3 -c "open('/x','w').write(…)"`
// rated low. The destructive patterns above only catch named file-ops
// (os.remove, shutil.rmtree, fs.rmSync…); inline code handed to an
// interpreter's eval flag is never inspected, so its effect can never be
// shown read-only. Fail safe: that code, and running a script file whose
// contents nobody here reads, are risky on their own, whatever they say.
const INTERPRETERS = new Set(["python", "python2", "python3", "pypy", "pypy3", "ruby", "perl", "php", "node", "nodejs", "bun", "osascript", "pwsh", "powershell", "bash", "sh", "zsh", "dash", "ksh"]);
const EVAL_FLAGS = new Set(["-c", "-e", "-r", "--eval", "-command"]);
const SCRIPT_EXT = /\.(?:sh|bash|zsh|py|rb|pl|php|ps1|psm1|js|mjs|cjs|scpt|applescript)$/i;
function interpreterExec(text: string): boolean {
  for (const tokens of shellCommands(text)) {
    let at = 0;
    while (at < tokens.length && (LEADERS.has(base(tokens[at] ?? "")) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[at] ?? ""))) at += 1;
    const head = tokens[at] ?? "";
    const name = base(head);
    if (INTERPRETERS.has(name)) {
      const rest = tokens.slice(at + 1);
      if (rest.some((token) => EVAL_FLAGS.has(token.toLowerCase()))) return true;
      // a project's own script run by a bare relative name (manage.py,
      // build.sh) is an ordinary workflow; an explicit path to a script
      // (./deploy.sh, scripts/x.py, ~/x.rb, /opt/x.pl) is not.
      const firstPositional = rest.find((token) => !token.startsWith("-"));
      if (firstPositional && firstPositional.includes("/") && SCRIPT_EXT.test(firstPositional)) return true;
    } else if ((head.startsWith("./") || head.startsWith("/") || head.startsWith("~/")) && SCRIPT_EXT.test(head)) {
      return true;
    }
  }
  return false;
}

/** Every destructive rule, each a linear-time check. Exported for the timing tests. */
export const DESTRUCTIVE_CHECKS: ReadonlyArray<(text: string) => boolean> = [
  ...DESTRUCTIVE.map((pattern) => (text: string) => pattern.test(text)),
  gitDiscards,
  commandFlags,
  pipesToShell,
  interpreterExec,
  (text: string) => redirectTargets(text).length > 0,
  (text: string) => writeTargets(text) !== undefined,
];
/** The rules that do not depend on where a file lands. */
const ALWAYS_RISKY = DESTRUCTIVE_CHECKS.slice(0, -2);

/** The words of a tool's own name, after any `mcp__server__` prefix. */
function toolWords(tool: string): string[] {
  const bare = tool.split("__").pop() ?? tool;
  return bare.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
const DELETE_WORDS = new Set(["delete", "remove", "rm", "rmdir", "trash", "unlink", "destroy", "erase", "wipe", "purge", "drop", "truncate", "shred"]);
const WRITE_WORDS = new Set(["write", "edit", "editor", "multiedit", "notebookedit", "create", "save", "patch", "replace", "move", "mv", "rename", "overwrite", "append", "insert", "copy", "cp", "mkdir", "upload"]);
const COMMAND_TOOLS = new Set(["bash", "shell", "sh", "zsh", "powershell", "pwsh", "execute", "exec_command", "run_command", "computer_exec", "terminal", "run_shell_command", "run_terminal_cmd"]);
const COMMAND_KEYS = ["command", "cmd", "script"];
const PATH_KEYS = [
  "path", "paths", "file_path", "filePath", "notebook_path", "notebookPath", "abs_path", "absPath", "absolute_path", "absolutePath", "filename", "fileName",
  "uri", "target", "target_file", "file", "files", "directory", "dir", "destination", "dest", "source", "src", "dst", "from", "to",
  "new_path", "newPath", "old_path", "oldPath",
];
/** More strings than this in one value is not read: rated risky. */
const MAX_PARTS = 256;

/** One input value as strings: a string, or an array of strings. Anything
 *  else, or too many parts, is undefined (unreadable). */
function strings(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.length <= MAX_PARTS && value.every((part) => typeof part === "string")) return value as string[];
  return undefined;
}

/** A path as a file path: `file://` stripped; any other URI scheme is a place
 *  nobody can check, kept as is (never inside). */
const filePath = (value: string) => {
  if (!value.startsWith("file://")) return value;
  try { return decodeURI(value.slice("file://".length)); } catch { return value; }
};

interface InputRead { command: string; paths: string[]; unreadablePath: boolean; hasCommand: boolean }

/** What the engine's own tool input says: its command and the paths it
 *  names (never file content). Undefined when a command is there but cannot
 *  be read, or the whole is too long to check. */
function readInput(input: unknown): InputRead | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { command: "", paths: [], unreadablePath: false, hasCommand: false };
  const obj = input as Record<string, unknown>;
  const parts: string[] = [];
  const paths: string[] = [];
  let unreadablePath = false;
  for (const key of COMMAND_KEYS) {
    if (obj[key] === undefined) continue;
    const found = strings(obj[key]);
    if (!found) return undefined;
    parts.push(found.join(" "));
  }
  for (const key of PATH_KEYS) {
    if (obj[key] === undefined || obj[key] === null) continue;
    const found = strings(obj[key]);
    if (found) paths.push(...found.map(filePath));
    else unreadablePath = true;
  }
  // ACP: locations: [{ path }]
  if (obj.locations !== undefined) {
    if (!Array.isArray(obj.locations) || obj.locations.length > MAX_PARTS) unreadablePath = true;
    else for (const location of obj.locations) {
      const path = location && typeof location === "object" ? (location as { path?: unknown }).path : undefined;
      if (typeof path === "string") paths.push(filePath(path));
      else unreadablePath = true;
    }
  }
  if (paths.length > MAX_PARTS) return undefined;
  const command = parts.join(" ");
  if (command.length > MAX_RISK_TEXT || paths.join(" ").length > MAX_RISK_TEXT) return undefined;
  return { command, paths, unreadablePath, hasCommand: parts.length > 0 };
}

/** The engine's tool call behind a permission, when the caller has it. */
export interface PushRiskCall {
  /** The card's tool input was cut: the owner cannot see all of it. */
  truncated?: boolean;
  /** The request's approval scope. Local-computer control is exempt from the
   *  stop line (the `computer` server "carries its own approval"), so the
   *  scope itself forces step-up: any value at all is risky. */
  scope?: string;
  /** The engine's structured tool input (event.toolCall.input). */
  input?: unknown;
  /** The engine's own name for the tool (event.toolCall.name): for ACP,
   *  `tool` is only the kind (`edit`, `other`). */
  name?: string;
  /** The paths the driver read from the call (event.filePaths). */
  filePaths?: string[];
  /** Is this path inside the bot's workspace? Absent means nobody can say,
   *  so a write, a redirect, an mv or a cp is risky. */
  inside?: (path: string) => boolean;
  /** Only the card is known (a push revision re-rated from its live card),
   *  not the engine's call: a write tool is not required to name a path.
   *  Absent means this IS the engine's call, which is the safe default. */
  cardOnly?: true;
}

/** Fails safe: only an absent hit (null, undefined, false) counts as none,
 *  so any other stopHit value, truthy or not, is risky; and a tool or
 *  summary that is not text cannot be checked, so it is risky too. */
export function pushRiskFor(stopHit: unknown, tool: string, summary: string, call?: PushRiskCall): "low" | "risky" {
  if (stopHit !== null && stopHit !== undefined && stopHit !== false) return "risky";
  if (call?.truncated) return "risky";
  if (call?.scope) return "risky";
  if (typeof tool !== "string" || typeof summary !== "string") return "risky";
  if (tool.length + summary.length + 1 > MAX_RISK_TEXT) return "risky";
  const engine = call && !call.cardOnly ? call : undefined;
  const name = typeof engine?.name === "string" ? engine.name : "";
  if (name.length > MAX_RISK_TEXT) return "risky";
  const read = engine ? readInput(engine.input) : { command: "", paths: [], unreadablePath: false, hasCommand: false };
  if (!read) return "risky";
  // the command is held to the same cap as the card text, each on its own
  if (tool.length + read.command.length + 1 > MAX_RISK_TEXT) return "risky";
  const filePaths = engine?.filePaths;
  if (filePaths !== undefined && (!Array.isArray(filePaths) || filePaths.length > MAX_PARTS || !filePaths.every((p) => typeof p === "string"))) return "risky";
  const paths = [...read.paths, ...(filePaths ?? []).map(filePath)];
  const words = new Set([...toolWords(tool), ...toolWords(name)]);
  const has = (set: Set<string>) => [...words].some((w) => set.has(w));
  if (has(DELETE_WORDS)) return "risky";
  const inside = call?.inside;
  const placed = (path: string) => {
    if (!inside || !path || /[$`*?{}]/.test(path)) return false;
    // host:path (scp, rsync) is another machine; C:\\ and C:/ are Windows drives
    const colon = path.indexOf(":");
    if (colon !== -1 && colon < (path.indexOf("/") === -1 ? Infinity : path.indexOf("/")) && !/^[A-Za-z]:[\\/]/.test(path)) return false;
    try { return inside(path) === true; } catch { return false; }
  };
  const writes = has(WRITE_WORDS) || (words.has("set") && (words.has("content") || words.has("contents") || words.has("file")));
  // a revision re-rated from its card when the workspace cannot be found:
  // a write cannot be shown inside, so it is not
  if (call?.cardOnly && !inside && writes) return "risky";
  if (engine) {
    // a tool that writes must say where, readably, and land inside
    if (writes && (read.unreadablePath || !paths.length || !paths.every(placed))) return "risky";
    // a known shell whose input carries no readable command
    if (engine.input !== undefined && has(COMMAND_TOOLS) && !read.hasCommand) return "risky";
  }
  // Commands are what the card and the engine say; paths are only checked
  // for credentials (a path named `rm/` or `tee.go` is not a command).
  // one per line, so each reads as its own command
  const commandText = [tool, name, summary, read.command].filter(Boolean).join("\n");
  const pathText = paths.join(" ");
  if (CREDENTIAL_CHECKS.some((check) => check(commandText) || (pathText !== "" && check(pathText)))) return "risky";
  if (ALWAYS_RISKY.some((check) => check(commandText))) return "risky";
  // a redirect or a shell write (mv, cp, sed -i, tar -C, unzip -d, ln, curl -o…)
  // may stay low when every file it touches is inside
  const moves = writeTargets(commandText);
  // the card text and the engine's command say the same thing twice
  const targets = [...new Set([...redirectTargets(commandText), ...(moves ?? [])])];
  if (moves !== undefined && !moves.length) return "risky";
  if (targets.length > MAX_REDIRECTS || !targets.every(placed)) return "risky";
  // B1 round 1: for a shell command, "low" is an allowlist outcome. Whatever
  // the rules above did not flag still needs to be positively read-only; an
  // interpreter, a script, a wrapper or a quoting trick is not, whatever it
  // says. The engine's own command is what runs, so it wins over the card.
  if (has(COMMAND_TOOLS) || read.hasCommand) {
    const shown = read.hasCommand ? read.command : summary;
    // a root counts as inside for a READ (the strict delete check would not
    // accept the workspace itself): a path is inside if it, or a child of it, is
    // Only the cwd itself ("." or "./") may fall back to a child probe: a probe
    // under any other path would not exist, realpath would fail, and a symlink
    // there (a link named `-` or `lnk`) would pass on its text alone.
    const readable = (path: string) => placed(path) || (/^\.\/*$/.test(path) && placed("./.read-probe"));
    if (!isReadOnlyCommand(shown, readable)) return "risky";
  }
  return "low";
}

/** For index.ts: is a path inside the bot's own folders, by the stop line's
 *  own reading of its place, with the temp roots left out (a home under
 *  /tmp must not make ~/Documents the bot's folder)? Never throws. */
export function workspaceInside(place: StopLinePlace, tempRoots: readonly string[]): (path: string) => boolean {
  const temp = new Set(tempRoots);
  const narrowed: StopLinePlace = { ...place, roots: place.roots.filter((root) => !temp.has(root)) };
  return (path) => {
    // the stop line reads a tool's path literally, so `$HOME/a` would be a
    // folder named `$HOME` in the workspace; nothing here expands it, so a
    // variable, a command substitution or `~user` is never inside
    if (path === "" || /[$`]/.test(path) || (path.startsWith("~") && path !== "~" && !path.startsWith("~/"))) return false;
    try { return classifyStopLine("delete", { path }, "", narrowed) === null; } catch { return false; }
  };
}

type LiveCard = { stopHit: unknown; tool: unknown; summary: unknown; inside?: (path: string) => boolean; truncated?: boolean; scope?: unknown } | null;

/** The rating a request has right now, from its stored base rating and its
 *  live card. Push (ratePushRevision) and in-app fresh auth
 *  (server/approval-fresh-auth.ts via index.ts freshAuthNeeded) both read
 *  this, so there is one rule. Never writes. */
export function liveRating(base: "low" | "risky" | "unrated", live: LiveCard): "low" | "risky" | "unrated" {
  if (base === "unrated" || !live) return "unrated";
  if (base === "risky") return "risky";
  // card only: an unknown workspace (no inside) rates a write risky, never skips it
  return pushRiskFor(live.stopHit, live.tool as string, live.summary as string, { cardOnly: true, ...(live.inside ? { inside: live.inside } : {}), ...(live.truncated ? { truncated: true } : {}), ...(live.scope ? { scope: String(live.scope) } : {}) });
}

/** H10, the H9 re-review's Concern 1: rate one push revision of a request
 *  from its live card. Only a request the engine-permission path rated
 *  (a row with any revision) is rated again; anything else, and a card
 *  that is gone, leaves the revision unrated, so Allow needs the app. The
 *  rating only climbs: once risky it stays risky, which also covers a stop
 *  line hit no longer held in memory. */
export function ratePushRevision(
  store: {
    risk(threadId: string, requestId: string, revision?: number): "low" | "risky" | "unrated";
    rateRisk(threadId: string, requestId: string, risk: "low" | "risky", now: number, revision?: number): void;
  },
  threadId: string,
  requestId: string,
  revision: number,
  live: LiveCard,
  now: number,
): "low" | "risky" | "unrated" {
  const rating = liveRating(store.risk(threadId, requestId), live);
  if (rating === "unrated") return "unrated";
  store.rateRisk(threadId, requestId, rating, now, revision);
  return rating;
}
