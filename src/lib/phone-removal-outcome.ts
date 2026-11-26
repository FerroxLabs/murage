// A7 (settings v10): the six things a phone removal can be, from the recorded status. One sentence key each, and whether "Check again" is offered.
// "Check again" reads the recorded removal; it never repeats the removal.
import type { CompanionRemovalStatus } from "@/components/PhoneSetupFlow";

export type PhoneRemovalOutcome = "finishing" | "removed" | "removed-no-notifications" | "waiting" | "gave-up" | "uncertain" | "not-recorded";

export function phoneRemovalOutcome(status: CompanionRemovalStatus | null | undefined): PhoneRemovalOutcome {
  if (!status) return "not-recorded";
  // A lost reply outranks everything: the page never says Removed on a guess.
  if (status.uncertain) return "uncertain";
  if (status.state === "removed") return status.notifications === "nothing" ? "removed-no-notifications" : "removed";
  if (status.state === "abandoned") return "gave-up";
  if (status.state === "pending") return "waiting";
  return "not-recorded";
}

const OUTCOME_KEYS = {
  finishing: "phone.removal.outcome.finishing",
  removed: "phone.removal.outcome.removed",
  "removed-no-notifications": "phone.removal.outcome.removed-no-notifications",
  waiting: "phone.removal.outcome.waiting",
  "gave-up": "phone.removal.outcome.gave-up",
  uncertain: "phone.removal.outcome.uncertain",
  "not-recorded": "phone.removal.outcome.not-recorded",
} as const;
export const outcomeKey = (outcome: PhoneRemovalOutcome) => OUTCOME_KEYS[outcome];
/** Check again is offered while the answer can still change. */
export const outcomeCanCheckAgain = (outcome: PhoneRemovalOutcome): boolean => outcome === "waiting" || outcome === "finishing" || outcome === "uncertain" || outcome === "not-recorded";
