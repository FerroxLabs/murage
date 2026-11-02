// Folder trust through Murage (0.1.52 FUIGOTRUST1).
//
// Fuigo 1.0.13 gates repo-local sources — AGENTS.md / CLAUDE.md, rules,
// .mcp.json, .fuigo/ and .claude/ config, project skills and hooks — behind a
// per-folder trust decision, and answers "untrusted" on its own whenever
// nobody can be asked (Murage's piped spawn). Murage asks the human once per
// folder with a question card and remembers the answer. This module is the
// card's shape and the chip's wording, shared by the server (which raises
// the card) and the renderer (which shows it); no Node, no DOM.
import { QUESTION_LIMITS, type QuestionAnswer, type QuestionSpec } from "./questions.ts";

export type FolderTrustDecision = "trust" | "reject";

/** The one question a trust card asks; its id doubles as the request's tool. */
export const FOLDER_TRUST_QUESTION_ID = "folderTrust";

/** Option labels, exactly as offered and as the answer comes back. */
export const FOLDER_TRUST_OPTIONS = {
  trust: "Trust this folder",
  reject: "Don't trust",
} as const;

/** What a trust card is about: the folder, its canonical trust key (the git
 * root when the folder is inside a repository), and the sources it would
 * contribute, by name ("AGENTS.md", ".mcp.json", ".fuigo/skills"). */
export interface FolderTrustCard {
  key: string;
  folder: string;
  sources: string[];
}

/** Join source names for a card or chip, bounded so a repo with fifty rule
 * files still reads as one line. */
export function describeFolderTrustSources(sources: readonly string[], max = 6): string {
  const names = [...new Set(sources.map((s) => s.trim()).filter(Boolean))];
  if (!names.length) return "";
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

/** The trust question, phrased so the answer is a decision about the folder
 * (never free text): what the folder holds, and the two things a person can
 * say about it. */
export function folderTrustQuestion(card: FolderTrustCard): QuestionSpec {
  const what = describeFolderTrustSources(card.sources);
  const question = (what
    ? `Trust the files in ${card.folder}? It contains ${what}, which would steer the bot: instructions, tools and skills from this folder apply to every turn that runs here.`
    : `Trust the files in ${card.folder}? Instructions, tools and skills from this folder would apply to every turn that runs here.`
  ).slice(0, QUESTION_LIMITS.questionChars);
  return {
    id: FOLDER_TRUST_QUESTION_ID,
    header: "Folder trust",
    question,
    options: [
      { label: FOLDER_TRUST_OPTIONS.trust, description: "Apply them, and remember this for the folder." },
      { label: FOLDER_TRUST_OPTIONS.reject, description: "Run without them. The bot still works in the folder; those files are left out." },
    ],
    multiSelect: false,
    allowOther: false,
  };
}

/** What a generation 2 card (Fuigo 1.0.35 and later) is about. `key` is the
 * engine's own `workspace`, verbatim; `cwd` is where the bot is working;
 * `declines` are the Murage rejects a Trust of `key` may not keep, already in
 * display order, empty when every decline is known to be written. */
export interface FolderTrustCardV2 {
  key: string;
  cwd: string;
  sources: string[];
  /** `{key}/.git` exists: a repository's record also covers its worktrees. */
  repository: boolean;
  /** Full access or No limits: commands are not waiting on the owner. */
  fullAccess: boolean;
  declines: readonly string[];
}

/** "Don't trust" names its own way back on generation 2 (T2). */
export function folderTrustForgetLine(key: string): string {
  return `To be asked again, forget ${key} in this conversation's folder settings.`;
}

/** "{D1}, {D2}, {D3} and {n} more folders": the card's details list them all. */
export function describeFolderTrustDeclines(declines: readonly string[]): string {
  if (declines.length <= 3) return declines.join(", ");
  const more = declines.length - 3;
  return `${declines.slice(0, 3).join(", ")} and ${more} more ${more === 1 ? "folder" : "folders"}`;
}

/** A long value's start and end around "...", at most `max` characters. */
function shortenMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  const kept = max - 3, start = Math.ceil(kept / 2);
  return `${value.slice(0, start)}...${value.slice(value.length - (kept - start))}`;
}

/** Card text within `limit` with every sentence whole: `write` passes each
 * path through `show`, and when the text is over the limit each gets the
 * longest length that fits. Under the limit the text is exactly what `write`
 * says. Display only: the reply and the stored key always use the full key. */
function fitCardText(limit: number, write: (show: (value: string) => string) => string): string {
  const whole = write((value) => value);
  if (whole.length <= limit) return whole;
  const written = (max: number) => write((value) => shortenMiddle(value, max));
  let low = 3;
  let high = whole.length;
  while (low < high) {
    const max = Math.ceil((low + high) / 2);
    if (written(max).length <= limit) low = max;
    else high = max - 1;
  }
  return written(low);
}

/** The generation 2 card: the engine named `key`, and a Trust grants exactly
 * that key, for the folder's settings. Commands stay with the approval level
 * in every answer, so nothing here says they stop asking. */
export function folderTrustQuestionV2(card: FolderTrustCardV2): QuestionSpec {
  const what = describeFolderTrustSources(card.sources) || "its own settings";
  const question = fitCardText(QUESTION_LIMITS.questionChars, (show) => {
    const parts = [`Trust ${show(card.key)}? Trusting it lets ${show(what)} guide the bot here. Commands still follow your approval settings.`];
    if (card.cwd !== card.key) parts.push(`The bot is working in ${show(card.cwd)}, which is part of ${show(card.key)}.`);
    if (card.repository) parts.push("This includes its worktrees, wherever they are.");
    if (card.declines.length) parts.push(`Your earlier "Don't trust" for ${describeFolderTrustDeclines(card.declines.map(show))} may not carry over here: trusting ${show(card.key)} can include it.`);
    return parts.join(" ");
  });
  const stays = card.fullAccess
    ? "The bot keeps working here and leaves the folder's own settings out. Commands keep running as Full access allows."
    : "The bot keeps working here, leaves the folder's own settings out and checks commands with you as your approval settings say.";
  return {
    id: FOLDER_TRUST_QUESTION_ID,
    header: "Folder trust",
    question,
    options: [
      { label: FOLDER_TRUST_OPTIONS.trust, description: fitCardText(QUESTION_LIMITS.descriptionChars, (show) => `Trust ${show(card.key)} and remember it`) },
      { label: FOLDER_TRUST_OPTIONS.reject, description: fitCardText(QUESTION_LIMITS.descriptionChars, (show) => `${stays} ${folderTrustForgetLine(show(card.key))}`) },
    ],
    multiSelect: false,
    allowOther: false,
  };
}

/** The decision a card's answers carry, or null when nothing was decided
 * (no answer, an unknown label). Never guesses: an unknown label is no
 * decision, not a grant. */
export function folderTrustDecision(answers: readonly QuestionAnswer[] | undefined | null): FolderTrustDecision | null {
  const answer = answers?.find((a) => a.id === FOLDER_TRUST_QUESTION_ID) ?? answers?.[0];
  const pick = answer?.selected?.[0];
  if (pick === FOLDER_TRUST_OPTIONS.trust) return "trust";
  if (pick === FOLDER_TRUST_OPTIONS.reject) return "reject";
  return null;
}

// The chip an untrusted turn leaves in the conversation. Like the "stopped:"
// convention (shared/host-stop.ts): one activity message whose tool name
// carries this prefix, so the transcripts show it as a neutral notice —
// visible in a 1:1 thread with Settings → Tool calls off, never an error.
export const FOLDER_TRUST_WITHHELD_PREFIX = "untrusted folder:";

/** The activity tool name for a turn that ran with its folder's sources held
 * back. `sources` are the names that were withheld. */
export function folderTrustWithheldName(sources: readonly string[]): string {
  const what = describeFolderTrustSources(sources);
  return `${FOLDER_TRUST_WITHHELD_PREFIX} ${what || "project files"}`;
}

// Generation 2's withheld chip after a recorded "no" also carries the stored
// key that said it, so the chip can name the way back (T2). Sources come first:
// they are names Murage or the engine chose, the key is any path.
const FOLDER_TRUST_FORGET_MARK = " :: forget ";

/** The withheld chip for a stored "no", naming that record's key (never its `folder`). */
export function folderTrustDeclinedName(sources: readonly string[], key: string): string {
  const what = describeFolderTrustSources(sources);
  return `${FOLDER_TRUST_WITHHELD_PREFIX} ${what || "the folder's own settings"}${FOLDER_TRUST_FORGET_MARK}${key}`;
}

/** The withheld sources named by a chip, or undefined for any other activity
 * name (a tool run, a comm chip, an "error:" or "stopped:" chip). */
export function folderTrustWithheld(name: string | undefined | null): string | undefined {
  if (typeof name !== "string" || !name.startsWith(FOLDER_TRUST_WITHHELD_PREFIX)) return undefined;
  const body = name.slice(FOLDER_TRUST_WITHHELD_PREFIX.length);
  const mark = body.indexOf(FOLDER_TRUST_FORGET_MARK);
  const what = (mark < 0 ? body : body.slice(0, mark)).trim();
  return what || undefined;
}

/** The stored key a withheld chip names, when it names one. */
export function folderTrustWithheldKey(name: string | undefined | null): string | undefined {
  if (typeof name !== "string" || !name.startsWith(FOLDER_TRUST_WITHHELD_PREFIX)) return undefined;
  const mark = name.indexOf(FOLDER_TRUST_FORGET_MARK);
  return mark < 0 ? undefined : name.slice(mark + FOLDER_TRUST_FORGET_MARK.length) || undefined;
}

// The chip for a folder trusted through the engine's own request after the
// engine had already started: MCP servers, hooks and plugins reload in
// place, but the engine reads instructions when a conversation starts, so
// they apply in a new conversation: on Fuigo 1.0.37 a loaded session does not
// pick them up.
export const FOLDER_TRUST_LATE_PREFIX = "trusted folder:";

export function folderTrustLateName(sources: readonly string[]): string {
  const what = describeFolderTrustSources(sources);
  return `${FOLDER_TRUST_LATE_PREFIX} ${what || "project files"}`;
}

export function folderTrustLate(name: string | undefined | null): string | undefined {
  if (typeof name !== "string" || !name.startsWith(FOLDER_TRUST_LATE_PREFIX)) return undefined;
  const what = name.slice(FOLDER_TRUST_LATE_PREFIX.length).trim();
  return what || undefined;
}

// The chip after a generation 2 trust reply names the owner's choice, not the
// engine's state: the engine confirms nothing, and its own save can fail.
export const FOLDER_TRUST_CHOSEN_PREFIX = "trust chosen:";

export function folderTrustChosenName(sources: readonly string[]): string {
  const what = describeFolderTrustSources(sources);
  return `${FOLDER_TRUST_CHOSEN_PREFIX} ${what || "the folder's own settings"}`;
}

export function folderTrustChosen(name: string | undefined | null): string | undefined {
  if (typeof name !== "string" || !name.startsWith(FOLDER_TRUST_CHOSEN_PREFIX)) return undefined;
  const what = name.slice(FOLDER_TRUST_CHOSEN_PREFIX.length).trim();
  return what || undefined;
}

// The chip for a decline Murage wrote into this turn's fresh Fuigo home for
// exactly this folder (S5a, U2). It names the record and the seed and claims
// nothing about what Fuigo decided: its trust switch can be off, and on a
// seeded home the engine may never ask.
export const FOLDER_TRUST_PASSED_PREFIX = "folder answer passed:";

/** U2's sentence, byte for byte. */
export function folderTrustPassedLine(key: string): string {
  return `You chose not to trust ${key}, and Murage passed that answer to Fuigo for this folder. To change it, forget ${key} in this conversation's folder settings.`;
}

export function folderTrustPassedName(key: string): string {
  return `${FOLDER_TRUST_PASSED_PREFIX} ${key}`;
}

/** The stored key a passed chip names; the key is any path, so it is kept verbatim. */
export function folderTrustPassed(name: string | undefined | null): string | undefined {
  if (typeof name !== "string" || !name.startsWith(`${FOLDER_TRUST_PASSED_PREFIX} `)) return undefined;
  return name.slice(FOLDER_TRUST_PASSED_PREFIX.length + 1) || undefined;
}

// The chip for a stored no in Fuigo's own store (/untrust, a CLI no) on the
// owner's No limits turn in a folder he picked. Fuigo does not ask, so no rule
// runs and nothing else tells him why the folder's instructions are missing.
export const FOLDER_TRUST_STORED_NO_NAME = "folder stored no:";

/** The stored no sentence, byte for byte (MurageMain 11-01). */
export const FOLDER_TRUST_STORED_NO_LINE = "This folder's instructions were left out because you said no to trusting it.";

export interface FolderTrustNotice {
  kind: "withheld" | "late" | "chosen" | "passed" | "storedNo";
  sources: string;
  /** the stored key: a withheld notice's when a recorded "no" said it, a passed notice's always */
  key?: string;
}

/** Any folder-trust notice, for the transcripts: what happened and to which
 * sources. Undefined for any other activity name. */
export function folderTrustNotice(name: string | undefined | null): FolderTrustNotice | undefined {
  const withheld = folderTrustWithheld(name);
  if (withheld) {
    const key = folderTrustWithheldKey(name);
    return { kind: "withheld", sources: withheld, ...(key ? { key } : {}) };
  }
  const late = folderTrustLate(name);
  if (late) return { kind: "late", sources: late };
  const chosen = folderTrustChosen(name);
  if (chosen) return { kind: "chosen", sources: chosen };
  const passed = folderTrustPassed(name);
  if (passed) return { kind: "passed", sources: "", key: passed };
  if (name === FOLDER_TRUST_STORED_NO_NAME) return { kind: "storedNo", sources: "" };
  return undefined;
}

/** "Folder not trusted — <sources> left out" / "Folder trusted — <sources>
 * apply in a new conversation in this folder" for surfaces without a renderer locale (the
 * Markdown export, a delegation summary). */
export function folderTrustDisplayName(name: string | undefined | null): string | undefined {
  const notice = folderTrustNotice(name);
  if (!notice) return undefined;
  if (notice.kind === "passed") return folderTrustPassedLine(notice.key!);
  if (notice.kind === "storedNo") return FOLDER_TRUST_STORED_NO_LINE;
  if (notice.kind === "chosen") return `You chose to trust this folder: Fuigo brings in ${notice.sources} as it applies that. Instructions apply in a new conversation in this folder`;
  if (notice.kind === "late") return `Folder trusted: ${notice.sources} apply in a new conversation in this folder`;
  const left = `Folder not trusted: ${notice.sources} left out`;
  return notice.key ? `${left}. ${folderTrustForgetLine(notice.key)}` : left;
}
