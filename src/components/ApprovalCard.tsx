// The approval box: what the bot wants to do, and three ways to answer.
//
// Deliberately not the lettered A/B/C list the onboarding card uses — an
// approval is a decision about one concrete action, so it shows the tool
// and the actual command/path in monospace, and the choices carry their
// own behavior instead of being matched by their label text.
import { Check, ShieldCheck, X } from "lucide-react";
import { type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { SkillRequestPreview } from "@/components/SkillRequestPreview";
import { ApprovalDetailBody } from "@/components/ApprovalDetailBody";
import { CollapsibleText } from "@/components/CollapsibleText";
import { knownToolAction } from "@/components/PendingApproval";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { useDecisionFeedback } from "@/lib/approval-feedback";
import { ApprovalBusyLabel, approvalButton } from "@/components/ApprovalFeedback";

/** A browser card whose `onAnswer` does not say when it is done is shown as
 * working this long at most, so a lost answer never leaves dead buttons. */
const ANSWER_FALLBACK_MS = 8_000;

// ---- Murage for Chrome cards (spec 9.3) ----------------------------------
//
// The server (T22/T25) adds `browser` to the card payload. Without it the card
// below renders exactly as it always did. Everything the owner reads first
// (title, classification, purpose, buttons) comes from locale keys filled with
// the trusted bot name and site host. Page-derived text (`pageBlock`, a
// recipient, a form or file name) is only ever React text, behind the
// "From the page:" label and collapsed after four lines. No card offers an
// "always" choice (decision D1).

export type BrowserCardKind =
  | "site" | "siteAsk" | "l2"
  | "send" | "newRecipient" | "submit" | "post" | "delete" | "order" | "download" | "upload" | "dialog" | "leave" | "link";

/** One line the server adds to a card: an intent rule, the checker verdict, or the L2 first step. */
export type BrowserCardLine =
  | { code: "I1" }
  | { code: "I2"; recipient: string }
  | { code: "I3" }
  | { code: "I5"; siteA: string; siteB: string }
  | { code: "matches" }
  | { code: "mismatch" }
  | { code: "firstStep"; action: string };

/** `card.browser`: the payload T22/T25 send. `site` is a host and `bot` a name, both trusted. */
export interface BrowserCardData {
  kind: BrowserCardKind;
  site: string;
  bot: string;
  lines: BrowserCardLine[];
  /** page-derived text: the message, the dialog question. Never trusted. */
  pageBlock?: string;
  /** page-derived names the body sentence needs */
  details?: { recipients?: string; form?: string; thing?: string; file?: string; action?: string };
  /** the server's own verdict that the wait ran out */
  state?: "expired";
}

/** What a button answers with. The server maps these onto its own approval answer. */
export type BrowserChoice = "allow" | "deny" | "never" | "cancel";

interface KindSpec { title: LocaleKey; body: LocaleKey; buttons: Array<[BrowserChoice, LocaleKey]>; footer: "l2" | "l3" | "every"; pageLabel?: boolean }
const KIND_SPEC: Record<BrowserCardKind, KindSpec> = {
  site: { title: "browserExt.site.title", body: "browserExt.site.body", footer: "l2",
    buttons: [["allow", "browserExt.site.allow"], ["deny", "browserExt.site.notNow"], ["never", "browserExt.site.never"]] },
  siteAsk: { title: "browserExt.site.title", body: "browserExt.ask.body", footer: "l2",
    buttons: [["allow", "browserExt.site.allow"], ["deny", "browserExt.site.notNow"]] },
  l2: { title: "browserExt.l2.title", body: "browserExt.l2.body", footer: "l2",
    buttons: [["allow", "browserExt.l2.allow"], ["deny", "browserExt.l2.notNow"]] },
  send: { title: "browserExt.l3.send.title", body: "browserExt.l3.send.body", footer: "l3", pageLabel: true,
    buttons: [["allow", "browserExt.l3.send.confirm"], ["deny", "browserExt.l3.deny"]] },
  newRecipient: { title: "browserExt.l3.newRecipient.title", body: "browserExt.l3.newRecipient.body", footer: "every", pageLabel: true,
    buttons: [["allow", "browserExt.l3.newRecipient.confirm"], ["deny", "browserExt.l3.deny"]] },
  submit: { title: "browserExt.l3.submit.title", body: "browserExt.l3.submit.body", footer: "l3", pageLabel: true,
    buttons: [["allow", "browserExt.l3.submit.confirm"], ["deny", "browserExt.l3.deny"]] },
  post: { title: "browserExt.l3.post.title", body: "browserExt.l3.post.body", footer: "l3", pageLabel: true,
    buttons: [["allow", "browserExt.l3.post.confirm"], ["deny", "browserExt.l3.deny"]] },
  delete: { title: "browserExt.l3.delete.title", body: "browserExt.l3.delete.body", footer: "every", pageLabel: true,
    buttons: [["allow", "browserExt.l3.delete.confirm"], ["deny", "browserExt.l3.deny"]] },
  order: { title: "browserExt.l3.order.title", body: "browserExt.l3.order.body", footer: "l3", pageLabel: true,
    buttons: [["allow", "browserExt.l3.order.confirm"], ["deny", "browserExt.l3.deny"]] },
  download: { title: "browserExt.l3.download.title", body: "browserExt.l3.download.body", footer: "l3",
    buttons: [["allow", "browserExt.l3.download.confirm"], ["deny", "browserExt.l3.deny"]] },
  upload: { title: "browserExt.l3.upload.title", body: "browserExt.l3.upload.body", footer: "l3",
    buttons: [["allow", "browserExt.l3.upload.confirm"], ["deny", "browserExt.l3.deny"]] },
  dialog: { title: "browserExt.l3.dialog.title", body: "browserExt.l3.dialog.body", footer: "l3",
    buttons: [["allow", "browserExt.l3.dialog.ok"], ["cancel", "browserExt.l3.dialog.cancel"], ["deny", "browserExt.l3.deny"]] },
  leave: { title: "browserExt.l3.leave.title", body: "browserExt.l3.leave.body", footer: "l3",
    buttons: [["allow", "browserExt.l3.leave.confirm"], ["deny", "browserExt.l3.leave.cancel"]] },
  link: { title: "browserExt.l3.link.title", body: "browserExt.l3.link.body", footer: "l3",
    buttons: [["allow", "browserExt.l3.link.confirm"], ["deny", "browserExt.l3.deny"]] },
};

/** The `browser` object when a card carries a well-formed one. Anything else is today's generic card. */
export function browserCardData(card: unknown): BrowserCardData | undefined {
  const value = (card as { browser?: Partial<BrowserCardData> } | undefined)?.browser;
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.kind !== "string" || !Object.hasOwn(KIND_SPEC, value.kind)) return undefined;
  if (typeof value.site !== "string" || typeof value.bot !== "string") return undefined;
  return { ...value, lines: Array.isArray(value.lines) ? value.lines : [] } as BrowserCardData;
}

function lineText(line: BrowserCardLine): string | undefined {
  switch (line.code) {
    case "I1": return t("browserExt.intent.i1");
    case "I2": return t("browserExt.intent.i2", { recipient: String(line.recipient ?? "") });
    case "I3": return t("browserExt.intent.i3");
    case "I5": return t("browserExt.intent.i5", { siteA: String(line.siteA ?? ""), siteB: String(line.siteB ?? "") });
    case "matches": return t("browserExt.intent.matches");
    case "mismatch": return t("browserExt.intent.mismatch");
    case "firstStep": return t("browserExt.l2.firstStep", { action: String(line.action ?? "") });
    default: return undefined;
  }
}

function BrowserApprovalBody({ message, data, onAnswer }: { message: Message; data: BrowserCardData; onAnswer?: (choice: BrowserChoice) => void | Promise<unknown> }) {
  // The tapped button works and the others are held until the answer settles.
  const feedback = useDecisionFeedback();
  const answer = (choice: BrowserChoice) =>
    feedback.run(
      choice,
      ({ settle, succeed }) => {
        const result = onAnswer?.(choice);
        // Accepted: hold every button until `card.answered` removes them, so they never flicker back to tappable in between.
        if (result && typeof (result as Promise<unknown>).then === "function") return (result as Promise<unknown>).then(succeed, settle);
        // No promise to wait on: the controller's watchdog (cleared on settle and on unmount) ends the working state.
        return undefined;
      },
      { watchdogMs: ANSWER_FALLBACK_MS, preempt: choice !== "allow" },
    );
  const card = message.card!;
  const spec = KIND_SPEC[data.kind];
  const { bot, site } = data;
  const details = data.details ?? {};
  const settled = card.answered;
  const expired = data.state === "expired" || settled === "unavailable";
  const params = { bot, site, recipients: details.recipients ?? "", form: details.form ?? "", thing: details.thing ?? "",
    file: details.file ?? "", action: details.action ?? "" };
  const title = t(spec.title, params);
  const lines = data.lines.map(lineText).filter((text): text is string => Boolean(text));
  const firstStep = lines.filter((_, i) => data.lines[i].code === "firstStep");
  const flags = lines.filter((_, i) => data.lines[i].code !== "firstStep");
  const choices = settled || expired || !onAnswer ? [] : spec.buttons;
  return (
    <div
      data-browser-card={data.kind}
      className={cn("w-full max-w-[840px] rounded-2xl border bg-card p-4", settled || expired ? "border-hairline/30 opacity-70" : "border-accent/40")}
    >
      <div className="text-[15px] font-semibold text-ink">{title}</div>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{t(spec.body, params)}</p>
      {firstStep.map(text => <p key={text} className="mt-1 text-[13px] text-ink">{text}</p>)}
      {data.pageBlock && (
        <div className="mt-2 rounded-lg bg-inset px-3 py-2">
          {spec.pageLabel && <div className="mb-1 text-[11.5px] font-medium text-ink-secondary">{t("browserExt.l3.send.fromPage")}</div>}
          <CollapsibleText as="pre" ariaLabel={spec.pageLabel ? t("browserExt.l3.send.fromPage") : "Approval details"} text={data.pageBlock} className="font-mono text-[12.5px] leading-relaxed text-ink" />
        </div>
      )}
      {flags.length > 0 && (
        <ul className="mt-2 space-y-1">
          {flags.map(text => <li key={text} className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-1.5 text-[12.5px] text-warning">{text}</li>)}
        </ul>
      )}
      {choices.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {choices.map(([choice, label]) => (
            <button
              key={choice}
              type="button"
              data-choice={choice}
              onClick={() => answer(choice)}
              {...approvalButton(
                feedback,
                choice,
                cn(
                  "inline-flex min-h-11 items-center justify-center rounded-full px-4 text-[13px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
                  choice === "allow" ? "bg-accent text-white" : choice === "never" ? "text-ink-secondary underline" : "border border-hairline text-ink",
                ),
                choice !== "allow",
              )}
            >
              <ApprovalBusyLabel busy={feedback.busy === choice}>{t(label, params)}</ApprovalBusyLabel>
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 text-[12.5px] text-ink-secondary">
        {expired ? t("browserExt.footer.expired")
          : settled === "allow" ? t("browserExt.footer.answeredLater", { bot })
          : settled ? null
          : <>
              <div>{t("browserExt.footer.waiting", { bot })}</div>
              <div>{t(spec.footer === "l2" ? "browserExt.footer.l2" : "browserExt.footer.l3")}</div>
              {spec.footer === "every" && <div>{t("browserExt.footer.everyTime")}</div>}
            </>}
      </div>
    </div>
  );
}

interface ToolLabels {
  [tool: string]: string;
}

const ROUTINE_SETTLED_LABEL = {
  create: "Routine scheduled",
  update: "Routine updated",
  pause: "Routine paused",
  resume: "Routine resumed",
  run_now: "Routine run queued",
  delete: "Routine deleted",
} as const;

const SKILL_SETTLED_LABEL = {
  create: "Skill enabled",
  update: "Skill updated",
} as const;

/** An ACP engine — Fuigo, the one the included Chief of Staff runs on —
 * does not send a tool NAME with `session/request_permission`. It sends the
 * permission KIND, and the driver forwards that kind in place of a tool name
 * (server/drivers/acp/core.ts, `kind === "execute" ? "shell" : …`). These are
 * the ACP kinds, spelled as the sentence they belong to; without them the
 * first approval a new person ever sees read "Business Planner wants to
 * other". The raw name the engine asked about is still in the card body. */
const ACP_KIND_LABEL: ToolLabels = {
  read: "read a file",
  edit: "edit a file",
  delete: "delete a file",
  move: "move a file",
  search: "search",
  fetch: "fetch a web page",
  execute: "run a command",
  shell: "run a command",
  think: "think it through",
  switch_mode: "change its mode",
  other: "use a tool",
};

/** True for a bare ACP permission kind. A kind is not a tool name, so it is
 * never shown in the monospace badge beside the sentence. */
export function isAcpPermissionKind(tool?: string): boolean {
  return Boolean(tool) && Object.hasOwn(ACP_KIND_LABEL, tool!);
}

/** The tool's own name is noise to a human: mcp__muragebox__computer_batch is
 * "computer batch", Bash is "run a command". */
function toolLabel(tool?: string): string {
  if (!tool) return "an action";
  const bare = tool.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
  const nice: ToolLabels = {
    Bash: "run a command",
    Read: "read a file",
    Write: "write a file",
    Edit: "edit a file",
    WebFetch: "fetch a web page",
    WebSearch: "search the web",
    schedule_routine: "schedule a routine",
    manage_routine: "change a routine",
    stage_skill: "enable a learned skill",
    update_skill: "update a learned skill",
  };
  return nice[tool] ?? ACP_KIND_LABEL[tool] ?? bare;
}

export function ApprovalCard({
  bot,
  message,
  onAnswer,
}: {
  /** who is asking, for the "Name wants to …" line */
  bot?: Bot;
  message: Message;
  /** Murage for Chrome cards only: the card's own buttons answer through this. Without it a browser card shows no buttons. */
  onAnswer?: (choice: BrowserChoice) => void | Promise<unknown>;
}) {
  const card = message.card;
  if (!card) return null;
  const browser = browserCardData(card);
  if (browser) return <BrowserApprovalBody message={message} data={browser} onAnswer={onAnswer} />;
  const settled = card.answered;
  const isRoutineRequest = Boolean(card.routineRequest);
  const isSkillRequest = Boolean(card.skillRequest);
  const routineAction = card.routineRequest?.operation.action;
  const skillAction = card.skillRequest?.action;
  const routineSettledLabel = routineAction ? ROUTINE_SETTLED_LABEL[routineAction] : undefined;
  const skillSettledLabel = skillAction ? SKILL_SETTLED_LABEL[skillAction] : undefined;
  // The one-time "use this computer" question (server/host-computer-consent.ts)
  // is not a tool call: it reads as a sentence with a plain explanation.
  const isHostConsent = card.tool === "local_computer_consent";
  const displayTool = isRoutineRequest
    ? routineAction === "create" ? "schedule_routine" : "manage_routine"
    : isSkillRequest
      ? skillAction === "update" ? "update_skill" : "stage_skill"
    : card.tool;

  return (
    <div
      className={cn(
        "w-full max-w-[840px] rounded-2xl border bg-card p-4",
        settled ? "border-hairline/30 opacity-70" : "border-accent/40",
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[15px] font-semibold text-ink">
          {isHostConsent
            ? `${bot ? `@${bot.name}` : "This bot"} wants to use this computer`
            : card.tool === "browser_extension_action" && card.title ? card.title
            : <>{bot ? `${bot.name} wants to ` : "Wants to "}{(displayTool === "other" && knownToolAction("other", card.subtitle)) || toolLabel(displayTool)}</>}
        </div>
        {displayTool && !isHostConsent && displayTool !== "browser_extension_action" && !isAcpPermissionKind(displayTool) && <span className="shrink-0 font-mono text-[11px] text-ink-secondary">{displayTool}</span>}
      </div>

      {/* what, exactly */}
      {isHostConsent ? (
        <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{card.subtitle}</p>
      ) : card.tool === "browser_extension_action" ? (
        // A reviewed browser action can hold a long email body: collapsed with a real toggle, never refused.
        <div className="mt-2 rounded-lg bg-inset px-3 py-2">
          <CollapsibleText as="pre" ariaLabel="Approval details" text={card.subtitle} className="font-mono text-[12.5px] leading-relaxed text-ink" />
        </div>
      ) : (
        <ApprovalDetailBody
          tool={isRoutineRequest || isSkillRequest ? undefined : card.tool}
          detail={card.subtitle}
          label={isRoutineRequest ? "Routine details" : isSkillRequest ? "Skill details" : "Approval details"}
          preClassName="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink"
        />
      )}

      {card.skillRequest && <SkillRequestPreview request={card.skillRequest} />}

      {card.held && !settled && (
        <div className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
          <CollapsibleText text={card.held} />
        </div>
      )}

      {/* The decision lives in the composer (one place to answer, and it
          can't be scrolled past); here we only record what happened. */}
      <div className="mt-3 flex items-center gap-1.5 text-[13px] text-ink-secondary">
        {settled === "allow" ? (
          <>
            <Check size={14} className="text-success" />
            {skillSettledLabel ?? routineSettledLabel ?? (isRoutineRequest ? "Routine confirmed" : isSkillRequest ? "Skill confirmed" : "Allowed")}
          </>
        ) : settled === "unavailable" ? (
          // closed by nobody: the turn stopped, the request was revoked, or
          // the wait ran out — never the owner's own decision
          <>
            <X size={14} /> Not answered
          </>
        ) : settled ? (
          <>
            <X size={14} /> {isRoutineRequest || isSkillRequest ? "Cancelled" : isHostConsent ? "Not allowed" : "Denied"}
          </>
        ) : (
          <>
            <ShieldCheck size={14} className="text-accent" />
            {isRoutineRequest || isSkillRequest ? "Waiting for your confirmation below" : "Waiting for your answer below"}
          </>
        )}
      </div>
    </div>
  );
}
