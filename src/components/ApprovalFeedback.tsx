// The small shared pieces every approval button uses for its pressed, working
// and "confirm on your phone" states (see src/lib/approval-feedback.ts).
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/** Pressed look, the instant a finger is down. The transition list keeps the
 * desktop hover colour easing alongside the press. No pressed scale under
 * reduced motion. */
export const PRESSED =
  "transition-[transform,filter,background-color,color,border-color] duration-75 active:scale-[0.97] active:brightness-90 motion-reduce:active:scale-100";

/** What a card's buttons need to know about the decision in flight. */
export interface ApprovalHold {
  busy: string | null;
  sent: boolean;
}

/** Whether `choice`'s button is held. A deny-type button (`preempts`) stays
 * live while an Allow is in flight, and is held only once an answer was
 * accepted or while it is itself the one being sent. */
export function isHeld(hold: ApprovalHold, choice: string, preempts = false): boolean {
  if (hold.busy === null) return false;
  return hold.sent || !preempts || hold.busy === choice;
}

/** Props for a decision button: `aria-disabled` instead of `disabled`, so the
 * tapped button keeps focus (the controller ignores taps while held), `aria-busy`
 * on the tapped one, dimming only on the buttons that were not tapped. */
export function approvalButtonProps(hold: ApprovalHold, choice: string, preempts = false) {
  const held = isHeld(hold, choice, preempts);
  const tapped = hold.busy === choice;
  return {
    "aria-disabled": held || undefined,
    "aria-busy": tapped || undefined,
    className: held ? (tapped ? "cursor-progress" : "cursor-not-allowed opacity-50") : undefined,
  } as const;
}

/** `cn` for a decision button's own classes plus the hold props above. */
export function approvalButton(hold: ApprovalHold, choice: string, classes: string, preempts = false) {
  const { className, ...rest } = approvalButtonProps(hold, choice, preempts);
  return { ...rest, className: cn(classes, PRESSED, className) };
}

/** The tapped button's content. While busy the spinner and the short working
 * label are what is seen, and the button's own label stays in the accessible
 * name (screen-reader only), so "Allow once" never turns into just "Sending…". */
export function ApprovalBusyLabel({ busy, children }: { busy: boolean; children?: ReactNode }) {
  if (!busy) return <>{children}</>;
  return (
    <span className="inline-flex items-center justify-center gap-1.5">
      <span className="sr-only">{children}</span>
      <Loader2 size={13} className="animate-spin" aria-hidden="true" />
      <span aria-hidden="true">{t("questions.sending")}</span>
    </span>
  );
}

/** The status line for the phone's device prompt. It is in the page before it
 * has text, so a screen reader announces the text when it arrives, and it takes
 * no room while empty. */
export function ApprovalConfirmLine({ prompting, className }: { prompting: boolean; className?: string }) {
  return (
    <p role="status" className={cn(className ?? "text-[12.5px] text-ink-secondary", "empty:hidden")}>
      {prompting ? t("approval.confirmOnPhone") : null}
    </p>
  );
}
