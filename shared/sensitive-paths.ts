// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one sensitive list (lanes/release103/APP-GRANT-DESIGN-FINAL.AGREED-r10.md
// Rule 35), moved here from server/auto-approve.ts so the Pi gate, the Claude
// rule projection (Rules 63, 69c) and the verdict read one list.
//
// Two kinds of row:
//   - SENSITIVE_PATHS: places whose CONTENTS are a key, a credential or a file
//     that changes what runs. Each row carries its Claude `Read` and `Bash`
//     ask-rule spellings, so the projection is generated from this list and
//     T90 can pin that no row lacks one.
//   - SENSITIVE_TEXT: shapes that are not a place (a keychain command, a
//     provider key name, a bearer header, a key literal, an environment dump
//     piped to grep, the cmd AutoRun registry value).
// This module imports nothing, so the Pi gate can carry it inline.

export interface SensitivePathRow {
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

export const SENSITIVE_PATHS: readonly SensitivePathRow[] = [
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
    re: /(?<![\w.-])(?:(?:antigravity-(?:relay|ask|scope)|codex-scope|fuigo-local-models)[. ]*(?:[\\/:]|$|["'\s;|&)>`])|murage-agy-relay|murage-hook\.(?:mjs|cmd|env)\b|ask-hook-[\w.-]*\.cjs\b)/i,
    read: ["**/native/antigravity-relay/**", "**/native/antigravity-ask/**", "**/native/antigravity-scope/**", "**/native/codex-scope/**", "**/native/fuigo-local-models/**", "**/murage-agy-relay*", "**/murage-hook.mjs", "**/murage-hook.cmd", "**/murage-hook.env", "**/ask-hook-*.cjs"],
    bash: ["*native/antigravity-relay*", "*native/antigravity-ask*", "*native/antigravity-scope*", "*native/codex-scope*", "*native/fuigo-local-models*", "*murage-agy-relay*", "*murage-hook.mjs*", "*murage-hook.cmd*", "*murage-hook.env*", "*ask-hook-*.cjs*"],
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
  // FUIGO-SCOPE-1010 G1: the owner's Fuigo and Grok logins are keys, and so is every copy or link of them a bot turn
  // can reach: the scope's auth.json (Grok links the owner's), a routed home's, the lock beside each, and the file
  // FUIGO_AUTH_PATH (or a home variable) names. A read is a card at every level, like `.codex/auth.json`.
  {
    id: "engine-logins",
    re: /\.(?:fuigo|grok)[\\/]auth\.json|native[\\/](?:fuigo-scope|grok-scope|provider-turns|grok-provider-context)[\\/][^\s"']*auth\.json|FUIGO_AUTH_PATH|(?:FUIGO|GROK)_HOME\}?[\\/]auth\.json/i,
    read: ["~/.fuigo/auth.json*", "~/.grok/auth.json*", "**/native/fuigo-scope/**/auth.json*", "**/native/grok-scope/**/auth.json*", "**/native/provider-turns/**/auth.json*", "**/native/grok-provider-context/**/auth.json*"],
    bash: ["*.fuigo/auth.json*", "*.grok/auth.json*", "*native/fuigo-scope*auth.json*", "*native/grok-scope*auth.json*", "*native/provider-turns*auth.json*", "*native/grok-provider-context*auth.json*", "*FUIGO_AUTH_PATH*", "*FUIGO_HOME*auth.json*", "*GROK_HOME*auth.json*"],
  },
  // FUIGO-SCOPE-1010 A2: the files of a bot's Fuigo or Grok home that decide what the engine allows or runs at its next
  // start (the generated config, the organisation copies, the trust store, the scope marker, session grants, hooks). A
  // write is a card at every level; the bot's own sessions and saved tool results in the same home are not on this row.
  {
    id: "engine-scope-config",
    re: /native[\\/](?:fuigo|grok)-scope[\\/][^\s"']*?(?:(?:config|requirements|sandbox|trusted_folders)\.toml|managed_config[^\\/\s"']*|\.murage-scope\.json|permission[^\\/\s"']*\.toml|[\\/]hooks(?:[\\/]|$|["'\s]))/i,
    read: ["**/native/fuigo-scope/**/config.toml", "**/native/fuigo-scope/**/managed_config*", "**/native/fuigo-scope/**/requirements.toml", "**/native/fuigo-scope/**/sandbox.toml", "**/native/fuigo-scope/**/trusted_folders.toml", "**/native/fuigo-scope/**/.murage-scope.json", "**/native/fuigo-scope/**/permission*.toml", "**/native/fuigo-scope/**/hooks/**", "**/native/grok-scope/**/config.toml", "**/native/grok-scope/**/managed_config*", "**/native/grok-scope/**/requirements.toml", "**/native/grok-scope/**/sandbox.toml", "**/native/grok-scope/**/trusted_folders.toml", "**/native/grok-scope/**/.murage-scope.json", "**/native/grok-scope/**/permission*.toml", "**/native/grok-scope/**/hooks/**"],
    bash: ["*native/fuigo-scope*config.toml*", "*native/fuigo-scope*managed_config*", "*native/fuigo-scope*requirements.toml*", "*native/fuigo-scope*sandbox.toml*", "*native/fuigo-scope*trusted_folders.toml*", "*native/fuigo-scope*.murage-scope.json*", "*native/fuigo-scope*permission*", "*native/fuigo-scope*hooks*", "*native/grok-scope*config.toml*", "*native/grok-scope*managed_config*", "*native/grok-scope*requirements.toml*", "*native/grok-scope*sandbox.toml*", "*native/grok-scope*trusted_folders.toml*", "*native/grok-scope*.murage-scope.json*", "*native/grok-scope*permission*", "*native/grok-scope*hooks*"],
  },
];

export interface SensitiveTextRow { id: string; re: RegExp }

export const SENSITIVE_TEXT: readonly SensitiveTextRow[] = [
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
export const SENSITIVE_RULES: readonly RegExp[] = [
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
export const TEMPLATE_BASENAMES: readonly string[] = [".env.example", ".env.sample", ".env.template", ".env.dist"];

/** Rule 64: the secret-shape rules a template file's body is read by, as if it left the project. Value shapes only: a template that
 * names `OPENAI_API_KEY=` with a placeholder is ordinary, a real key, token, private-key block or card number in it is not. */
export const SECRET_SHAPES: readonly SensitiveTextRow[] = [
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
export function secretShapeIn(text: string): string | null {
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
export function sensitivePathRow(path: string, inProject: boolean, onTheWay = false, template?: boolean): string | null {
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
export function claudeSensitiveAskRules(): string[] {
  const read = SENSITIVE_PATHS.flatMap((row) => row.read.map((rule) => `Read(${rule})`));
  const bash = SENSITIVE_PATHS.flatMap((row) => row.bash.map((rule) => `Bash(${rule})`));
  return [...new Set([...read, ...bash])];
}
