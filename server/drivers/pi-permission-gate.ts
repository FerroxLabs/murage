// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// pi-permission-gate: Murage's approvals for the pi engine
// (lanes/release103/APP-GRANT-DESIGN-FINAL.AGREED-r10.md Rules 13..16, 60, 63, 73d).
//
// Pi has no permission system of its own: its bash, edit and write tools run
// the moment the model calls them. Murage's gate is loaded into the per-turn
// `pi --mode rpc` process with `-e`, like pi-mcp-extension.ts, and shipped
// verbatim as .ts. It imports nothing of Murage's (only node built-ins): the
// shared path check, the sensitive list and the directory walk are carried
// INLINE below between the `@inline` markers, and pi-permission-gate.test.ts
// (T105) asserts each block equals its module's source.
//
// What the gate trusts is exactly three sets (Rule 14): Pi's own tools by
// `toolName`; mounted MCP tools by the exact allocated name in the process-
// global table pi-mcp-extension.ts writes; nothing else. Anything outside
// them is blocked, never run and never asked. The whole `tool_call` body is
// one `try` whose `catch` RETURNS a block: Pi's runner has no `try` around a
// `tool_call` handler, so the gate does not depend on a throw to block.
//
// The ask travels as an `editor` dialog (extension_ui_request over RPC). The
// title carries a per-turn secret the driver generates and hands over in
// MURAGE_PI_GATE; the prefill carries the whole call as JSON. The driver
// answers `{"allow": true, "input": {...}}` or `{"deny": true, "reason": ...}`
// and the gate applies the input in place on `event.input`. The secret is
// removed from this process's environment on load so the commands pi runs
// never inherit it.

import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { posix, win32 } from "node:path";

// @inline begin shared/scan-limits.ts
const GATE_MESSAGE_BYTES = 16 * 1024 * 1024;
const WALK_CACHE_MS = 10_000;
const WALK_ENTRIES = 100_000;
const WALK_MS = 3_000;
// @inline end shared/scan-limits.ts

// @inline begin shared/sensitive-paths.ts
interface SensitivePathRow {
  id: string;
  re: RegExp;
  /** The shape read instead of `re` on a folder a path only passes through
   * on the way to its target, or a folder a directory walk meets. Absent:
   * `re` is read there too. */
  ancestor?: RegExp;
  /** Claude `permissions.ask` Read rules for this row: in-project rows
   * relative, home rows as `~/`. */
  read: readonly string[];
  /** Claude `permissions.ask` Bash text rules for the same names. */
  bash: readonly string[];
}

const SENSITIVE_PATHS: readonly SensitivePathRow[] = [
  {
    id: "env",
    re: /(^|[\s/\\"'])\.env(\.|$|["'\s])/i,
    read: [".env", ".env.*"],
    bash: ["* .env*", "*/.env*"],
  },
  {
    id: "ssh",
    re: /\.ssh[\\/]|id_rsa|id_ed25519|authorized_keys/i,
    read: ["~/.ssh/**"],
    bash: ["*.ssh/*", "*id_rsa*", "*id_ed25519*", "*authorized_keys*"],
  },
  {
    id: "credential-files",
    re: /\.aws[\\/]credentials|\.netrc|\.npmrc|\.pypirc|\.docker[\\/]config\.json/i,
    read: ["~/.aws/credentials", "~/.netrc", "~/.npmrc", "~/.pypirc", "~/.docker/config.json"],
    bash: ["*.aws/credentials*", "*.netrc*", "*.npmrc*", "*.pypirc*", "*.docker/config.json*"],
  },
  {
    id: "credentials-json",
    re: /\bcredentials?\.json\b|\bserviceaccount\b/i,
    read: ["**/credentials.json", "**/credential.json", "**/*serviceaccount*"],
    bash: ["*credentials.json*", "*credential.json*", "*serviceaccount*"],
  },
  {
    // 2026-09-17 (thread e4454625): an auto-mode bot lifted a personal OpenAI
    // key by reading the shell profile. Shell rc files are where people keep
    // keys, and (Rule 74b) the files that shape every shell the owner runs.
    id: "shell-rc",
    // `$HOME/.zshrc`, `${HOME}/.zshrc`, `$env:HOME\.zshrc` and `%USERPROFILE%\.zshrc` name the same file as `~/.zshrc`
    re: /(^|[\s"'=])~?[\w./${}:%\\-]*\.(zshrc|zshenv|zprofile|bashrc|bash_profile|profile)\b/i,
    read: ["~/.zshrc", "~/.zshenv", "~/.zprofile", "~/.bashrc", "~/.bash_profile", "~/.profile"],
    bash: ["*.zshrc*", "*.zshenv*", "*.zprofile*", "*.bashrc*", "*.bash_profile*", "*.profile*"],
  },
  {
    id: "harness-keys",
    re: /\.codex[\\/]auth\.json|\.claude[\\/]\.credentials|provider-keys|\.murage[\\/]config\.json/i,
    read: ["~/.codex/auth.json", "~/.claude/.credentials*", "~/.murage/config.json", "**/provider-keys*"],
    bash: ["*.codex/auth.json*", "*.claude/.credentials*", "*provider-keys*", "*.murage/config.json*"],
  },
  // Desktop userData can be relocated by restore profiles: match the
  // store basename, not only the default Murage directory.
  {
    id: "murage-desktop-secrets",
    re: /(?:^|[\s\\/"'=])credentials\.bin(?:$|[\s"';|&)\\/])|provider-keys/i,
    read: ["**/credentials.bin", "**/provider-keys*"],
    bash: ["*credentials.bin*", "*provider-keys*"],
  },
  // Rule 35: the Windows spellings, rows of their own.
  {
    id: "windows-credential-files",
    re: /(^|[\s\\/"'])_(netrc|npmrc)\b|\.azure[\\/]|appdata[\\/]roaming[\\/](gcloud|npm)[\\/]|[\\/]login data\b/i,
    read: ["~/_netrc", "~/_npmrc", "~/.azure/**", "~/AppData/Roaming/gcloud/**", "~/AppData/Roaming/npm/**", "**/Login Data"],
    bash: ["*_netrc*", "*_npmrc*", "*.azure*", "*AppData*Roaming*gcloud*", "*AppData*Roaming*npm*", "*Login Data*"],
  },
  {
    id: "keys-and-cluster-configs",
    re: /id_ecdsa|\.ssh[\\/][^\s"']*\.(pem|ppk)\b|\.kube[\\/]config\b|\.git-credentials\b|\.pgpass\b|\bcredentials\.db\b/i,
    read: ["**/id_ecdsa*", "~/.ssh/*.pem", "~/.ssh/*.ppk", "~/.kube/config", "~/.git-credentials", "~/.pgpass", "**/credentials.db"],
    bash: ["*id_ecdsa*", "*.ssh/*.pem*", "*.ssh/*.ppk*", "*.kube/config*", "*.git-credentials*", "*.pgpass*", "*credentials.db*"],
  },
  // Rule 35 with Rule 74b/74d: the startup files that run in a shell, read AND
  // write, beyond the rc row above.
  {
    id: "shell-startup",
    re: /\.(zlogin|zlogout|bash_login|bash_logout|psqlrc)\b|\.config[\\/]fish[\\/](config\.fish|conf\.d[\\/])|\$\{?ZDOTDIR\}?[\\/]\.z/i,
    read: ["~/.zlogin", "~/.zlogout", "~/.bash_login", "~/.bash_logout", "~/.psqlrc", "~/.config/fish/config.fish", "~/.config/fish/conf.d/**"],
    bash: ["*.zlogin*", "*.zlogout*", "*.bash_login*", "*.bash_logout*", "*.psqlrc*", "*fish/config.fish*", "*fish/conf.d*", "*ZDOTDIR*"],
  },
  {
    id: "system-startup",
    re: /(^|[\s"'=])\/etc\/(profile\b|profile\.d\/|bash\.bashrc\b|bashrc\b|zshenv\b|zsh\/zshenv\b|zprofile\b|zshrc\b|zlogin\b)/,
    read: ["/etc/profile", "/etc/profile.d/**", "/etc/bash.bashrc", "/etc/bashrc", "/etc/zshenv", "/etc/zsh/zshenv", "/etc/zprofile", "/etc/zshrc", "/etc/zlogin"],
    bash: ["*/etc/profile*", "*/etc/bash.bashrc*", "*/etc/bashrc*", "*/etc/zshenv*", "*/etc/zsh/zshenv*", "*/etc/zprofile*", "*/etc/zshrc*", "*/etc/zlogin*"],
  },
  // Rule 35 (d7-7): a persistent pager or editor override is a write here.
  {
    id: "gitconfig",
    re: /(^|[\s/"'=~])\.gitconfig\b/i,
    read: ["~/.gitconfig"],
    bash: ["*.gitconfig*"],
  },
  // Rule 63 step 3: sensitive INSIDE the project too.
  {
    id: "project-git",
    re: /(^|[\s/"'])\.git[\\/](config\b|hooks([\\/]|$))/i,
    read: [".git/config", ".git/hooks/**"],
    bash: ["*.git/config*", "*.git/hooks*"],
  },
  {
    id: "project-tooling",
    re: /(^|[\s/"'])(\.claude[\\/]settings[^\\/\s"']*\.json\b|\.vscode[\\/]tasks\.json\b|\.husky([\\/]|$)|node_modules[\\/]\.bin([\\/]|$))/i,
    read: [".claude/settings*.json", ".vscode/tasks.json", ".husky/**", "node_modules/.bin/**"],
    bash: ["*.claude/settings*", "*.vscode/tasks.json*", "*.husky*", "*node_modules/.bin*"],
  },
  // Rule 74b/74d: Murage's own murage-exec wrapper and the per-turn env
  // file it reads; a write to either would change what every command runs.
  {
    id: "murage-exec",
    re: /murage-exec(-[0-9a-f]+)?([\\/]|$|["'\s])/i,
    read: ["**/murage-exec*/**", "**/murage-exec*"],
    bash: ["*murage-exec*"],
  },
  // 1.0.3 (hook self-guard): the hook programs Murage writes for an engine and
  // the folders they live in (DATA_DIR/native/antigravity-relay, -ask, -scope
  // and codex-scope). The engine re-reads them on every call, so a write to one
  // would replace the guard that judges every later call.
  {
    id: "murage-engine-hooks",
    re: /(?<![\w.-])(?:(?:antigravity-(?:relay|ask|scope)|codex-scope)[. ]*(?:[\\/:]|$|["'\s;|&)>`])|murage-agy-relay|murage-hook\.(?:mjs|cmd|env)\b|ask-hook-[\w.-]*\.cjs\b)/i,
    read: ["**/native/antigravity-relay/**", "**/native/antigravity-ask/**", "**/native/antigravity-scope/**", "**/native/codex-scope/**", "**/murage-agy-relay*", "**/murage-hook.mjs", "**/murage-hook.cmd", "**/murage-hook.env", "**/ask-hook-*.cjs"],
    bash: ["*native/antigravity-relay*", "*native/antigravity-ask*", "*native/antigravity-scope*", "*native/codex-scope*", "*murage-agy-relay*", "*murage-hook.mjs*", "*murage-hook.cmd*", "*murage-hook.env*", "*ask-hook-*.cjs*"],
  },
  // agy 1.4.4 loads the hooks of the workspace's customization root (.agents, .agent, _agents, _agent: hooks.json,
  // plugins.json, plugins/<name>/hooks.json, and agents/*.md, whose front matter can carry hooks) beside Murage's
  // own, with no switch to turn that off. A bot that writes one would have its own hook run (and answer) on the next
  // turn, so a call naming one, or moving a file into the root folder itself, is held. The root folder alone is
  // read only as a PATH: after a separator, at a line or argument start, as a whole quoted shell argument or a
  // quoted call's only argument (os.chdir of ".agents"), and ending a line, an argument or a path (a `\` before a quote is
  // an escape, not a separator). So code (`turn.integrations?.agents;`, `const _agents = []`, `"_agent"`,
  // `".agents"` among other arguments) and prose ("the .agents folder") never match, while a quoted root followed by a quoted
  // hook-file segment (`".agents", "hooks.json"`) still does. A folder a path only passes through, or a walk meets,
  // reads only the hook files (`ancestor`), so .agents/skills and the rest of the folder stay ordinary files.
  // The plugins and agents folders may end in dots or spaces or carry a stream suffix (`.agents\plugins.`,
  // `plugins::$DATA`): Win32 reads those as the folder (lanes/release103/SG-WIN-PATHTRICKS.md), so the row does too.
  {
    id: "agy-workspace-hooks",
    re: /(?<![\w.-])[._]agents?[\\/](?:hooks\.json|plugins\.json|(?:plugins|agents)[. ]*(?:[\\/:]|$|["'\s;|&)>`]))|(?<=^|[\s"'=\\/])[._]agents?(?:\/|\\(?!["']))(?=$|["'\s;|&)>])|(?<=^|[\s=\\/])\.agents?(?=$|[\r\n"']|[ \t]*[;|&>)])|(?<=(?:^|[\s=])["'])\.agents?(?=["'](?:$|[\r\n]|[ \t]*(?:[;|>]|&&)))|(?<=\(["'])\.agents?(?=["']\))|(?<=[ \t=]["'])_agents?(?=["'](?:$|[\r\n]|[ \t]*(?:[;|>]|&&)))|(?<=^|[\s=\\/])_agents?(?=$|[\r\n"']|[ \t]*(?:[;|>]|&&))|(?<=["'])[._]agents?["'][ \t]*,[ \t]*["'](?:hooks\.json|plugins\.json|plugins|agents)["']/i,
    ancestor: /(?<![\w.-])[._]agents?[\\/](?:hooks\.json|plugins\.json|(?:plugins|agents)[. ]*(?:[\\/:]|$|["'\s;|&)>`]))/i,
    read: [".agents/hooks.json", ".agent/hooks.json", "_agents/hooks.json", "_agent/hooks.json", ".agents/plugins.json", ".agent/plugins.json", "_agents/plugins.json", "_agent/plugins.json", ".agents/plugins/**", ".agent/plugins/**", "_agents/plugins/**", "_agent/plugins/**", ".agents/agents/**", ".agent/agents/**", "_agents/agents/**", "_agent/agents/**"],
    bash: ["*.agents/hooks.json*", "*.agent/hooks.json*", "*_agents/hooks.json*", "*_agent/hooks.json*", "*.agents/plugins*", "*.agent/plugins*", "*_agents/plugins*", "*_agent/plugins*", "*.agents/agents*", "*.agent/agents*", "*_agents/agents*", "*_agent/agents*"],
  },
  {
    id: "envrc",
    re: /(^|[\s/"'])\.envrc\b/i,
    read: [".envrc"],
    bash: ["*.envrc*"],
  },
  // Fuigo 1.0.32 holds its own config files and permission grant stores as protected paths, at every mode but its
  // always-approve (shell_access.rs, permission manager): a write to one changes the rules that decide every later
  // call (an ask rule removed, a standing grant added). A request Fuigo raises for one is never answered by a mode or
  // a grant here either. The global home (~/.fuigo, or one named by $FUIGO_HOME) and a workspace's .fuigo alike.
  {
    id: "fuigo-engine-config",
    // Read as text, so it holds any call that names Fuigo's home (`.fuigo`, `$FUIGO_HOME`) and one of these files anywhere
    // in it, in either order: `~/.fuigo/./config.toml`, `.fuigo.\config.toml` and `cd ~/.fuigo && printf … >> config.toml` too.
    re: /(?:\.fuigo(?![\w-])|FUIGO_HOME)[\s\S]*?(?:(?:config|managed_config|requirements|sandbox)\.toml|permission[^\\/\s"']*\.toml)(?![\w-])|(?:config|managed_config|requirements|sandbox)\.toml(?![\w-])[\s\S]*?(?:\.fuigo(?![\w-])|FUIGO_HOME)/i,
    read: ["~/.fuigo/config.toml", "~/.fuigo/managed_config.toml", "~/.fuigo/requirements.toml", "~/.fuigo/sandbox.toml", "~/.fuigo/sessions/*/permission*.toml", ".fuigo/config.toml"],
    bash: ["*.fuigo/config.toml*", "*.fuigo/managed_config.toml*", "*.fuigo/requirements.toml*", "*.fuigo/sandbox.toml*", "*.fuigo/sessions/*/permission*"],
  },
];

interface SensitiveTextRow { id: string; re: RegExp }

const SENSITIVE_TEXT: readonly SensitiveTextRow[] = [
  { id: "keychain", re: /security\s+find-(generic|internet)-password|\bkeychain\b/i },
  { id: "key-name", re: /\b[A-Z][A-Z0-9_]*_(API_KEY|SECRET_KEY|ACCESS_TOKEN|AUTH_TOKEN)\b/ },
  { id: "bearer", re: /\bBearer\s+\$\{?[A-Za-z_]/i },
  { id: "key-literal", re: /\bsk-(proj|ant|or)?[-_]?[A-Za-z0-9]/ },
  { id: "env-grep", re: /\benv\b[^|;&]*\|\s*grep\b/i },
  // A command that prints the whole environment (or one variable's value): `env`, `printenv`, `export -p`, `declare -p`, `set` alone.
  // Only at the start of a command, so `env VAR=x cmd`, `export FOO=1` and a word like "environment" are ordinary.
  { id: "env-dump", re: /(?:^|[;&|(`\n]|\$\()\s*(?:(?:sudo|command|builtin)\s+)?(?:env(?:\s+-[0aiuS]+)*|printenv(?:\s+[A-Za-z_][A-Za-z0-9_]*)*|export\s+-p|declare\s+-[xp]+|set)\s*(?=$|[;&|)>`\n])/i },
  // Rule 74b: cmd's AutoRun runs on every cmd start; a change to it is a
  // sensitive write.
  { id: "cmd-autorun", re: /Command Processor[\s\S]*\bAutoRun\b/i },
];

/** The order the verdict has always matched in: the six original path rows
 * interleaved with the original text rows exactly as auto-approve held them,
 * then every row Rule 35 adds. Keeps the rule a log line names stable. */
const SENSITIVE_RULES: readonly RegExp[] = [
  SENSITIVE_PATHS[0]!.re, // env
  SENSITIVE_PATHS[1]!.re, // ssh
  SENSITIVE_PATHS[2]!.re, // credential files
  SENSITIVE_TEXT[0]!.re, // keychain
  SENSITIVE_PATHS[3]!.re, // credentials json
  SENSITIVE_PATHS[4]!.re, // shell rc
  SENSITIVE_TEXT[1]!.re,
  SENSITIVE_TEXT[2]!.re,
  SENSITIVE_TEXT[3]!.re,
  SENSITIVE_TEXT[4]!.re,
  SENSITIVE_PATHS[5]!.re, // harness keys
  ...SENSITIVE_PATHS.slice(6).map((row) => row.re),
  ...SENSITIVE_TEXT.slice(5).map((row) => row.re),
];

/** Rule 64: the template basenames. For a path INSIDE the project with one of
 * these basenames, the `.env` row does not match (every other row still
 * runs), and a write's body is read by the secret-shape rules. */
const TEMPLATE_BASENAMES: readonly string[] = [".env.example", ".env.sample", ".env.template", ".env.dist"];

/** Rule 64: the secret-shape rules a template file's body is read by, as if it left the project. Value shapes only: a template that
 * names `OPENAI_API_KEY=` with a placeholder is ordinary, a real key, token, private-key block or card number in it is not. */
const SECRET_SHAPES: readonly SensitiveTextRow[] = [
  { id: "key-literal", re: /\bsk-(?:proj|ant|or)?[-_]?[A-Za-z0-9_-]{16,}/ },
  { id: "private-key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { id: "token-literal", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|(?:sk|rk|pk)_live_[A-Za-z0-9]{16,})/ },
  { id: "bearer-literal", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
];

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** The first secret shape in a body, by id (a card number is 13..19 digits, spaced or dashed, that passes the Luhn check). */
function secretShapeIn(text: string): string | null {
  for (const row of SECRET_SHAPES) if (row.re.test(text)) return row.id;
  for (const match of text.matchAll(/(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g)) {
    const digits = match[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return "card-number";
  }
  return null;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/** The first sensitive PATH row a path matches, by id, with the template
 * carve-out applied when the path is inside the project. `onTheWay`: the
 * path is a folder passed through (or met by a walk), read by each row's
 * `ancestor` shape where it has one. `template`, when given, is the caller's
 * carve-out decision for this spelling (the key guard reads it from the
 * path's Win32 canonical name, so `.env.example.` on Windows is the template). */
function sensitivePathRow(path: string, inProject: boolean, onTheWay = false, template?: boolean): string | null {
  template ??= inProject && TEMPLATE_BASENAMES.includes(basename(path).toLowerCase());
  for (const row of SENSITIVE_PATHS) {
    if (template && row.id === "env") continue;
    if ((onTheWay && row.ancestor ? row.ancestor : row.re).test(path)) return row.id;
  }
  return null;
}

/** Rule 63/69c: the Claude `permissions.ask` projection, generated from the
 * path rows: every Read rule, then every Bash rule. The second line behind
 * the bare ask rules; the verdict applies the template carve-out itself. */
function claudeSensitiveAskRules(): string[] {
  const read = SENSITIVE_PATHS.flatMap((row) => row.read.map((rule) => `Read(${rule})`));
  const bash = SENSITIVE_PATHS.flatMap((row) => row.bash.map((rule) => `Bash(${rule})`));
  return [...new Set([...read, ...bash])];
}
// @inline end shared/sensitive-paths.ts

// @inline begin shared/in-project.ts
interface PlaceOptions {
  /** The platform whose path rules apply; the running one by default. */
  platform?: NodeJS.Platform;
  /** The owner's home, for a path given as `~/…`. Without it such a path
   * cannot be placed. */
  home?: string;
  /** The folder a relative path is placed from; the root by default. */
  base?: string;
}

interface RealOptions extends PlaceOptions {
  /** Every part, the last one included, must exist (Rule 75d: `realpath X`
   * and `readlink -f X`). Without it a missing tail is kept as written. */
  mustExist?: boolean;
}

/** A path resolved part by part in order. Only `realPathInOrder` and
 * `realDir` make one. */
type RealPath = string & { readonly __real: "RealPath" };

type RealResult = { real: RealPath; intermediates: readonly RealPath[] } | { cannot: string };

type Placement =
  | { kind: "inside" | "outside"; real: RealPath; intermediates: readonly RealPath[] }
  | { kind: "cannot-place"; why: string };

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** Drive-relative (`C:foo`) and current-drive-root (`\foo`) forms, which name
 * a place only relative to state the call does not carry. */
function windowsUnplaceable(path: string): boolean {
  return /^[A-Za-z]:(?![\\/])/.test(path) || /^[\\/](?![\\/])/.test(path);
}

function realOf(path: string): string {
  return realpathSync.native(path);
}

/** A Windows path without its `\\?\` or `\\.\` device prefix (`\\?\C:\x`,
 * `\\.\C:\x` and `//?/C:/x` are `C:\x`; `\\?\UNC\host\share` is
 * `\\host\share`). The walk needs this: Node reads the root `\\?\C:\` as
 * the drive-relative `C:` and cannot realpath it, so a prefixed path could
 * not be placed at all (SG-WIN-PATHTRICKS.md). Nothing else is changed. */
function win32Unprefixed(path: string): string {
  return path.replace(/^[\\/]{2}[?.][\\/]UNC(?=[\\/])/i, "\\").replace(/^[\\/]{2}[?.][\\/](?=[A-Za-z]:)/, "");
}

function within(root: string, target: string, platform: NodeJS.Platform): boolean {
  const sep = platform === "win32" ? "\\" : "/";
  const a = platform === "win32" ? root.toLowerCase() : root;
  const b = platform === "win32" ? target.toLowerCase() : target;
  if (a === b) return true;
  return b.startsWith(a.endsWith(sep) ? a : a + sep);
}

type Walked = { cur: string; intermediates: string[]; missing: boolean } | { cannot: string };

/** The segment loop: from the real `start`, apply each part in order. A link
 * is resolved before the next part, so `link/..` climbs from the link's
 * target. The first part that does not exist ends resolution: the rest is
 * appended as written (a file about to be written), a `..` in it cannot be
 * placed, and in must-exist mode nothing missing is kept. Any other error
 * (`ELOOP`, `EACCES`, `ENAMETOOLONG`) cannot be placed. */
function walk(start: string, rest: string, platform: NodeJS.Platform, mustExist: boolean): Walked {
  const p = pathFor(platform);
  let cur = start;
  const segments = rest.split(platform === "win32" ? /[\\/]+/ : /\/+/);
  const intermediates: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      cur = p.dirname(cur);
      intermediates.push(cur);
      continue;
    }
    const next = p.join(cur, seg);
    let link = false;
    try {
      link = lstatSync(next).isSymbolicLink();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") return { cannot: code ?? "a path that cannot be read" };
      if (mustExist) return { cannot: "missing" };
      const tail = segments.slice(i).filter((part) => part !== "" && part !== ".");
      if (tail.includes("..")) return { cannot: "a climb past a missing folder" };
      return { cur: p.join(cur, ...tail), intermediates, missing: true };
    }
    if (link) {
      try {
        cur = realOf(next);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return { cannot: mustExist && code === "ENOENT" ? "missing" : code ?? "a link that cannot be resolved" };
      }
    } else if (platform === "win32") {
      // the real spelling of a part that is there: an 8.3 short name (C:\Users\RUNNER~1) reads as its long name, as the root does
      try {
        cur = realOf(next);
      } catch (error) {
        return { cannot: (error as NodeJS.ErrnoException).code ?? "a path that cannot be read" };
      }
    } else {
      cur = next;
    }
    intermediates.push(cur);
  }
  return { cur, intermediates, missing: false };
}

/** An absolute path walked from its real drive or root. */
function walkAbsolute(given: string, platform: NodeJS.Platform, mustExist: boolean): Walked {
  const parsed = pathFor(platform).parse(given);
  let root: string;
  try {
    root = realOf(parsed.root);
  } catch {
    return { cannot: "the drive cannot be read" };
  }
  return walk(root, given.slice(parsed.root.length), platform, mustExist);
}

/**
 * Rules 63.2 and 75d: the real path of `path`, resolved part by part in
 * order, with every intermediate real spelling it passed through (the key
 * guard reads them all, so a climb through `~/.ssh/..` is still seen). A
 * relative path is placed from `base`, which is walked the same way first; a
 * base that does not exist yet keeps the path as written beneath it. Nothing
 * is ever collapsed lexically.
 */
function realPathInOrder(path: string, base: string, opts: RealOptions = {}): RealResult {
  const platform = opts.platform ?? process.platform;
  const p = pathFor(platform);
  const mustExist = opts.mustExist === true;
  if (typeof path !== "string" || !path) return { cannot: "no path" };
  if (path.includes("\u0000") || (typeof base === "string" && base.includes("\u0000"))) return { cannot: "a NUL byte" };
  if (platform === "win32" && windowsUnplaceable(path)) return { cannot: "a drive-relative path" };
  let given = path;
  if (given === "~" || given.startsWith("~/") || (platform === "win32" && given.startsWith("~\\"))) {
    if (!opts.home) return { cannot: "a home path with no home" };
    // joined as written: `~/link/../x` must climb from where the link points, so nothing is collapsed before the segments resolve
    given = given === "~" ? opts.home : `${opts.home}${p.sep}${given.slice(2)}`;
  } else if (given.startsWith("~")) {
    return { cannot: "another account's home" };
  }
  let walked: Walked;
  if (p.isAbsolute(given)) {
    walked = walkAbsolute(platform === "win32" ? win32Unprefixed(given) : given, platform, mustExist);
  } else {
    if (typeof base !== "string" || !base || !p.isAbsolute(base) || (platform === "win32" && windowsUnplaceable(base))) {
      return { cannot: "a relative path with no folder to place it from" };
    }
    const from = walkAbsolute(base, platform, mustExist);
    if ("cannot" in from) return { cannot: from.cannot === "missing" ? "missing" : "the folder it is placed from cannot be read" };
    if (from.missing) {
      const tail = given.split(platform === "win32" ? /[\\/]+/ : /\/+/).filter((part) => part !== "" && part !== ".");
      if (tail.includes("..")) return { cannot: "a climb past a missing folder" };
      walked = { cur: tail.length ? p.join(from.cur, ...tail) : from.cur, intermediates: [], missing: true };
    } else {
      walked = walk(from.cur, given, platform, mustExist);
    }
  }
  if ("cannot" in walked) return { cannot: walked.cannot };
  return { real: walked.cur as RealPath, intermediates: walked.intermediates as RealPath[] };
}

/** A folder's real path, every part resolved in order and present, or null
 * when it does not resolve or is not a folder. A relative path is taken from
 * the running process's folder. */
function realDir(path: string, opts: PlaceOptions = {}): RealPath | null {
  const platform = opts.platform ?? process.platform;
  let here = "";
  if (!pathFor(platform).isAbsolute(path)) {
    try {
      here = realOf(".");
    } catch {
      return null;
    }
  }
  const placed = realPathInOrder(path, here, { platform, mustExist: true });
  if ("cannot" in placed) return null;
  try {
    return statSync(placed.real).isDirectory() ? placed.real : null;
  } catch {
    return null;
  }
}

/** The one way to add names to a real folder: each name is one part (no
 * separator of either platform, not `.` or `..`, no NUL), else it cannot be
 * joined. The result names a place beneath `base`; it is not itself
 * resolved (the last name may be a link the reader follows). */
function joinReal(base: RealPath, ...names: string[]): { path: string } | { cannot: string } {
  for (const name of names) {
    if (typeof name !== "string" || !name || name === "." || name === ".." || /[\\/\u0000]/.test(name)) return { cannot: "a name that is not one part" };
  }
  const p = /^(?:[A-Za-z]:\\|\\\\)/.test(base) ? win32 : posix;
  return { path: p.join(base, ...names) };
}

/**
 * Rule 63 step 2: place `path` by its real path against the real `root`,
 * segment by segment (`realPathInOrder`), from `opts.base` when given, else
 * from the root. Whatever cannot be resolved cannot be placed.
 */
function placePath(path: string, root: string, opts: PlaceOptions = {}): Placement {
  const platform = opts.platform ?? process.platform;
  if (typeof path !== "string" || !path) return { kind: "cannot-place", why: "no path" };
  if (path.includes("\u0000") || root.includes("\u0000")) return { kind: "cannot-place", why: "a NUL byte" };
  if (platform === "win32" && windowsUnplaceable(path)) return { kind: "cannot-place", why: "a drive-relative path" };
  let realRoot: string;
  try {
    realRoot = realOf(root);
  } catch {
    return { kind: "cannot-place", why: "the project folder cannot be read" };
  }
  const placed = realPathInOrder(path, opts.base ?? realRoot, opts);
  if ("cannot" in placed) return { kind: "cannot-place", why: placed.cannot };
  return { kind: within(realRoot, placed.real, platform) ? "inside" : "outside", real: placed.real, intermediates: placed.intermediates };
}

/**
 * The Win32 half of Rule 34's canonical form, for the key guard: the
 * spelling Win32 reads a path as (lanes/release103/SG-WIN-PATHTRICKS.md).
 * `\\?\X:` and `\\.\X:` lose their prefix and `\\?\UNC\` reads as `\\`; an
 * admin share `\\host\X$\rest` reads as `X:\rest` whatever the host (a
 * loopback cannot be told from a far host without a lookup, so both read as
 * the local drive: a far path that looks like a hook file is held, never
 * passed). In each part after the drive a stream suffix (`hooks.json::$DATA`,
 * `hooks.json:evil`) is cut and trailing dots and spaces are stripped (Win32
 * strips the last part's; stripping every part can only hold more); `.` and
 * `..` keep theirs. Separators and case stay as given: `spellings` adds the
 * `/` form and the rows read case-insensitively. On POSIX the path is
 * returned as given: every one of these is a file name there.
 */
function win32Canonical(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return path;
  const unwrapped = win32Unprefixed(path).replace(/^[\\/]{2}[^\\/]+[\\/]([A-Za-z])\$(?=[\\/]|$)/, "$1:");
  const name = (part: string): string => {
    if (part === "." || part === "..") return part;
    const bare = part.replace(/:.*$/, "").replace(/[. ]+$/, "");
    return bare === "" ? part : bare;
  };
  // split with the separators kept, so `\` and `/` land back where they were
  return unwrapped.split(/([\\/])/).map((part, i) => {
    if (i % 2 === 1) return part;
    if (i === 0) {
      const drive = /^([A-Za-z]:)(.*)$/.exec(part);
      if (drive) return drive[1] + (drive[2] === "" ? "" : name(drive[2]!));
    }
    return name(part);
  }).join("");
}

/** The spellings the key guard reads for one path: as given, with
 * backslashes as `/` (the separator part of Rule 34's canonical form), and
 * on Windows the Win32 canonical form of each (`win32Canonical`). */
function spellings(text: string, platform: NodeJS.Platform): string[] {
  const out = [text];
  const add = (spelling: string) => { if (!out.includes(spelling)) out.push(spelling); };
  add(text.replace(/\\/g, "/"));
  const canonical = win32Canonical(text, platform);
  add(canonical);
  add(canonical.replace(/\\/g, "/"));
  return out;
}

/** Rule 63 step 3 over every spelling of every path: the first sensitive
 * row hit, by id. `onTheWay`: the paths are folders passed through. */
function keyGuard(paths: readonly string[], inProject: boolean, platform: NodeJS.Platform, onTheWay = false): string | null {
  for (const path of paths) {
    // Rule 64 reads the name Win32 reads: `.env.example.` is the template on Windows, by every spelling of the path
    const template = inProject && TEMPLATE_BASENAMES.includes(win32Canonical(path, platform).split(platform === "win32" ? /[\\/]/ : "/").pop()?.toLowerCase() ?? "");
    for (const spelling of spellings(path, platform)) {
      const row = sensitivePathRow(spelling, inProject, onTheWay, template);
      if (row) return row;
    }
  }
  return null;
}

type InProjectResult =
  | { ok: true; real: string }
  | { ok: false; reason: "sensitive"; rule: string }
  | { ok: false; reason: "outside"; real: string }
  | { ok: false; reason: "cannot-place"; why: string }
  | { ok: false; reason: "unread"; why: string };

/**
 * Rule 63 steps 2, 3 and 5 for one path (step 1, the contract, is the
 * caller's: a search tool's absent root is the cwd). Passing means the
 * operation runs with no card. `content`, for an edit or write, must be a
 * string no larger than the gate's message cap, else the call is unread.
 */
function inProjectCheck(path: string, root: string, content?: unknown, opts: PlaceOptions = {}): InProjectResult {
  const platform = opts.platform ?? process.platform;
  const placed = placePath(path, root, opts);
  const inside = placed.kind === "inside";
  const rule = keyGuard([path], inside, platform) ?? (placed.kind === "cannot-place" ? null : keyGuard(placed.intermediates, inside, platform, true) ?? keyGuard([placed.real], inside, platform));
  if (rule) return { ok: false, reason: "sensitive", rule };
  if (placed.kind === "cannot-place") return { ok: false, reason: "cannot-place", why: placed.why };
  if (placed.kind === "outside") return { ok: false, reason: "outside", real: placed.real };
  if (content !== undefined) {
    if (typeof content !== "string") return { ok: false, reason: "unread", why: "the content is not text" };
    if (Buffer.byteLength(content, "utf8") > GATE_MESSAGE_BYTES) return { ok: false, reason: "unread", why: "the content is too large to read whole" };
    // Rule 64: the body of a write to an in-project template file is read by the secret-shape rules as if it left the project, so a
    // real key pasted into `.env.example` is sensitive (the carve-out covers the name, never the body)
    const baseOf = (text: string) => (platform === "win32" ? win32Canonical(text, platform).split(/[\\/]/) : text.split("/")).pop()?.toLowerCase() ?? "";
    if (TEMPLATE_BASENAMES.includes(baseOf(placed.real)) || TEMPLATE_BASENAMES.includes(baseOf(path))) {
      const shape = secretShapeIn(content);
      if (shape) return { ok: false, reason: "sensitive", rule: shape };
    }
  }
  return { ok: true, real: placed.real };
}

interface WalkHit {
  /** relative to the search root, `/`-separated */
  path: string;
  /** a sensitive directory is one hit for its whole subtree */
  dir: boolean;
  rule: string;
}

type WalkResult =
  | { ok: true; hits: readonly WalkHit[]; unwalked: readonly string[] }
  | { ok: false; why: string };

interface WalkOptions extends PlaceOptions {
  maxEntries?: number;
  maxMs?: number;
  now?: () => number;
}

/**
 * Rule 73a: a breadth-first walk of the real tree under a search root,
 * bounded by WALK_ENTRIES and WALK_MS. Every entry is placed and key-guarded;
 * a sensitive directory is one hit and is not descended. `unwalked` is every
 * directory the bound stopped before it was finished, and every directory
 * the walk could not enter (a folder it cannot read, a link out of the
 * project): a walk that did not reach a place proves nothing about it. A
 * root that cannot be read at all is not ok.
 */
function walkRoot(root: string, project: string, opts: WalkOptions = {}): WalkResult {
  const platform = opts.platform ?? process.platform;
  const maxEntries = opts.maxEntries ?? WALK_ENTRIES;
  const maxMs = opts.maxMs ?? WALK_MS;
  const now = opts.now ?? Date.now;
  const started = now();
  const rootPlaced = placePath(root, project, opts);
  if (rootPlaced.kind === "cannot-place") return { ok: false, why: rootPlaced.why };
  const realProject = realDir(project, { platform });
  if (!realProject) return { ok: false, why: "the project folder cannot be read" };
  const hits: WalkHit[] = [];
  const unwalked: string[] = [];
  const queue: { real: RealPath; rel: string }[] = [{ real: rootPlaced.real, rel: "" }];
  const seen = new Set<string>([rootPlaced.real]);
  let entries = 0;
  let first = true;
  while (queue.length) {
    const dir = queue.shift()!;
    let names: string[];
    try {
      names = readdirSync(dir.real);
    } catch {
      if (first) return { ok: false, why: "the search root cannot be read" };
      unwalked.push(dir.rel || ".");
      continue;
    }
    first = false;
    names.sort();
    for (let i = 0; i < names.length; i++) {
      if (entries >= maxEntries || now() - started > maxMs) {
        unwalked.push(dir.rel || ".", ...queue.map((left) => left.rel));
        return { ok: true, hits, unwalked };
      }
      entries++;
      const name = names[i]!;
      const rel = dir.rel ? `${dir.rel}/${name}` : name;
      const joined = joinReal(dir.real, name);
      if ("cannot" in joined) continue; // a directory entry is always one name
      const abs = joined.path;
      let isLink = false;
      let isDir = false;
      try {
        const st = lstatSync(abs);
        isLink = st.isSymbolicLink();
        isDir = st.isDirectory();
      } catch {
        continue;
      }
      let real = abs;
      if (isLink) {
        try {
          real = realOf(abs);
          isDir = statSync(real).isDirectory();
        } catch {
          continue; // a dangling link reads nothing
        }
      }
      const inside = within(realProject, real, platform);
      // A repository's `.git` holds its config and hooks rows and the rest of
      // its history: the walk treats it as one sensitive directory (Rule 73a).
      const rule = isDir && name === ".git" ? "project-git" : keyGuard([rel, abs, real], inside, platform, isDir);
      if (rule) {
        hits.push({ path: rel, dir: isDir, rule });
        continue;
      }
      if (!isDir) continue;
      if (!inside) {
        unwalked.push(rel);
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      const next = realDir(real, { platform });
      if (!next) {
        unwalked.push(rel);
        continue;
      }
      queue.push({ real: next, rel });
    }
  }
  return { ok: true, hits, unwalked };
}

/** Rule 73a: one walk per (turn, real root) reused for WALK_CACHE_MS, and
 * dropped on any approved write under the root. */
class WalkCache {
  private readonly entries = new Map<string, { at: number; result: WalkResult; root: string }>();
  private readonly now: () => number;
  private readonly ttl: number;
  constructor(now: () => number = Date.now, ttl = WALK_CACHE_MS) {
    this.now = now;
    this.ttl = ttl;
  }

  get(turn: string, realRoot: string): WalkResult | undefined {
    const key = `${turn}\u0000${realRoot}`;
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.ttl) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.result;
  }

  set(turn: string, realRoot: string, result: WalkResult): void {
    this.entries.set(`${turn}\u0000${realRoot}`, { at: this.now(), result, root: realRoot });
  }

  /** An approved write landed at `realPath`: every walk of a root holding it
   * is stale. */
  invalidateWrite(realPath: string, platform: NodeJS.Platform = process.platform): void {
    for (const [key, entry] of this.entries) if (within(entry.root, realPath, platform)) this.entries.delete(key);
  }
}
// @inline end shared/in-project.ts


// ---------------------------------------------------------------------------
// The gate.

/** The title prefix of every gate ask. The driver matches prefix + secret. */
export const PI_GATE_TITLE_PREFIX = "murage-gate:";
/** Longest message the gate sends (Rule 15: the RPC frame limit minus
 *  headroom). A larger call is sent as `{tool, truncated: true}` and held. */
export const PI_GATE_MESSAGE_MAX = GATE_MESSAGE_BYTES;
export const PI_GATE_UNIDENTIFIED = "Murage could not identify this tool";
export const PI_GATE_UNCHECKED = "Murage could not check this call";
export const PI_GATE_NOT_ALLOWED = "The owner did not allow this in Murage.";
export const PI_GATE_NO_UI = "Murage could not ask the owner about this, so it did not run.";
export const PI_FILTER_WITHHELD = "[result withheld: Murage could not check it]";
export const PI_FILTER_STALE = "a search result reached the engine without Murage's filter";

/** One row of the process-global table pi-mcp-extension.ts writes (Rule 14b),
 *  keyed by the exact allocated piName. The gate reads `mount` and `mcpTool`
 *  from here and never parses the piName (T37). */
export interface McpToolEntry {
  piName: string;
  /** the server's engine name, as the mcp.json key */
  mount: string;
  mcpTool: string;
  /** the Rule 54 mountId the driver stamped; absent means the tool asks */
  mountId?: string;
}
export const MCP_TABLE_KEY = "__murageMcpTools";

/** Rule 55's Pi rows: the keys a tool's input may carry. `edits` is the
 *  array form the installed engine (1.3.0) takes. */
const OWN_ROWS: Readonly<Record<string, { need: readonly string[]; may: readonly string[] }>> = {
  bash: { need: ["command"], may: ["timeout"] },
  powershell: { need: ["command"], may: ["timeout"] },
  read: { need: ["path"], may: ["offset", "limit"] },
  edit: { need: ["path"], may: ["oldText", "newText", "edits"] },
  write: { need: ["path", "content"], may: [] },
  grep: { need: ["pattern"], may: ["path", "glob", "ignoreCase", "literal", "context", "limit"] },
  find: { need: ["pattern"], may: ["path", "limit"] },
  ls: { need: [], may: ["path", "limit"] },
};
const SEARCH_TOOLS = new Set(["grep", "find", "ls"]);
const FILE_TOOLS = new Set(["edit", "write"]);

/** Rule 51's unasked pairs, by mountId (T59 compares this with OWN_UNASKED). */
export const GATE_UNASKED: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["own:memory", ["memory_search", "memory_get", "memory_save", "memory_propose_correction", "thread_search", "thread_list", "thread_read"]],
  ["own:agents", [
    "list_bots", "get_bot", "check_delegation", "wait_delegation", "get_permission_status", "list_routines", "skills_list",
    "list_reference_packs", "list_prompt_blocks", "get_prompt_block", "list_image_models", "tool_result_read", "murage_help",
    "project_read_messages", "venue_read_messages", "email_list", "email_read",
    "ask_bot", "delegate_bot", "project_assign", "project_accept", "project_card_manage", "project_review_assign",
    "project_criteria", "project_blocked", "project_brief_update", "project_card_update", "project_review_result",
    "project_suggest", "project_summary_update", "project_bring_in",
    "allow_for_task",
    "project_propose", "propose_outcome", "propose_routine", "propose_routine_action", "request_bot_access", "request_credential", "ask_user", "show_widget", "update_widget",
    "request_browser_connection", "project_done", "add_mcp_server",
    "create_bot", "update_bot", "archive_bot", "restore_bot", "move_bot", "set_team_lead",
    "send_voice_note", "generate_image", "email_send", "email_reply", "email_trust_offer", "save_prompt_block", "save_reference_pack",
  ]],
  ["own:dweb", ["dweb_status", "dweb_repo_status", "dweb_opencode_models"]],
  // the gate imports nothing of Murage's, so the names are spelled here (a test pins them to PHONE_TOOL_NAMES through OWN_UNASKED)
  ["own:phoneJobs", [
    "phone_calendar_read", "phone_calendar_find_free_time", "phone_calendar_add", "phone_calendar_change",
    "phone_reminders_read", "phone_reminders_add", "phone_reminders_complete",
    "phone_contacts_search", "phone_contacts_get", "phone_location_get",
    "phone_alarm_set", "phone_timer_set", "phone_text_compose", "phone_call_dial",
  ]],
];
function unaskedPair(mountId: string | undefined, tool: string): boolean {
  if (!mountId) return false;
  return GATE_UNASKED.some(([mount, tools]) => mount === mountId && tools.includes(tool));
}

interface GateEvent {
  toolName: string;
  toolCallId?: string;
  input?: Record<string, unknown>;
}
interface GateContext {
  cwd: string;
  hasUI: boolean;
  ui: { editor(title: string, prefill?: string): Promise<string | undefined> };
}
export interface GateBlock { block: true; reason: string }
export interface ResultEvent {
  toolName: string;
  toolCallId?: string;
  input?: Record<string, unknown>;
  content?: unknown;
}
export interface ResultReplacement {
  content: { type: "text"; text: string }[];
  structuredContent: string;
  isError?: true;
  details?: Record<string, never>;
}
interface GateApi {
  on(event: "tool_call", handler: (event: GateEvent, ctx: GateContext) => Promise<GateBlock | undefined>): unknown;
  on(event: "tool_result", handler: (event: ResultEvent, ctx: { cwd: string }) => ResultReplacement | undefined): unknown;
  on(event: "turn_end" | "agent_end", handler: () => void): unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const block = (reason: string): GateBlock => ({ block: true, reason });

function mcpTable(): Map<string, McpToolEntry> | undefined {
  const table = (globalThis as Record<string, unknown>)[MCP_TABLE_KEY];
  return table instanceof Map ? (table as Map<string, McpToolEntry>) : undefined;
}

/** The message a gate ask carries: the whole call (Rule 15). One too large to
 *  send, or one that cannot be written as JSON, carries the tool and
 *  `truncated: true` instead of its input. */
export function piGateMessage(tool: string, input: Record<string, unknown> | undefined, entry?: McpToolEntry, note?: string, sensitive?: string): string {
  const head = entry ? { tool, mount: entry.mount, mcpTool: entry.mcpTool } : { tool };
  // `sensitive`: this gate held the call as a key file, links followed; the
  // server keeps that verdict, so no mode answers it as an ordinary read
  const extra = { ...(note ? { note } : {}), ...(sensitive ? { sensitive } : {}) };
  try {
    const full = JSON.stringify({ ...head, ...(input === undefined ? {} : { input }), ...extra });
    if (typeof full === "string" && Buffer.byteLength(full, "utf8") <= PI_GATE_MESSAGE_MAX) return full;
  } catch {
    // too deep or circular: sent as cut, below
  }
  return JSON.stringify({ ...head, truncated: true, ...extra });
}

// The whole-module inlines carry names the gate does not call.
void [SENSITIVE_RULES, claudeSensitiveAskRules];

// ---- the search-result filter (Rule 60) -----------------------------------

export interface FilterHooks {
  /** one result line to its verdict; may throw (T105 injects faults) */
  line(tool: string, text: string, root: string): "keep" | "withhold" | "unparsable";
  /** the search root's placement; may throw */
  place(root: string, cwd: string): Placement;
  /** the directory walk of the tool_call fallback; may throw */
  walk(root: string, project: string): WalkResult;
}

/** Pi's own grep notices (a limit reached, lines cut), the only bracketed lines kept without a path. */
const PI_GREP_NOTICE = /^\[(?:\d+ (?:matches|results|files|entries) limit reached|Some lines truncated|Output truncated)\b[^\]]*\]$/;
const KNOWN_EMPTY = new Set(["No matches found", "No files found matching pattern", "(empty directory)"]);

function entryOk(entry: string, root: string): boolean {
  return inProjectCheck(entry, root, undefined, { home: homedir() }).ok;
}

/** The path prefixes a grep line (`path:12: text`, `path-12- text`) may start
 *  with: the first, and any later one that holds no space (a path may hold
 *  `-3-` or `:3:`, text with spaces is not a path). */
function grepPrefixes(text: string): string[] {
  const found: string[] = [];
  const re = /[:-]\d+[:-]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null && found.length < 8) {
    const prefix = text.slice(0, match.index);
    if (prefix && (found.length === 0 || !/\s/.test(prefix))) found.push(prefix);
  }
  return found;
}

function defaultLine(tool: string, text: string, root: string): "keep" | "withhold" | "unparsable" {
  const line = text.replace(/\r$/, "");
  if (line.trim() === "" || KNOWN_EMPTY.has(line)) return "keep";
  if (tool === "grep") {
    if (line === "--") return "keep";
    // Rule 60: a bracketed line is parsed, never kept on its shape. One that holds a grep prefix is judged on it (inside the brackets
    // and as written); one that holds none is kept only as one of Pi's own notices, and dropped otherwise.
    const bracket = /^\[(.*)\]$/.exec(line);
    if (bracket) {
      const prefixes = [...grepPrefixes(line), ...grepPrefixes(bracket[1]!)];
      if (prefixes.length) return prefixes.every((prefix) => entryOk(prefix, root)) ? "keep" : "withhold";
      return PI_GREP_NOTICE.test(line) ? "keep" : "withhold";
    }
    const prefixes = grepPrefixes(line);
    if (!prefixes.length) return "unparsable";
    return prefixes.every((prefix) => entryOk(prefix, root)) ? "keep" : "withhold";
  }
  return entryOk(line.endsWith("/") ? line.slice(0, -1) : line, root) ? "keep" : "withhold";
}

export const DEFAULT_HOOKS: FilterHooks = {
  line: defaultLine,
  place: (root, cwd) => placePath(root, cwd, { home: homedir() }),
  walk: (root, project) => walkRoot(root, project, { home: homedir() }),
};

/**
 * Rule 60: withhold every sensitive entry of a search result. THE FILTER
 * CATCHES ITS OWN FAILURES: Pi's runner keeps the unfiltered result when a
 * `tool_result` handler throws, so this never throws. The whole-result
 * replacement is built from constants before the body runs; any failure
 * returns it (content and structuredContent both set, isError, details
 * cleared).
 */
export function filterToolResult(event: ResultEvent, cwd: string, hooks: FilterHooks = DEFAULT_HOOKS): ResultReplacement | undefined {
  const replacement: ResultReplacement = { content: [{ type: "text", text: PI_FILTER_WITHHELD }], structuredContent: PI_FILTER_WITHHELD, isError: true, details: {} };
  try {
    if (!SEARCH_TOOLS.has(event.toolName)) return undefined;
    const input = isObject(event.input) ? event.input : {};
    const given = input.path === undefined ? "." : input.path;
    if (typeof given !== "string" || !given || !Array.isArray(event.content)) return replacement;
    const placed = hooks.place(given, cwd);
    if (placed.kind === "cannot-place") return replacement;
    let root: string = placed.real;
    try {
      if (!statSync(root).isDirectory()) root = (process.platform === "win32" ? win32 : posix).dirname(root);
    } catch {
      return replacement;
    }
    const kept: string[] = [];
    let withheld = 0;
    let lines = 0;
    for (const item of event.content as unknown[]) {
      if (!isObject(item) || item.type !== "text" || typeof item.text !== "string") return replacement;
      for (const text of item.text.split("\n")) {
        if (text.trim() !== "") lines += 1;
        const verdict = hooks.line(event.toolName, text, root);
        if (verdict === "unparsable") {
          const all = `[${lines || 1} entries withheld: sensitive files]`;
          return { content: [{ type: "text", text: all }], structuredContent: all };
        }
        if (verdict === "withhold") withheld += 1;
        else kept.push(text);
      }
    }
    if (!withheld) return undefined;
    const text = `${kept.join("\n").replace(/\n+$/, "")}\n[${withheld} entries withheld: sensitive files]`.replace(/^\n/, "");
    return { content: [{ type: "text", text }], structuredContent: text };
  } catch {
    return replacement;
  }
}

/** The load-time self-check: the filter, run on a fixture result, yields the
 *  withheld line. */
export function filterSelfCheck(hooks: FilterHooks = DEFAULT_HOOKS): boolean {
  try {
    const out = filterToolResult({ toolName: "find", input: {}, content: [{ type: "text", text: ".env" }] }, tmpdir(), hooks);
    return !!out && !out.isError && out.content[0]?.text.includes("1 entries withheld: sensitive files") === true;
  } catch {
    return false;
  }
}

// ---- the gate --------------------------------------------------------------

export interface GateOptions {
  hooks?: FilterHooks;
  now?: () => number;
}
const STALE_MS = 120_000;

function allowedKeys(tool: string, original: Record<string, unknown> | undefined, entry?: McpToolEntry): { need: readonly string[]; may: readonly string[] } {
  if (entry) return { need: [], may: Object.keys(original ?? {}) };
  const row = OWN_ROWS[tool]!;
  return row;
}

/** Where the first load keeps this process's secret. Pi 1.3.0 runs every
 *  extension's factory again on `new_session` (which the driver sends before
 *  each prompt), in the same process, after the first load removed the
 *  secret from the environment; the later load reads it from here. A
 *  process-global slot, like the MCP table: the commands pi runs inherit the
 *  environment, never this. */
const GATE_SLOT = Symbol.for("murage.piGate");

export default function piPermissionGate(pi: GateApi, options: GateOptions = {}): void {
  const hooks = options.hooks ?? DEFAULT_HOOKS;
  const now = options.now ?? Date.now;
  const slot = globalThis as Record<symbol, unknown>;
  const kept = slot[GATE_SLOT] as { secret?: unknown; only?: unknown } | undefined;
  const fromEnv = process.env.MURAGE_PI_GATE ?? "";
  const secret = fromEnv || (typeof kept?.secret === "string" ? kept.secret : "");
  const only = (fromEnv ? process.env.MURAGE_PI_GATE_ONLY : typeof kept?.only === "string" ? kept.only : undefined) || undefined;
  delete process.env.MURAGE_PI_GATE;
  delete process.env.MURAGE_PI_GATE_ONLY;
  // Murage loads the gate only on a turn that asks, so a gate with no secret
  // anywhere cannot ask the owner: it blocks every call instead of letting
  // pi run its tools unasked.
  if (!secret) {
    pi.on("tool_call", async () => block(PI_GATE_UNCHECKED));
    return;
  }
  slot[GATE_SLOT] = { secret, only };
  const pending = new Map<string, number>();
  let filterTrusted = false;
  let staleNote: string | undefined;
  let walks = new WalkCache();

  const sweep = (atEnd: boolean): void => {
    for (const [id, at] of pending) {
      if (atEnd || now() - at > STALE_MS) {
        pending.delete(id);
        filterTrusted = false;
        staleNote = PI_FILTER_STALE;
      }
    }
  };

  // The filter, registered at load. `filterTrusted` is set only when the
  // registration returned without throwing and the self-check passed.
  try {
    pi.on("tool_result", (event, ctx) => {
      if (event.toolCallId) pending.delete(event.toolCallId);
      return filterToolResult(event, ctx.cwd, hooks);
    });
    filterTrusted = filterSelfCheck(hooks);
  } catch {
    filterTrusted = false;
  }
  for (const name of ["turn_end", "agent_end"] as const) {
    try {
      pi.on(name, () => sweep(true));
    } catch {
      // an engine without the event: the tool_call sweep still runs
    }
  }

  const ask = async (event: GateEvent, ctx: GateContext, entry?: McpToolEntry, held?: string): Promise<GateBlock | undefined> => {
    if (!ctx.hasUI) return block(PI_GATE_NO_UI);
    const tool = entry ? entry.piName : event.toolName;
    const note = staleNote;
    staleNote = undefined;
    const answer = await ctx.ui.editor(`${PI_GATE_TITLE_PREFIX}${secret}`, piGateMessage(tool, isObject(event.input) ? event.input : undefined, entry, note, held));
    if (typeof answer !== "string" || !answer.trim()) return block(PI_GATE_NOT_ALLOWED);
    const parsed: unknown = JSON.parse(answer);
    if (!isObject(parsed)) return block(PI_GATE_NOT_ALLOWED);
    if (parsed.deny === true) return block(typeof parsed.reason === "string" && parsed.reason ? parsed.reason.slice(0, 2_000) : PI_GATE_NOT_ALLOWED);
    if (parsed.allow !== true || !isObject(parsed.input) || !isObject(event.input)) return block(PI_GATE_NOT_ALLOWED);
    const rows = allowedKeys(event.toolName, event.input, entry);
    const keys = Object.keys(parsed.input);
    const permitted = new Set([...rows.need, ...rows.may]);
    if (keys.some((key) => !permitted.has(key)) || rows.need.some((key) => !keys.includes(key))) return block(PI_GATE_NOT_ALLOWED);
    for (const key of keys) event.input[key] = parsed.input[key];
    walks = new WalkCache();
    return undefined;
  };

  /** Whether an own tool runs with no ask, a block, or an ask; an ask over a
   * key file carries the rule that held it. */
  const quiet = (event: GateEvent, cwd: string): "run" | "ask" | GateBlock | { held: string } => {
    const asked = (check: InProjectResult): "ask" | { held: string } => (!check.ok && check.reason === "sensitive" ? { held: check.rule } : "ask");
    const name = event.toolName;
    const input = event.input;
    if (only || !isObject(input)) return "ask";
    const home = homedir();
    if (name === "read") {
      if (typeof input.path !== "string") return "ask";
      const check = inProjectCheck(input.path, cwd, undefined, { home });
      if (!check.ok) return asked(check);
      if (event.toolCallId) pending.set(event.toolCallId, now());
      return "run";
    }
    if (FILE_TOOLS.has(name)) {
      if (typeof input.path !== "string") return "ask";
      // Rules 55, 63.1: every required field, as the contract table reads it (server/drivers/contracts.ts PI); a missing one asks
      if (name === "write" && typeof input.content !== "string") return "ask";
      if (name === "edit") {
        const pair = (e: unknown) => isObject(e) && typeof e.oldText === "string" && typeof e.newText === "string";
        if (input.edits !== undefined ? !Array.isArray(input.edits) || input.edits.length === 0 || !input.edits.every(pair) : !pair(input)) return "ask";
      }
      // Rule 15: the content is read whole; one that cannot be is asked.
      const content = name === "write" ? input.content : JSON.stringify([input.oldText ?? null, input.newText ?? null, input.edits ?? null]);
      if (name === "write" && typeof content !== "string") return "ask";
      const check = inProjectCheck(input.path, cwd, content, { home });
      if (!check.ok) return asked(check);
      // Rule 64: a template file's body is read by the verdict, so it asks.
      const base = input.path.split(/[\\/]/).pop() ?? "";
      if (TEMPLATE_BASENAMES.includes(base.toLowerCase())) return "ask";
      return "run";
    }
    if (SEARCH_TOOLS.has(name)) {
      if (name !== "ls" && typeof input.pattern !== "string") return "ask";
      const given = input.path === undefined ? "." : input.path;
      if (typeof given !== "string" || !given) return "ask";
      const check = inProjectCheck(given, cwd, undefined, { home });
      if (!check.ok) return asked(check);
      if (filterTrusted) {
        if (event.toolCallId) pending.set(event.toolCallId, now());
        return "run";
      }
      // The filter is not trusted: walk the root and run only on a clean,
      // finished walk. Nothing is asked: a card cannot retract a result.
      let directory = true;
      try { directory = statSync(check.real).isDirectory(); } catch { return "ask"; }
      if (!directory) return "run";
      let walked = walks.get("turn", check.real);
      if (!walked) {
        walked = hooks.walk(check.real, cwd);
        walks.set("turn", check.real, walked);
      }
      if (!walked.ok) return block("Murage could not read this folder to check it for sensitive files; search a subdirectory.");
      if (walked.hits.length) return block(`This would read ${walked.hits[0]!.path}; exclude it or name a subdirectory.`);
      if (walked.unwalked.length) return block(`Murage could not finish checking this folder (${walked.unwalked.slice(0, 3).join(", ")}); exclude node_modules or search a subdirectory.`);
      return "run";
    }
    return "ask";
  };

  const decide = async (event: GateEvent, ctx: GateContext): Promise<GateBlock | undefined> => {
    sweep(false);
    const name = event.toolName;
    const own = typeof name === "string" && Object.hasOwn(OWN_ROWS, name);
    const entry = typeof name === "string" ? mcpTable()?.get(name) : undefined;
    // Rule 14: exactly one of the two sets; a name in both or neither is blocked.
    if (own === (entry !== undefined)) return block(PI_GATE_UNIDENTIFIED);
    if (entry) {
      if (only) return entry.piName === only ? undefined : ask(event, ctx, entry);
      return unaskedPair(entry.mountId, entry.mcpTool) ? undefined : ask(event, ctx, entry);
    }
    const verdict = quiet(event, ctx.cwd);
    if (verdict === "run") return undefined;
    if (verdict === "ask") return ask(event, ctx);
    if ("held" in verdict) return ask(event, ctx, undefined, verdict.held);
    return verdict;
  };

  pi.on("tool_call", async (event, ctx) => {
    try {
      return await decide(event, ctx);
    } catch {
      return block(PI_GATE_UNCHECKED);
    }
  });
}
