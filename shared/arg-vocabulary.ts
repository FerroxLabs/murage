// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every word list the app-grant readers read, one copy each
// (lanes/release103/APP-GRANT-DESIGN-FINAL.AGREED-r10.md, Rules 55, 56, 68f,
// 70, 71b4, 73b, 74c). Each list is the whole list and is pinned by
// shared/arg-vocabulary.test.ts; a reader never keeps a private copy.

import { statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { joinReal, realDir, realPathInOrder } from "./in-project.ts";

// ---------------------------------------------------------------------------
// Rule 55: paths and bodies.

/** Every key a path is read under: the keys the delete reader reads, plus the
 * ACP aliases. Contracts, the delete reader, the own-workspace reader and the
 * in-project gate read this list and no other. */
export const PATH_KEYS: readonly string[] = [
  "path", "paths", "file_path", "filePath", "notebook_path", "notebookPath",
  "target", "file", "files", "directory", "dir", "new_path", "destination",
];

/** Every body field a contract row names. Read as bodies (Rule 64), never as
 * paths. `edits[].old_string` and `edits[].new_string` are the per-edit
 * fields of a multi-edit. */
export const BODY_FIELDS: readonly string[] = [
  "content", "old_string", "new_string", "edits[].old_string", "edits[].new_string", "new_source", "oldText", "newText",
];

// ---------------------------------------------------------------------------
// Rule 56b: the key vocabularies a connector argument leaf is classified by
// when no schema node decides it.

/** Addressing: a key whose value names who receives. The recipient keys the
 * stop line reads today, plus the keys Rule 56b adds. */
export const ADDRESSING_KEYS: readonly string[] = [
  // the stop line's recipient keys as they stand (server/stop-line.ts RECIPIENT_KEYS)
  "to", "recipient", "recipients", "recipient_email", "recipient_id", "to_email", "to_number", "email", "emails", "cc", "bcc",
  "extra_recipients", "to_emails", "cc_emails", "bcc_emails", "channel", "channel_id", "channel_name", "chat_id", "conversation_id",
  "user", "user_id", "users", "phone", "phone_number", "number", "target", "room", "room_id", "group", "group_id", "receiver",
  "receiver_id", "peer", "username",
  // added by Rule 56b
  "members", "handle", "email_address", "address", "destination", "assignee", "attendees", "participants", "invitees",
  "watchers", "mentions",
];

/** Routing: a flag that widens who receives. Read against ROUTING_VALUES. */
export const ROUTING_KEYS: readonly string[] = [
  "reply_broadcast", "broadcast", "notify", "notify_all", "notify_everyone", "mention_everyone", "everyone", "link_names",
  "send_to_all", "cc_all", "reply_all", "visibility", "public", "is_public", "private", "audience", "share", "shared",
  "publish", "published", "post_to_feed", "send_notification", "send_notification_email", "notify_followers",
];

/** One row per routing key, with its polarity and its value sets. */
export type RoutingRow =
  | { key: string; polarity: "widens-when-true" }
  | { key: string; polarity: "widens-when-false" }
  | { key: string; polarity: "enum"; widening: readonly string[]; narrowing: readonly string[] };

const WIDENING_WORDS = ["public", "everyone", "all", "anyone", "external", "org", "organization", "company", "workspace", "anyone_with_link"] as const;
const NARROWING_WORDS = ["private", "direct", "me", "self", "only_me", "members", "internal", "restricted", "channel", "thread", "recipients", "none", "default"] as const;

export const ROUTING_VALUES: readonly RoutingRow[] = [
  ...[
    "reply_broadcast", "broadcast", "notify", "notify_all", "notify_everyone", "mention_everyone", "everyone", "link_names",
    "send_to_all", "cc_all", "reply_all", "public", "is_public", "share", "shared", "publish", "published", "post_to_feed",
    "send_notification", "send_notification_email", "notify_followers",
  ].map((key): RoutingRow => ({ key, polarity: "widens-when-true" })),
  ...["private", "is_private", "restricted", "members_only"].map((key): RoutingRow => ({ key, polarity: "widens-when-false" })),
  ...["visibility", "audience", "privacy", "access"].map((key): RoutingRow => ({ key, polarity: "enum", widening: WIDENING_WORDS, narrowing: NARROWING_WORDS })),
];

/** The boolean spellings a routing leaf may carry. Any other value is unread. */
export const BOOLEAN_TRUE: readonly unknown[] = [true, "true", 1, "1", "yes"];
export const BOOLEAN_FALSE: readonly unknown[] = [false, "false", 0, "0", "no"];

/** Payee: the payment reader's keys as they stand (server/stop-line.ts) and
 * the ones Rule 56b names. */
export const PAYEE_KEYS: readonly string[] = [
  "customer", "customer_id", "destination", "recipient", "recipient_id", "payee", "beneficiary", "receiver", "to", "email",
  "account", "charge", "payment_intent", "destination_account", "account_id", "amount", "currency", "price", "total",
];

/** Object: the thing acted on, never a person. Any other key ending `_id` or
 * `Id` that is not an addressing key is an object too (OBJECT_ID_SUFFIX). */
export const OBJECT_KEYS: readonly string[] = ["id", "ids"];
export const OBJECT_ID_SUFFIX = /(_id|Id)$/;

/** Content: what is said, searched or attached; never a recipient. */
export const CONTENT_KEYS: readonly string[] = [
  "subject", "body", "text", "message", "html", "markdown", "content", "title", "description", "summary", "note", "notes",
  "comment", "query", "q", "search", "filter", "keyword", "keywords", "attachments", "files", "blocks", "from", "sender",
  "as_user", "from_email", "from_name", "reply_to", "template", "template_id", "variables", "values", "properties", "fields_values",
];

/** Metadata: established harmless semantics, any type, never holds. */
export const METADATA_KEYS: readonly string[] = [
  "limit", "max_results", "maxResults", "page", "page_size", "pageSize", "per_page", "offset", "cursor", "page_token",
  "pageToken", "sort", "sort_by", "order", "order_by", "fields", "select", "expand", "dry_run", "format", "is_html",
  "parse_mode", "mrkdwn", "timezone", "time_zone", "locale", "language", "priority", "importance", "color", "icon", "emoji",
  "icon_emoji", "unfurl_links", "unfurl_media", "due", "due_date", "due_on", "start", "start_time", "end", "end_time", "date",
  "time", "datetime", "duration", "all_day", "allDay", "reminders", "status", "stage", "pinned", "starred", "archived", "read",
  "unread", "completed", "done", "silent", "disable_notification", "disable_web_page_preview", "protect_content", "version",
  "etag", "if_match", "idempotency_key", "request_id", "client_msg_id", "nonce", "labels", "tags", "label_ids",
];

/** Rule 56a step 4: `format: uri` never decides alone. These keys are
 * addressing on an operation not proven read-only and metadata on one that
 * is; URI_CONTENT_KEYS are content; any other `uri` key is unknown. */
export const URI_ADDRESSING_KEYS: readonly string[] = ["url", "webhook_url", "callback_url", "endpoint", "uri", "notification_url"];
export const URI_CONTENT_KEYS: readonly string[] = [
  "link", "href", "permalink", "image_url", "icon_url", "avatar_url", "thumbnail_url", "attachment_url", "file_url", "media_url", "video_url",
];
/** Rule 56a step 4: schema formats that make a leaf addressing. */
export const ADDRESSING_FORMATS: readonly string[] = ["email", "phone", "tel"];

/** Rule 56a step 3: a schema description that names a recipient role for
 * THIS property. The first makes a payee for the payee words. */
export const RECIPIENT_ROLE_DESCRIPTIONS: readonly RegExp[] = [
  /^(the )?(recipient|addressee|payee|beneficiary|destination)\b/i,
  /\b(id|identifier|address|number|handle|name) of the (recipient|user|member|channel|chat|room|conversation|group|payee|beneficiary)\b/i,
];
export const PAYEE_ROLE_WORDS: readonly string[] = ["payee", "beneficiary"];

/** Rule 56d: in addressing context, the leaves that ARE a destination. */
export const DESTINATION_LEAF_KEYS: readonly string[] = [
  "email", "emailAddress", "email_address", "address", "addr", "id", "user_id", "userId", "channel_id", "channelId", "chat_id",
  "chatId", "phone", "phone_number", "phoneNumber", "number", "handle", "username", "value", "to", "recipient",
];
/** Rule 56d: in addressing context, the leaves that are validated and are NOT
 * a destination. */
export const DISPLAY_LEAF_KEYS: readonly string[] = [
  "name", "display_name", "displayName", "label", "title", "first_name", "last_name", "full_name", "firstName", "lastName",
  "type", "kind", "role",
];

// ---------------------------------------------------------------------------
// Rule 70: recursive content reads and name listers.

/** How a program reads a directory's contents, which decides whether it is
 * judged on its descendants (Rule 63 step 4). */
export type RecursiveReader =
  /** reads a directory root's contents only with one of `flags` */
  | { program: string; how: "with-flag"; flags: readonly string[]; narrowable: boolean }
  /** reads a directory root's contents on every run */
  | { program: string; how: "always"; narrowable: boolean }
  /** reads the tracked tree under the cwd (`git grep`) */
  | { program: string; how: "tracked-tree"; narrowable: boolean }
  /** `tar` in create mode */
  | { program: string; how: "create"; narrowable: boolean }
  /** `find`/`bfs` with an action that runs a reader on each entry */
  | { program: string; how: "exec-action"; actions: readonly string[]; narrowable: boolean }
  /** `<lister> | xargs <reader>`, the lister one of `listers` in the same pipeline */
  | { program: string; how: "xargs-feed"; listers: readonly string[]; narrowable: boolean }
  /** a file reader whose operand is a directory or an expansion */
  | { program: string; how: "directory-operand"; narrowable: boolean };

/** `narrowable` is whether Rule 73 has a trailing exclusion for it (the
 * NARROWERS table); every other reader over a root with a sensitive
 * descendant is a narrowing denial (Rule 72). */
export const RECURSIVE_READERS: readonly RecursiveReader[] = [
  { program: "grep", how: "with-flag", flags: ["-r", "-R", "--recursive", "--dereference-recursive"], narrowable: true },
  { program: "rg", how: "always", narrowable: true },
  { program: "ag", how: "always", narrowable: false },
  { program: "ack", how: "always", narrowable: false },
  { program: "ugrep", how: "always", narrowable: true },
  { program: "git grep", how: "tracked-tree", narrowable: true },
  { program: "diff", how: "with-flag", flags: ["-r", "--recursive"], narrowable: false },
  { program: "tar", how: "create", narrowable: false },
  { program: "zip", how: "with-flag", flags: ["-r"], narrowable: false },
  { program: "cp", how: "with-flag", flags: ["-r", "-R", "-a"], narrowable: false },
  { program: "rsync", how: "always", narrowable: false },
  { program: "scp", how: "with-flag", flags: ["-r"], narrowable: false },
  { program: "find", how: "exec-action", actions: ["-exec", "-execdir", "-ok", "-okdir"], narrowable: false },
  { program: "bfs", how: "exec-action", actions: ["-exec", "-execdir", "-ok", "-okdir"], narrowable: false },
  { program: "xargs", how: "xargs-feed", listers: ["find", "ls", "git ls-files"], narrowable: false },
  ...["cat", "head", "tail", "sort", "wc", "strings", "od", "xxd", "sed", "awk", "less", "more"]
    .map((program): RecursiveReader => ({ program, how: "directory-operand", narrowable: false })),
];

/** Rule 70: name listers print names and metadata, never contents, and are
 * judged on their operands only. `find`/`bfs` are listers only with none of
 * LISTER_TURNS_READER. Claude's `Glob` is the tool of the same role. */
export const NAME_LISTERS: readonly string[] = ["find", "bfs", "ls", "tree", "du", "stat", "file", "Glob"];
export const LISTER_TURNS_READER: readonly string[] = ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf"];

// ---------------------------------------------------------------------------
// Rule 71b4: role pins, kept only where the pinned role is inert.

/** A quoted unresolved word in the FIRST operand slot of these programs is
 * pinned by the option named, through the Rule 73 rewrite. */
export const ROLE_PINS: readonly { program: string; pin: "-e" | "--" }[] = [
  ...["grep", "rg", "egrep", "fgrep", "ugrep", "git grep"].map((program) => ({ program, pin: "-e" as const })),
  ...["basename", "dirname", "ls"].map((program) => ({ program, pin: "--" as const })),
];

// ---------------------------------------------------------------------------
// Rule 68f: the non-interactive contract.

/** What an interactive program is, which decides how a body is given. */
export type InteractiveKind = "shell" | "interpreter" | "repl-only" | "sql" | "remote" | "named";

/** How a literal body is given: `options` carry it as their argument;
 * `operand` is the operand position that holds it (`first` for `redis-cli
 * ping`, `after-first` for `sqlite3 db 'select 1'` and `ssh host ls`). */
export interface BodyForm { options: readonly string[]; operand?: "first" | "after-first" }

/** Case 1: a program that reads stdin as COMMANDS. With no literal body it is
 * U19; `named` programs (pagers, editors, debuggers, remote sessions with no
 * command form, multiplexers, recorders, monitors, `expect`) are case 1
 * whatever their operands; `repl-only` has no body form at all. */
export const INTERACTIVE_PROGRAMS: readonly { program: string; kind: InteractiveKind; body: BodyForm }[] = [
  ...["bash", "sh", "zsh", "fish"].map((program) => ({ program, kind: "shell" as const, body: { options: ["-c"] } })),
  { program: "python3", kind: "interpreter", body: { options: ["-c"] } },
  { program: "node", kind: "interpreter", body: { options: ["-e", "--eval"] } },
  { program: "mongosh", kind: "interpreter", body: { options: ["--eval"] } },
  { program: "redis-cli", kind: "interpreter", body: { options: [], operand: "first" } },
  { program: "irb", kind: "repl-only", body: { options: [] } },
  { program: "php -a", kind: "repl-only", body: { options: [] } },
  { program: "psql", kind: "sql", body: { options: ["-c", "-f"] } },
  { program: "mysql", kind: "sql", body: { options: ["-e"] } },
  { program: "sqlite3", kind: "sql", body: { options: [], operand: "after-first" } },
  { program: "ssh", kind: "remote", body: { options: [], operand: "after-first" } },
  ...["telnet", "ftp", "sftp", "nc", "less", "more", "most", "vi", "vim", "nvim", "nano", "emacs", "ed", "ex", "gdb", "lldb", "pdb", "tmux", "screen", "expect", "script", "top", "htop"]
    .map((program) => ({ program, kind: "named" as const, body: { options: [] } })),
];

/** Case 1 continuations: per shell and interpreter, the options and
 * environment names that keep the process reading stdin as commands once the
 * body has run. A listed option on the line, or a listed name whose state is
 * anything but its ENV_PINS pin, is U19. */
export const INTERACTIVE_CONTINUATIONS: readonly { program: string; options: readonly string[]; names: readonly string[] }[] = [
  { program: "python3", options: ["-i"], names: ["PYTHONINSPECT"] },
  { program: "node", options: ["-i", "--interactive"], names: [] },
  { program: "mongosh", options: ["--shell"], names: [] },
  { program: "sqlite3", options: ["-interactive"], names: [] },
  ...["bash", "sh", "zsh"].map((program) => ({ program, options: [] as string[], names: ["BASH_ENV", "ENV", "ZDOTDIR"] })),
];

/** Case 2: the names and options each program that starts a pager, editor or
 * prompt on its own consults. Every name here is a key of ENV_PINS. */
export const PIN_NAMES: readonly { program: string; names: readonly string[]; options: readonly string[] }[] = [
  {
    program: "git",
    names: [
      "PAGER", "GIT_PAGER", "GIT_EDITOR", "EDITOR", "VISUAL", "GIT_SEQUENCE_EDITOR", "GIT_TERMINAL_PROMPT", "GIT_ASKPASS",
      "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", "GCM_INTERACTIVE", "GIT_SSH_COMMAND", "GIT_SSH", "GIT_SSH_VARIANT",
    ],
    options: [
      "-p", "--paginate", "-c core.pager=", "-c core.editor=", "-c sequence.editor=", "-c pager.*=",
      "-c core.sshCommand=", "-c core.askPass=", "-c credential.interactive=",
    ],
  },
  { program: "ssh", names: ["SSH_ASKPASS", "SSH_ASKPASS_REQUIRE"], options: [] },
  { program: "rsync", names: ["RSYNC_RSH"], options: [] },
  { program: "man", names: ["MANPAGER", "PAGER"], options: ["-P", "--pager"] },
  { program: "systemctl", names: ["SYSTEMD_PAGER", "PAGER"], options: [] },
  { program: "journalctl", names: ["SYSTEMD_PAGER", "PAGER"], options: [] },
  { program: "psql", names: ["PSQL_PAGER", "PAGER", "PSQL_EDITOR", "PSQLRC"], options: ["-P pager=", "--pset=pager="] },
  { program: "crontab", names: ["EDITOR", "VISUAL"], options: [] },
  { program: "visudo", names: ["EDITOR", "VISUAL"], options: [] },
  // case 1 programs with a body: their continuation names
  { program: "python3", names: ["PYTHONINSPECT"], options: [] },
  ...["bash", "sh", "zsh"].map((program) => ({ program, names: ["BASH_ENV", "ENV", "ZDOTDIR"], options: [] as string[] })),
];

// ---------------------------------------------------------------------------
// Rule 74c: the one pin table.

/** A value pin is written into every engine's environment last; an absence
 * pin is deleted from it and its name recorded in F12's `absent`; a resolved
 * pin is a value pin whose value `resolvePins` computes per hand (the ssh
 * transport, delta 2). `win32` is the Windows spelling where the POSIX value
 * names a POSIX path. */
export type EnvPin = { name: string; value: string; win32?: string } | { name: string; absent: true } | { name: string; resolved: true };

export const ENV_PINS: readonly EnvPin[] = [
  { name: "PAGER", value: "cat" },
  { name: "GIT_PAGER", value: "cat" },
  { name: "MANPAGER", value: "cat" },
  { name: "SYSTEMD_PAGER", value: "cat" },
  { name: "PSQL_PAGER", value: "cat" },
  { name: "LESS", value: "" },
  { name: "GIT_EDITOR", value: "true" },
  { name: "GIT_SEQUENCE_EDITOR", value: "true" },
  { name: "EDITOR", value: "true" },
  { name: "VISUAL", value: "true" },
  { name: "PSQL_EDITOR", value: "true" },
  { name: "PSQLRC", value: "/dev/null", win32: "NUL" },
  { name: "GIT_TERMINAL_PROMPT", value: "0" },
  // Delta 1: EMPTY on every platform. git `prompt.c` runs an askpass only `if (askpass && *askpass)`, so a set-but-empty
  // GIT_ASKPASS ends the chain (core.askPass and SSH_ASKPASS are never read) and runs nothing; Git for Windows keeps an empty
  // value. OpenSSH with SSH_ASKPASS empty and SSH_ASKPASS_REQUIRE=never starts no askpass program, and with no controlling
  // tty its password, passphrase and host-key reads fail instead of asking. DISPLAY and WAYLAND_DISPLAY are kept.
  { name: "GIT_ASKPASS", value: "" },
  { name: "SSH_ASKPASS", value: "" },
  { name: "SSH_ASKPASS_REQUIRE", value: "never" },
  // Delta 4' (b): Git Credential Manager shows no UI and no terminal prompt
  { name: "GCM_INTERACTIVE", value: "0" },
  // Delta 2: the ssh git and rsync run is the identified OpenSSH (or plain ssh) with BatchMode on; GIT_SSH_VARIANT names that
  // variant, so git runs no `-G` probe of its own, and GIT_SSH is removed so nothing sits between GIT_SSH_COMMAND and git.
  { name: "GIT_SSH_VARIANT", value: "ssh" },
  { name: "GIT_SSH_COMMAND", resolved: true },
  { name: "RSYNC_RSH", resolved: true },
  { name: "TERM", value: "dumb" },
  { name: "DEBIAN_FRONTEND", value: "noninteractive" },
  // 1.0.9 (Astra r5): EMPTY on every platform. An inherited CDPATH moves a relative `cd` (`CDPATH=/dev` puts `cd fd` in
  // /dev/fd), and the always-ask reader places a script from `cd` with no search. bash, zsh, dash and ksh read an empty
  // CDPATH as no search list (an empty value names no folder, and nothing is printed), so `cd x` is `./x` as typed.
  { name: "CDPATH", value: "" },
  { name: "ZDOTDIR", value: "/dev/null", win32: "NUL" },
  { name: "BASH_ENV", absent: true },
  { name: "ENV", absent: true },
  // 1.0.9 (NOLIMITS-NODE-109-CUT R6, defence in depth): an inherited SHELLOPTS or BASHOPTS turns bash options on at start-up
  // (`physical` makes `cd` follow links). The always-ask reader allows no `..` in a path, so it does not depend on these.
  { name: "SHELLOPTS", absent: true },
  { name: "BASHOPTS", absent: true },
  { name: "CLAUDE_ENV_FILE", absent: true },
  { name: "PYTHONINSPECT", absent: true },
  { name: "POSIXLY_CORRECT", absent: true },
  { name: "GIT_SSH", absent: true },
];

/** The absence pins: the one source of F12's `absent` set. */
export const ABSENT_PINS: readonly string[] = ENV_PINS.filter((pin) => "absent" in pin).map((pin) => pin.name);

/** The fixed value pins with the spelling for a platform (the resolved ones come from `resolvePins`). */
export function valuePins(platform: NodeJS.Platform): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const pin of ENV_PINS) if ("value" in pin) out.set(pin.name, platform === "win32" && pin.win32 !== undefined ? pin.win32 : pin.value);
  return out;
}

// ---------------------------------------------------------------------------
// Rule 74c (b), deltas 2, 3 and 5: the ssh git and rsync run, resolved per hand.

/** The four reasons the Engines panel gives for an owner ssh setting engines do not use, one-to-one from the grammar and
 *  OpenSSH identification. */
export const SSH_REASONS = {
  moreThanOne: "it runs more than one command",
  expansion: "it uses shell expansion such as $, backticks or wildcards",
  notOpenSsh: "it is not OpenSSH",
  notFound: "its program was not found",
} as const;

export type SshParse = { program: string; argv: string[] } | { cannot: string };

const BARE_WORD = /[A-Za-z0-9_@%+=:,./-]/;
const COMMAND_BREAK = new Set([";", "&", "|", "<", ">", "(", ")", "{", "}", "\n", "\r", "\u0000"]);

/** The only reader of owner ssh command text (`GIT_SSH_COMMAND`, `core.sshCommand`, an rsync `-e`). POSIX sh quoting on every
 *  platform (Git for Windows runs both through its own sh). The text parses only as ONE simple command of literal words:
 *  words split by spaces or tabs; a word is adjacent pieces of bare `[A-Za-z0-9_@%+=:,./-]`, `'...'` taken literally, or
 *  `"..."` with no `$` or backtick, where a backslash before `"`, `\`, `$` or backtick yields that character and before
 *  anything else stays a backslash; a bare `~` or `~/` starting a word is the owner's home. Anything else does not parse. */
export function parseSshCommand(text: string, opts: { platform?: NodeJS.Platform; home?: string } = {}): SshParse {
  const words: string[] = [];
  const n = text.length;
  let i = 0;
  for (;;) {
    while (i < n && (text[i] === " " || text[i] === "\t")) i++;
    if (i >= n) break;
    let word = "";
    if (text[i] === "~") {
      const next = text[i + 1];
      if ((next !== undefined && next !== " " && next !== "\t" && next !== "/") || !opts.home) return { cannot: SSH_REASONS.expansion };
      word = opts.home;
      i++;
    }
    while (i < n && text[i] !== " " && text[i] !== "\t") {
      const ch = text[i]!;
      if (BARE_WORD.test(ch)) {
        word += ch;
        i++;
      } else if (ch === "'") {
        const end = text.indexOf("'", i + 1);
        if (end < 0) return { cannot: SSH_REASONS.expansion };
        word += text.slice(i + 1, end);
        i = end + 1;
      } else if (ch === "\"") {
        let j = i + 1;
        let closed = false;
        while (j < n) {
          const c = text[j]!;
          if (c === "\"") { closed = true; break; }
          if (c === "$" || c === "`") return { cannot: SSH_REASONS.expansion };
          if (c === "\\") {
            const d = text[j + 1];
            if (d === undefined || d === "\n") return { cannot: SSH_REASONS.expansion };
            if (d === "\"" || d === "\\" || d === "$" || d === "`") { word += d; j += 2; continue; }
          }
          word += c;
          j++;
        }
        if (!closed) return { cannot: SSH_REASONS.expansion };
        i = j + 1;
      } else {
        return { cannot: COMMAND_BREAK.has(ch) ? SSH_REASONS.moreThanOne : SSH_REASONS.expansion };
      }
    }
    words.push(word);
  }
  const [program, ...argv] = words;
  if (program === undefined || program === "") return { cannot: SSH_REASONS.notFound };
  // an env-assignment prefix: the first word is no program at all
  if (program.includes("=")) return { cannot: SSH_REASONS.notOpenSsh };
  return { program, argv };
}

const shellQuote = (word: string): string => `'${word.replace(/'/g, "'\\''")}'`;

/** The pinned GIT_SSH_COMMAND and RSYNC_RSH: the program, `-o BatchMode=yes`, then the kept owner words, EVERY word single-quoted.
 *  ssh takes the first value of an option, so BatchMode governs even after an owner `-o BatchMode=no`. */
export function sshPinCommand(program: string, argv: readonly string[]): string {
  return [program, "-o", "BatchMode=yes", ...argv].map(shellQuote).join(" ");
}

/** A bounded auxiliary run (`<ssh> -V`, `git config --get core.sshCommand`); engine-env.ts hands execCli. */
export type PinRun = (
  file: string,
  args: string[],
  opts: { env: Readonly<Record<string, string>>; cwd?: string; timeoutMs: number },
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export type SshSource = { setting: "GIT_SSH_COMMAND" | "GIT_SSH" | "core.sshCommand"; value: string } | { setting: "none" };

/** What the hand did with the owner's ssh setting: the source git itself would use, whether it was kept (parsed and OpenSSH),
 *  the pinned command, and the Engines panel lines. */
export interface SshResolution { source: SshSource; kept: boolean; command: string; notes: string[] }

export interface ResolvedPins { pins: ReadonlyMap<string, string>; ssh: SshResolution }

/** The mandatory bound on `<ssh> -V` and `git config --get core.sshCommand`. */
export const PIN_PROBE_MS = 2_000;
const IDENTITIES_MAX = 64;
const identities = new Map<string, boolean>();

export function resetSshIdentityCacheForTests(): void { identities.clear(); }

const NO_OPENSSH_LINE = "Murage found no OpenSSH on the PATH engines use, so git and rsync in engines run plain ssh with BatchMode on.";

function isRealFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** The program placed by (b) with every part present, to a real file: a path as written, a bare name in the first handed-PATH
 *  folder (each placed in order) that holds it. */
function placeProgram(program: string, platform: NodeJS.Platform, path: string): string | null {
  if (!program) return null;
  const hasSeparator = platform === "win32" ? /[\\/]/.test(program) : program.includes("/");
  if (hasSeparator) {
    const placed = realPathInOrder(program, "", { platform, mustExist: true });
    return "cannot" in placed || !isRealFile(placed.real) ? null : placed.real;
  }
  const p = platform === "win32" ? win32 : posix;
  const names = platform === "win32" && !/\.[A-Za-z0-9]+$/.test(program) ? [`${program}.exe`, program] : [program];
  for (const entry of path.split(platform === "win32" ? ";" : ":")) {
    if (!entry || !p.isAbsolute(entry)) continue;
    const dir = realDir(entry, { platform });
    if (!dir) continue;
    for (const name of names) {
      const joined = joinReal(dir, name);
      if ("cannot" in joined) continue;
      const placed = realPathInOrder(joined.path, "", { platform, mustExist: true });
      if (!("cannot" in placed) && isRealFile(placed.real)) return placed.real;
    }
  }
  return null;
}

/** OpenSSH identification, one rule for command text, GIT_SSH and the default `ssh`: placed to a real file, and `<real> -V`
 *  with the handed env (2 s) prints a line starting `OpenSSH_`. Cached by file identity, re-stated on every hand. Returns the
 *  identified executable's real path, which the pin names (never the spelling it was found by), or the reason it is not. */
async function openSshCheck(program: string, platform: NodeJS.Platform, deps: { run: PinRun; env: Readonly<Record<string, string>> }): Promise<{ real: string } | string> {
  const real = placeProgram(program, platform, deps.env.PATH ?? "");
  if (!real) return SSH_REASONS.notFound;
  let key: string;
  try {
    const st = statSync(real);
    key = [real, st.dev, st.ino, st.size, st.mtimeMs].join("\u0000");
  } catch {
    return SSH_REASONS.notFound;
  }
  const known = identities.get(key);
  if (known !== undefined) return known ? { real } : SSH_REASONS.notOpenSsh;
  const out = await deps.run(real, ["-V"], { env: deps.env, timeoutMs: PIN_PROBE_MS }).catch(() => ({ ok: false, stdout: "", stderr: "" }));
  const openSsh = `${out.stdout}\n${out.stderr}`.split(/\r?\n/).some((line) => line.startsWith("OpenSSH_"));
  // a run that printed nothing (a timeout, a spawn failure) is not remembered
  if (openSsh || out.stdout || out.stderr) {
    identities.set(key, openSsh);
    while (identities.size > IDENTITIES_MAX) identities.delete(identities.keys().next().value!);
  }
  return openSsh ? { real } : SSH_REASONS.notOpenSsh;
}

/** What git itself would pick, from the PRE-pin owner map: GIT_SSH_COMMAND, else GIT_SSH, else `git config --get
 *  core.sshCommand` in the session folder with the pre-pin env (2 s; a failure is none). */
async function sshSource(ownerEnv: Readonly<Record<string, string>>, deps: { run: PinRun; cwd?: string }): Promise<SshSource> {
  if (ownerEnv.GIT_SSH_COMMAND) return { setting: "GIT_SSH_COMMAND", value: ownerEnv.GIT_SSH_COMMAND };
  if (ownerEnv.GIT_SSH) return { setting: "GIT_SSH", value: ownerEnv.GIT_SSH };
  const out = await deps.run("git", ["config", "--get", "core.sshCommand"], { env: ownerEnv, cwd: deps.cwd, timeoutMs: PIN_PROBE_MS })
    .catch(() => ({ ok: false, stdout: "", stderr: "" }));
  const value = out.ok ? out.stdout.replace(/\r?\n$/, "") : "";
  return value ? { setting: "core.sshCommand", value } : { setting: "none" };
}

function displacedLine(source: Exclude<SshSource, { setting: "none" }>, why: string, homes: readonly (string | undefined)[]): string {
  let shown = source.value;
  for (const home of homes) if (home && home.length > 1) shown = shown.split(home).join("~");
  shown = shown.replace(/[\u0000-\u001f]/g, " ");
  const asking = why === SSH_REASONS.notFound ? "" : " and Murage could not stop it asking for a password";
  return `Engines use plain ssh for git instead of your ${source.setting} (${shown}), because ${why}${asking}. Your own git is unchanged.`;
}

/** Rule 74c: the whole pin map for one hand, the fixed value pins plus GIT_SSH_COMMAND and RSYNC_RSH resolved (delta 2), and
 *  the displaced-settings rule (delta 5). Called only by handEnv. Murage never writes the owner's git config, ssh config or
 *  shell files: only the map handed to engines changes. `deps.env` is the handed env the probes run with. */
export async function resolvePins(
  ownerEnv: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
  deps: { run: PinRun; cwd?: string; env: Readonly<Record<string, string>> },
): Promise<ResolvedPins> {
  const pins = new Map(valuePins(platform));
  const homeRaw = ownerEnv.HOME ?? (platform === "win32" ? ownerEnv.USERPROFILE : undefined);
  const home = homeRaw ? realDir(homeRaw, { platform }) ?? undefined : undefined;
  const source = await sshSource(ownerEnv, deps);
  let kept = false;
  let program = "ssh";
  let argv: string[] = [];
  const notes: string[] = [];
  if (source.setting !== "none") {
    const parsed: SshParse = source.setting === "GIT_SSH" ? { program: source.value, argv: [] } : parseSshCommand(source.value, { platform, home });
    const why = "cannot" in parsed ? parsed.cannot : await openSshCheck(parsed.program, platform, deps);
    if (typeof why !== "string" && !("cannot" in parsed)) {
      kept = true;
      // the identified executable, so the pin does not depend on the PATH the engine's shell searches
      program = why.real;
      argv = parsed.argv;
    } else {
      notes.push(displacedLine(source, typeof why === "string" ? why : SSH_REASONS.notOpenSsh, [home, homeRaw]));
    }
  }
  if (!kept) {
    const plain = await openSshCheck("ssh", platform, deps);
    if (typeof plain === "string") notes.push(NO_OPENSSH_LINE);
    else program = plain.real;
  }
  const command = sshPinCommand(program, argv);
  pins.set("GIT_SSH_COMMAND", command);
  pins.set("RSYNC_RSH", command);
  return { pins, ssh: { source, kept, command, notes } };
}

// ---- delta 3: the direct ssh row (nothing runs at verdict time) ----------------------------------------------------------

export const DIRECT_SSH_REASON = "run ssh with -o BatchMode=yes -o ProxyCommand=none; for a host behind a jump host, use git or rsync";

/** Per program, the short options that take a value. */
const SSH_VALUE_OPTIONS: Readonly<Record<"ssh" | "scp" | "sftp", string>> = { ssh: "BbcDEeFIiJLlmOoPpQRSWw", scp: "cDFiJloPSX", sftp: "BbcDFiJloPRSsX" };

function programName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).replace(/\.exe$/i, "").toLowerCase();
}

/** The options before the destination, each as [flag, value]. */
function sshOptionsOf(kind: "ssh" | "scp" | "sftp", args: readonly string[]): [string, string][] {
  const valued = SSH_VALUE_OPTIONS[kind];
  const out: [string, string][] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (word === "--" || !word.startsWith("-") || word === "-") break;
    for (let k = 1; k < word.length; k++) {
      const flag = word[k]!;
      if (valued.includes(flag)) {
        const rest = word.slice(k + 1);
        out.push([flag, rest !== "" ? rest : args[++i] ?? ""]);
        break;
      }
      out.push([flag, ""]);
    }
  }
  return out;
}

function sshLineMeets(kind: "ssh" | "scp" | "sftp", args: readonly string[]): boolean {
  let batch: string | undefined;
  let proxy: string | undefined;
  for (const [flag, value] of sshOptionsOf(kind, args)) {
    if (flag === "J") return false;
    if (flag === "S" && kind !== "ssh") return false;
    if (flag !== "o") continue;
    const m = /^\s*([A-Za-z]+)\s*(?:=\s*|\s+)(.*)$/.exec(value);
    const key = (m ? m[1]! : value).trim().toLowerCase();
    const setting = (m ? m[2]! : "").trim().toLowerCase();
    if (key === "batchmode" && batch === undefined) batch = setting;
    if (key === "proxycommand" && proxy === undefined) proxy = setting;
    if (key === "proxyjump" && setting !== "none") return false;
  }
  return batch === "yes" && proxy === "none";
}

/** rsync's `-e`/`--rsh` value, or undefined when the line has none. */
function rsyncRsh(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (word === "--") break;
    if (word === "--rsh") return args[i + 1] ?? "";
    if (word.startsWith("--rsh=")) return word.slice("--rsh=".length);
    if (/^-[^-]/.test(word)) {
      const at = word.indexOf("e");
      if (at > 0) {
        const rest = word.slice(at + 1);
        return rest !== "" ? rest : args[i + 1] ?? "";
      }
    }
  }
  return undefined;
}

/** Delta 3: `ssh`, `scp`, `sftp` meet the row only with `-o BatchMode=yes` as their first BatchMode option and `-o
 *  ProxyCommand=none` as their first ProxyCommand option before the destination, no `-J`, no ProxyJump other than `none`, and
 *  (scp, sftp) no `-S` program. `rsync` with no `-e`/`--rsh` runs the pinned RSYNC_RSH; with one, its value must parse under
 *  the strict grammar as ssh and meet the same row. Any other program is not this row's. */
export function directSshMeetsRow(argv: readonly string[]): { meets: true } | { meets: false; reason: string } {
  const name = programName(argv[0] ?? "");
  const held = { meets: false as const, reason: DIRECT_SSH_REASON };
  if (name === "ssh" || name === "scp" || name === "sftp") return sshLineMeets(name, argv.slice(1)) ? { meets: true } : held;
  if (name !== "rsync") return { meets: true };
  const rsh = rsyncRsh(argv.slice(1));
  if (rsh === undefined) return { meets: true };
  const parsed = parseSshCommand(rsh);
  if ("cannot" in parsed || programName(parsed.program) !== "ssh") return held;
  return sshLineMeets("ssh", parsed.argv) ? { meets: true } : held;
}

// ---- Rule 68f: a per-command value other than its pin (U19) ----------------------------------------------------------------

const GIT_VALUED_GLOBALS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);

/** git's global options, the words before its subcommand. */
function gitGlobalOptions(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (!word.startsWith("-")) break;
    out.push(word);
    if (GIT_VALUED_GLOBALS.has(word) && i + 1 < args.length) out.push(args[++i]!);
  }
  return out;
}

function optionOnLine(option: string, words: readonly string[]): boolean {
  if (option.startsWith("-c ")) {
    const want = option.slice(3, -1).toLowerCase();
    const matches = (pair: string) => {
      const key = pair.split("=")[0]!.toLowerCase();
      return want.endsWith(".*") ? key.startsWith(want.slice(0, -1)) : key === want;
    };
    return words.some((word, i) => (word === "-c" && words[i + 1] !== undefined && matches(words[i + 1]!)) || (/^-c[^-]/.test(word) && matches(word.slice(2))));
  }
  const space = option.indexOf(" ");
  if (space > 0) {
    const flag = option.slice(0, space);
    const prefix = option.slice(space + 1);
    return words.some((word, i) => (word === flag && (words[i + 1] ?? "").startsWith(prefix)) || (word !== flag && word.startsWith(flag) && word.slice(flag.length).startsWith(prefix)));
  }
  if (option.endsWith("=")) return words.some((word) => word.startsWith(option));
  return words.some((word) => word === option || (option.startsWith("--") && word.startsWith(`${option}=`)));
}

/** The environment a simple command inherits from the line before it reaches its own assignments: per name a literal value,
 *  `null` (removed: `unset`, `env -u`) or `"unknown"` (a value only known when it runs); `rest` is every other name, as
 *  handed (`kept`), removed by `env -i` (`cleared`) or not known after a user switch (`unknown`). */
export interface InheritedEnv {
  names: ReadonlyMap<string, { value: string } | null | "unknown">;
  rest: "kept" | "cleared" | "unknown";
}
export const KEPT_ENV: InheritedEnv = { names: new Map(), rest: "kept" };

/** Rule 68f case 1 over PIN_NAMES: a command-local assignment of a listed name to anything but its pin (an absence pin has no
 *  value, so any assignment), or a listed option, is U19 naming it. `words` is one simple command, assignments first; `pins`
 *  is the hand's resolved map. git's options are read before its subcommand only. `inherited` is what the line, a wrapper
 *  or a nested shell left in the command's environment: a listed name inherited with another value, a value pin removed, or
 *  a name not known is U19 too. */
export function pinOverride(words: readonly string[], pins: ReadonlyMap<string, string>, inherited: InheritedEnv = KEPT_ENV): { unknown: string } | null {
  let i = 0;
  const assigned = new Map<string, string>();
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) {
    const word = words[i]!;
    const eq = word.indexOf("=");
    assigned.set(word.slice(0, eq), word.slice(eq + 1));
    i++;
  }
  const program = words[i];
  if (program === undefined) return null;
  const name = programName(program);
  const args = words.slice(i + 1);
  for (const row of PIN_NAMES) {
    if (row.program !== name) continue;
    for (const pinned of row.names) {
      if (assigned.has(pinned)) {
        if (assigned.get(pinned) !== pins.get(pinned)) return { unknown: `${pinned} is set for this command to something other than Murage's pin` };
        continue;
      }
      // what the command inherits from earlier on the line, a wrapper or a nested shell (the effective value, Rule 68f case 1)
      const from = inherited.names.has(pinned) ? inherited.names.get(pinned)! : inherited.rest === "kept" ? undefined : inherited.rest;
      if (from === undefined) continue;
      if (from === "unknown") return { unknown: `${pinned} is not known for this command (a user switch or a value the line does not show), so Murage's pin may not hold` };
      if (from === null || from === "cleared") {
        if (pins.has(pinned)) return { unknown: `${pinned} is removed for this command, so Murage's pin does not hold` };
        continue;
      }
      if (from.value !== pins.get(pinned)) return { unknown: `${pinned} is set for this command to something other than Murage's pin` };
    }
    const scanned = name === "git" ? gitGlobalOptions(args) : args;
    for (const option of row.options) if (optionOnLine(option, scanned)) return { unknown: `${option.replace(/=$/, "")} overrides a pin for this command` };
  }
  return null;
}

// ---- per repository: a repository's own core.sshCommand (row data for Rule 68f's prompt-capable rows) ----------------------

/** git's network commands: `fetch`, `pull`, `push`, `ls-remote`, `remote update`, `submodule update`, `archive --remote`.
 *  `args` are the words after `git`. */
export function gitNetworkCommand(args: readonly string[]): boolean {
  const rest = args.slice(gitGlobalOptions(args).length);
  const sub = rest[0];
  if (sub === "fetch" || sub === "pull" || sub === "push" || sub === "ls-remote") return true;
  const next = rest.slice(1).find((word) => !word.startsWith("-"));
  if ((sub === "remote" || sub === "submodule") && next === "update") return true;
  if (sub === "archive") return rest.some((word) => word === "--remote" || word.startsWith("--remote="));
  return false;
}

/** When the hand's source is `core.sshCommand` or none, a git network command whose repository chain sets a core.sshCommand
 *  other than the source, or whose chain is unresolved, holds its card naming it; never silently swapped, never executed.
 *  Skipped when the source is the owner's GIT_SSH_COMMAND or GIT_SSH, which git itself puts above core.sshCommand. `chain`
 *  is disk-facts' repoConfigValues for `core.sshcommand` at the command's repository. */
export function repoSshCommandMismatch(facts: {
  source: SshSource;
  kept: boolean;
  gitArgs: readonly string[];
  chain: { ok: true; sshCommand?: string } | { ok: false };
}): { hold: false } | { hold: true; reason: string } {
  const { source, chain } = facts;
  if (source.setting === "GIT_SSH_COMMAND" || source.setting === "GIT_SSH") return { hold: false };
  if (!gitNetworkCommand(facts.gitArgs)) return { hold: false };
  const own = chain.ok ? chain.sshCommand : undefined;
  const differs = !chain.ok || (own !== undefined && (source.setting !== "core.sshCommand" || own !== source.value));
  if (!differs) return { hold: false };
  const engines = source.setting === "core.sshCommand" && facts.kept ? source.value : "plain ssh";
  return { hold: true, reason: `this repository sets its own core.sshCommand, which engines do not use; they use ${engines}` };
}

/** git's subcommand after its global options: `globals` are the words before it, `sub` the subcommand, `rest` the words
 *  after it. `args` are the words after `git`. */
export function gitSubcommand(args: readonly string[]): { globals: string[]; sub: string | undefined; rest: string[] } {
  const globals = gitGlobalOptions(args);
  return { globals, sub: args[globals.length], rest: args.slice(globals.length + 1) };
}

/** Whether an `ssh` line asks for a terminal on the remote host: the last of `-t`/`-T` (a cluster holding `t` counts) before
 *  the destination wins, and any `-o RequestTTY=` other than `no` asks. */
export function sshRequestsTty(args: readonly string[]): boolean {
  let tty = false;
  let requestTty = false;
  for (const [flag, value] of sshOptionsOf("ssh", args)) {
    if (flag === "t") tty = true;
    else if (flag === "T") tty = false;
    else if (flag === "o") {
      const m = /^\s*([A-Za-z]+)\s*(?:=\s*|\s+)(.*)$/.exec(value);
      if ((m ? m[1]! : value).trim().toLowerCase() === "requesttty" && (m ? m[2]! : "").trim().toLowerCase() !== "no") requestTty = true;
    }
  }
  return tty || requestTty;
}

// ---- Rule 68f: the prompt-capable rows (APP-GRANT-FIXPLAN-r6 (e)+(h) (c), design delta 4' (c)) --------------------------
//
// Stated scope (design note, Rule 74c; delta 4' (d)). These rows judge the command text a bot asks to run. They do not
// reach, and Murage does not intercept, parse or rewrite:
// - owner-configured ProxyCommand programs, `Match exec` programs, git credential helpers (`osxkeychain` is the owner's OS
//   keychain; Git Credential Manager is governed by the GCM_INTERACTIVE=0 pin), ssh-agent confirmations (keys the owner
//   loaded with `ssh-add -c`, and the agent's own askpass from the agent's environment) and commands that run on the remote
//   host. They are the owner's own trusted configuration, and a prompt they raise is one the owner configured. They still
//   run under the no-terminal launch (a) and the pins (b), so a program among them that reads /dev/tty finds none.
// - a PTY made inside an interpreter body (Python `pty`, `node-pty`): a program the bot wrote and ran, which keeps the
//   standing Rule 68f already gives such a script (design section 8, Codex row); the sandbox is its boundary.
// - engine-made PTYs: Codex `exec_command` accepts `tty: true`, its hook delivers the command text without it, and
//   `features.unified_exec` cannot be switched off (design section 8). Such a command runs on a PTY Codex owns, not on the
//   owner's terminal: a prompt there reaches the model through the unified-exec output, never the owner, and an answer can
//   only come by `write_stdin`, which keeps the standing design section 8 already gives it. These rows still judge that command's
//   text whatever its `tty`. So the guarantee is: no prompt from an engine process or descendant reaches the OWNER (no
//   tty of the owner's, no askpass, no credential UI, a card for every row); "no prompt is answerable at any hop" holds
//   for every launch without an engine-made PTY, and Codex `tty: true` is outside it. Claude `Bash`, Pi `bash` and ACP
//   `execute` make no PTY of their own. A T106 rig row records Codex's `tty: true` behaviour so a Codex change is seen.
// - Windows claims are per launch path (default-flag descendants attach to the hidden console), not a policy over
//   programs that ask for a new console; those are the new-console row below.
//
// Until the build step 4 walker lands every row holds the card with its reason; the walker later reads this same table,
// mapping the direct-ssh row to its narrowing denial. A row never adds a standing answer, it only removes one.

export type PromptRule =
  | "ssh-add" | "sudo" | "doas" | "su" | "pkexec" | "gpg" | "git-signing" | "pty" | "ssh-tty" | "new-console"
  | "repo-ssh-command" | "direct-ssh" | "unreadable";

/** One row: the program words it judges (basename, lowercase, `.exe` dropped) and the reason its card carries. */
export interface PromptRow { rule: PromptRule; programs: readonly string[]; reason: string }

/** The whole list, in the order a program word is judged. */
export const PROMPT_ROWS: readonly PromptRow[] = [
  { rule: "ssh-add", programs: ["ssh-add"], reason: "ssh-add can ask for a key's passphrase; only ssh-add -l, -L or -D runs without asking" },
  { rule: "sudo", programs: ["sudo"], reason: "sudo can ask for your password; add -n so it stops instead of asking" },
  { rule: "doas", programs: ["doas"], reason: "doas can ask for your password; add -n so it stops instead of asking" },
  { rule: "su", programs: ["su"], reason: "su asks for a password" },
  { rule: "pkexec", programs: ["pkexec"], reason: "pkexec asks for your password through your desktop" },
  { rule: "gpg", programs: ["gpg", "gpg2"], reason: "gpg can ask for a passphrase; add --batch --pinentry-mode error so it stops instead of asking" },
  { rule: "git-signing", programs: ["git"], reason: "this git command signs with gpg, which can ask for a passphrase; add --no-gpg-sign (git tag: --no-sign) to run it without signing" },
  { rule: "pty", programs: ["script", "expect", "unbuffer", "tmux", "screen", "socat"], reason: "this command makes a terminal that a program can ask for input on" },
  { rule: "ssh-tty", programs: ["ssh"], reason: "ssh -t makes a terminal on the remote host that can ask for input; run it with -T" },
  { rule: "new-console", programs: ["start", "start-process", "saps", "runas"], reason: "this opens a new window that can ask for input" },
  { rule: "repo-ssh-command", programs: ["git"], reason: "this repository sets its own core.sshCommand, which engines do not use" },
  { rule: "direct-ssh", programs: ["ssh", "scp", "sftp", "rsync"], reason: DIRECT_SSH_REASON },
  { rule: "unreadable", programs: [], reason: "Murage could not read this command whole, so it cannot tell whether it asks for input" },
];

/** ssh-add runs without asking when its only option is one of these (it reads the stdin pipe under RP_ALLOW_STDIN). */
export const SSH_ADD_QUIET: readonly string[] = ["-l", "-L", "-D"];

/** sudo and doas: their non-interactive forms, and the option letters (and sudo's long options) that take an argument. */
export const ESCALATOR_OPTIONS: Readonly<Record<"sudo" | "doas", { quiet: readonly string[]; valueLetters: string; valueLong: readonly string[] }>> = {
  sudo: {
    quiet: ["-n", "--non-interactive"],
    valueLetters: "ugCDhprtUTR",
    valueLong: ["--user", "--group", "--close-from", "--chdir", "--host", "--prompt", "--role", "--type", "--other-user", "--command-timeout", "--chroot"],
  },
  doas: { quiet: ["-n"], valueLetters: "uC", valueLong: [] },
};

/** gpg: the commands that never ask, the commands that do (long names, and the short letters a cluster may hold), the
 *  options read left to right as gpg assigns them, and the forms that hold the card whatever else stands. */
export const GPG_READ_ONLY: readonly string[] = [
  "--version", "--help", "-h", "--list-keys", "-k", "--list-public-keys", "--list-secret-keys", "-K", "--list-sigs", "--check-sigs",
  "--fingerprint", "--verify", "--export",
];
export const GPG_ASKING_LONG: readonly string[] = [
  "--sign", "--clearsign", "--clear-sign", "--detach-sign", "--encrypt", "--encrypt-files", "--symmetric", "--decrypt", "--decrypt-files",
  "--gen-key", "--generate-key", "--full-gen-key", "--full-generate-key", "--quick-gen-key", "--quick-generate-key", "--quick-add-key",
  "--quick-sign-key", "--quick-lsign-key", "--quick-add-uid", "--quick-revoke-uid", "--quick-set-expire", "--edit-key", "--sign-key",
  "--lsign-key", "--delete-secret-keys", "--delete-secret-and-public-keys", "--export-secret-keys", "--export-secret-subkeys", "--import",
  "--card-edit", "--edit-card", "--change-pin", "--passwd", "--change-passphrase", "--gen-revoke", "--generate-revocation",
  "--desig-revoke", "--generate-designated-revocation",
];
export const GPG_ASKING_LETTERS = "sbecd";
export const GPG_EFFECTIVE = { batch: "--batch", noBatch: "--no-batch", pinentry: "--pinentry-mode", quietPinentry: "error" } as const;
export const GPG_HOLDING: readonly string[] = ["--options", "--homedir", "--no-options"];
/** an assignment of this name moves gpg's home like `--homedir` */
export const GPG_HOME_NAMES: readonly string[] = ["GNUPGHOME"];

/** git signing: the commit-making subcommands (read `commit.gpgsign`), `tag` (reads `tag.gpgsign` and
 *  `tag.forcesignannotated`), and `push --signed`; the line flags that sign or pin signing off; the per-command names and
 *  global options that move the configuration out of the chain's reach. */
export const GIT_SIGNING = {
  commitMaking: ["commit", "commit-tree", "merge", "rebase", "cherry-pick", "revert", "am", "pull"],
  commitKeys: ["commit.gpgsign"],
  tagKeys: ["tag.gpgsign", "tag.forcesignannotated"],
  commitOn: ["-S", "--gpg-sign"],
  commitOff: ["--no-gpg-sign"],
  tagOn: ["-s", "-u", "--sign", "--local-user"],
  tagOff: ["--no-sign"],
  pushOn: ["--signed"],
  pushOff: ["--no-signed"],
} as const;
export const GIT_CONFIG_MOVERS = { namePrefixes: ["GIT_CONFIG", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "XDG_CONFIG_HOME"], names: ["HOME"], globals: ["--git-dir", "--work-tree", "--config-env", "--bare"] } as const;
/** git's boolean words */
export const GIT_TRUE_WORDS: readonly string[] = ["true", "yes", "on", "1"];
export const GIT_FALSE_WORDS: readonly string[] = ["false", "no", "off", "0", ""];

/** socat makes a PTY when one of its addresses is a `pty` address. */
export const PTY_ADDRESS_PROGRAMS: readonly string[] = ["socat"];

/** Programs whose words carry another command, read again in turn: a shell's `-c` body, `eval`, `cmd /c`, PowerShell's
 *  `-Command`, `xargs`, `watch`, and `find -exec`. Their bodies are judged as strictly as the top line. */
export const PROMPT_BODY_READERS = {
  shells: ["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "tcsh", "csh"],
  joined: ["eval"],
  cmd: ["cmd"],
  powershell: ["powershell", "pwsh"],
  xargs: ["xargs"],
  watch: ["watch"],
  find: ["find"],
  findExec: ["-exec", "-execdir", "-ok", "-okdir"],
} as const;

/** Whether a program (a bare name or a path, `.exe` optional, any case) is PowerShell, by the PowerShell names above. */
export function isPowerShellProgram(program: string): boolean {
  const base = program.slice(Math.max(program.lastIndexOf("/"), program.lastIndexOf("\\")) + 1).toLowerCase();
  return (PROMPT_BODY_READERS.powershell as readonly string[]).includes(base.endsWith(".exe") ? base.slice(0, -4) : base);
}

/** The leading reserved words of a shell command, skipped before its program word. */
export const SHELL_LEADING_WORDS: readonly string[] = ["if", "then", "else", "elif", "do", "while", "until", "!", "coproc"];

/** The wrapper words of the stop line (server/stop-line.ts reads this list) and of the prompt-capable reader: each is a
 *  program word judged by its own row and options first, then its wrapped command in turn. */
export const WRAPPER_PREFIXES: ReadonlySet<string> = new Set([
  "sudo", "doas", "command", "builtin", "nohup", "time", "nice", "exec", "env", "timeout", "caffeinate", "rtk", "stdbuf", "unbuffer", "ionice", "chronic",
]);

/** Rule 68f case 1 (r2 amendment item 1): the words that make a command code for the pinned names. A builtin or keyword that
 *  sets, removes or reads a name or runs text as the shell's own; a program that sets names for what it runs, or runs shell
 *  text; an interpreter that runs its arguments. A command holding any of them as a static word is code; a command holding none
 *  names a pin only as data (a search, a commit message, a document), and its arguments and here-documents are not read as
 *  shell text. (`printf` is code only with `-v`, which the reader checks itself.) */
export const PIN_CODE_WORDS: ReadonlySet<string> = new Set([
  "export", "declare", "typeset", "local", "readonly", "unset", "read", "mapfile", "readarray", "getopts", "let", "for", "select",
  "eval", "source", ".", "alias", "trap", "function", "setenv", "unsetenv", "time", "command", "builtin", "exec", "env",
  ...PROMPT_BODY_READERS.shells, ...PROMPT_BODY_READERS.cmd, ...PROMPT_BODY_READERS.powershell, ...PROMPT_BODY_READERS.xargs,
  ...PROMPT_BODY_READERS.watch, ...PROMPT_BODY_READERS.find, "parallel", "sudo", "doas", "su", "runuser", "pkexec", "make", "gmake",
  "launchctl", "systemctl", "systemd-run", "tmux", "screen", "script", "flock", "cross-env", "env-cmd", "envdir", "chpst", "direnv",
  "python", "python3", "node", "perl", "ruby", "php", "deno", "bun", "osascript", "awk", "gawk", "mawk", "nawk", "lua", "tclsh",
  "expect", "strace", "ltrace", "bwrap", "firejail",
]);

/** Per wrapper, its short options that take a value (the wrapped command starts after them). */
export const WRAPPER_VALUE_OPTIONS: Readonly<Record<string, string>> = {
  time: "fo", nice: "n", exec: "a", env: "uCS", timeout: "sk", caffeinate: "tw", stdbuf: "ioe", ionice: "cnp", unbuffer: "", chronic: "",
  xargs: "IiLlnPsdEa", watch: "nqg",
};

// ---------------------------------------------------------------------------
// Rule 73b: narrowing rewrites.

/** Whether the program permutes options after operands, which placement
 * (iii) relies on: `documented` by the program; `rig` when only the rig run
 * of T107 can say, so (iii) stays off until it is recorded as proven. */
export type Permutation = "documented" | "rig" | "none";

/** One narrowing spelling. `file` and `dir` are the words appended for a hit
 * on a file or a directory, each inserted as one single-quoted literal;
 * `<rel>` is the path relative to the command's working directory and
 * `<base>` its basename. */
export interface Narrower {
  program: string;
  /** the grep family the row speaks for, where one program name covers several */
  variant?: "gnu" | "bsd" | "ugrep";
  file: readonly string[];
  dir: readonly string[];
  placement: "last-option" | "after-double-dash" | "input-field";
  permutation: Permutation;
}

export const NARROWERS: readonly Narrower[] = [
  { program: "rg", file: ["--glob", "!/<rel>"], dir: ["--glob", "!/<rel>"], placement: "last-option", permutation: "documented" },
  { program: "grep", variant: "gnu", file: ["--exclude=<base>"], dir: ["--exclude-dir=<base>"], placement: "last-option", permutation: "documented" },
  { program: "grep", variant: "bsd", file: ["--exclude=<base>"], dir: ["--exclude-dir=<base>"], placement: "last-option", permutation: "rig" },
  { program: "grep", variant: "ugrep", file: ["--exclude=<base>"], dir: ["--exclude-dir=<base>"], placement: "last-option", permutation: "rig" },
  { program: "ugrep", variant: "ugrep", file: ["--exclude=<base>"], dir: ["--exclude-dir=<base>"], placement: "last-option", permutation: "rig" },
  { program: "git grep", file: [":(exclude)<rel>"], dir: [":(exclude)<rel>"], placement: "after-double-dash", permutation: "none" },
  // Claude's Windows `Grep`: the `glob` field gains `!<rel>` in the spelling
  // T107 proves on the pinned CLI; until then it is a narrowing denial.
  { program: "Grep", file: ["!<rel>"], dir: ["!<rel>"], placement: "input-field", permutation: "none" },
];

/** Rule 73b: the bytes that make a path NOT rewritable, because some listed
 * exclusion language reads them as pattern syntax. Murage escapes nothing. */
export const NOT_REWRITABLE = new Set(["*", "?", "[", "]", "{", "}", "\\", "!", "#", "\u0000", "\n", "\r"]);

/** Whether a path may be written into an exclusion as it stands. */
export function isRewritablePath(path: string): boolean {
  if (!path) return false;
  for (const ch of path) if (NOT_REWRITABLE.has(ch)) return false;
  return true;
}
