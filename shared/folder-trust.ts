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

/** The withheld sources named by a chip, or undefined for any other activity
 * name (a tool run, a comm chip, an "error:" or "stopped:" chip). */
export function folderTrustWithheld(name: string | undefined | null): string | undefined {
  if (typeof name !== "string" || !name.startsWith(FOLDER_TRUST_WITHHELD_PREFIX)) return undefined;
  const what = name.slice(FOLDER_TRUST_WITHHELD_PREFIX.length).trim();
  return what || undefined;
}

// The chip for a folder trusted through the engine's own request after the
// engine had already started: MCP servers, hooks and plugins reload in
// place, but the engine reads instructions and skills when it starts, so
// those apply from the next turn.
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

/** Either folder-trust notice, for the transcripts: what happened and to
 * which sources. Undefined for any other activity name. */
export function folderTrustNotice(name: string | undefined | null): { kind: "withheld" | "late"; sources: string } | undefined {
  const withheld = folderTrustWithheld(name);
  if (withheld) return { kind: "withheld", sources: withheld };
  const late = folderTrustLate(name);
  if (late) return { kind: "late", sources: late };
  return undefined;
}

/** "Folder not trusted — <sources> left out" / "Folder trusted — <sources>
 * apply from the next turn" for surfaces without a renderer locale (the
 * Markdown export, a delegation summary). */
export function folderTrustDisplayName(name: string | undefined | null): string | undefined {
  const notice = folderTrustNotice(name);
  if (!notice) return undefined;
  return notice.kind === "withheld"
    ? `Folder not trusted — ${notice.sources} left out`
    : `Folder trusted — ${notice.sources} apply from the next turn`;
}
