import { localeCode, t } from "./i18n";

/** Runtime-only marker the harness puts on a busy task while it waits for
 * another thread to release a shared folder, computer or browser profile, or
 * (a queued routine) for one of the bot's three thread slots. */
export type TaskResourceWait = {
  resource: "working-folder" | "computer" | "browser" | "shared" | "thread-slot";
  holderTitle?: string;
  /** Place in line, 1 = next (SL-L). Absent from an older server. */
  position?: number;
  /** About how long until this turn starts; absent until the server has measured enough. */
  estimateMs?: number;
};

const KINDS = new Set<TaskResourceWait["resource"]>(["working-folder", "computer", "browser", "shared", "thread-slot"]);

const PLACES = new Set(["one", "two", "few", "many", "other"]);

/** "2nd", in the app language's own ordinal form. */
function place(position: number): string {
  let category = "other";
  try { category = new Intl.PluralRules(localeCode(), { type: "ordinal" }).select(position); } catch { /* unknown tag: "other" */ }
  const key = PLACES.has(category) ? category : "other";
  return t(`runtimeError.waiting.place.${key as "one" | "two" | "few" | "many" | "other"}`, { n: position });
}

/** The presence-row label for a waiting turn, or undefined when the task is
 * not waiting. Unknown kinds from a newer server read as "shared". A known
 * place in line reads "2nd in line for the working folder. Starts by itself
 * when the turns ahead finish.", with "About N min." once measured. */
export function resourceWaitLabel(wait: TaskResourceWait | undefined | null): string | undefined {
  if (!wait || typeof wait !== "object") return undefined;
  const kind = KINDS.has(wait.resource) ? wait.resource : "shared";
  const position = wait.position;
  if (kind !== "thread-slot" && typeof position === "number" && Number.isSafeInteger(position) && position >= 1) {
    const line = t(`runtimeError.waiting.${kind as Exclude<TaskResourceWait["resource"], "thread-slot">}.inLine`, { place: place(position) });
    const estimate = wait.estimateMs;
    if (typeof estimate !== "number" || !Number.isFinite(estimate) || estimate <= 0) return line;
    const minutes = Math.round(estimate / 60_000);
    // Under half a minute rounds to nothing: say nothing rather than "About 1 min".
    return minutes >= 1 ? `${line} ${t("runtimeError.waiting.estimate", { minutes })}` : line;
  }
  const title = typeof wait.holderTitle === "string" ? wait.holderTitle.trim() : "";
  return title
    ? t(`runtimeError.waiting.${kind}.named`, { title })
    : t(`runtimeError.waiting.${kind}.unnamed`);
}
