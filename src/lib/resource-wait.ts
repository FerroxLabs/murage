import { t } from "./i18n";

/** Runtime-only marker the harness puts on a busy task while it waits for
 * another thread to release a shared folder, computer or browser profile, or
 * (a queued routine) for one of the bot's three thread slots. */
export type TaskResourceWait = {
  resource: "working-folder" | "computer" | "browser" | "shared" | "thread-slot";
  holderTitle?: string;
};

const KINDS = new Set<TaskResourceWait["resource"]>(["working-folder", "computer", "browser", "shared", "thread-slot"]);

/** The presence-row label for a waiting turn, or undefined when the task is
 * not waiting. Unknown kinds from a newer server read as "shared". */
export function resourceWaitLabel(wait: TaskResourceWait | undefined | null): string | undefined {
  if (!wait || typeof wait !== "object") return undefined;
  const kind = KINDS.has(wait.resource) ? wait.resource : "shared";
  const title = typeof wait.holderTitle === "string" ? wait.holderTitle.trim() : "";
  return title
    ? t(`runtimeError.waiting.${kind}.named`, { title })
    : t(`runtimeError.waiting.${kind}.unnamed`);
}
