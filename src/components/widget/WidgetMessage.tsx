// Copyright OpenMausBot contributors
// SPDX-License-Identifier: Apache-2.0
//
// Ported from OpenMausBot src/components/widget/WidgetMessage.tsx (PRs #2820, #3002), adapted by Ferrox Labs for Murage 1.0.4:
// every press settles the widget (one owner send per widget) through the store's `respondWidget`, a settled widget folds to
// a tick, its label and Details, and "Change answer" reopens it as a new widget (`reopenWidget`).
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, CircleAlert } from "lucide-react";
import { useStore, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  widgetActions, widgetFields, widgetInitialValues, widgetString, type WidgetNode, type WidgetOther, type WidgetPayload, type WidgetSettled, type WidgetValues,
} from "../../../shared/widget";
import { WidgetBody } from "./WidgetBody";
import { WIDGET_COMPACT_BELOW, WidgetButton, WidgetFormProvider, WidgetGlyph, type WidgetForm } from "./WidgetControls";
import { kids } from "./widget-style";
import { editChooseOther, editOther, editValue, preparePress } from "./widget-form";

const WIDTH: Record<string, string> = { sm: "max-w-[360px]", md: "max-w-[440px]", lg: "max-w-[600px]", full: "max-w-[600px]" };
const SURFACE = "w-full overflow-hidden rounded-2xl border border-hairline/30 bg-card transition-opacity";
const QUIET = "rounded-md px-1.5 py-0.5 text-[12.5px] text-ink-secondary underline decoration-ink-secondary/40 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50";

function labelledFields(node: WidgetNode, into = new Set<string>()): Set<string> {
  if (node.type === "Label" && typeof node.fieldName === "string") into.add(node.fieldName);
  for (const child of kids(node)) labelledFields(child, into);
  return into;
}

export interface WidgetRespond {
  ref: string;
  rev: number;
  values?: WidgetValues;
  other?: WidgetOther;
  onSuccess: () => void;
  onError: (message: string, code?: string) => void;
}

/** The store-connected widget of a `kind: "widget"` message. */
export function WidgetMessage({ threadId, message }: { threadId: string; message: Message }) {
  const { dispatch } = useStore();
  const payload = message.widget;
  const widgetId = payload?.id ?? "";
  const respond = useCallback((press: WidgetRespond) => {
    dispatch({ type: "respondWidget", threadId, widgetId, ref: press.ref, rev: press.rev, values: press.values, other: press.other, onSuccess: press.onSuccess, onError: press.onError });
  }, [dispatch, threadId, widgetId]);
  const reopen = useCallback((onError: (message: string) => void) => {
    dispatch({ type: "reopenWidget", threadId, widgetId, onError });
  }, [dispatch, threadId, widgetId]);
  return <WidgetMessageView message={message} respond={respond} reopen={reopen} />;
}

/** Not connected to the store, so it renders and tests on its own. */
export function WidgetMessageView({ message, respond, reopen }: { message: Message; respond: (press: WidgetRespond) => void; reopen: (onError: (message: string) => void) => void }) {
  const payload = message.widget;
  if (!payload?.root || typeof payload.root !== "object" || typeof payload.root.type !== "string") {
    return message.text
      ? <div className="chat-text w-fit max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-ink">{message.text}</div>
      : null;
  }
  // update_widget renumbers node ids, so a new revision remounts the card.
  return <WidgetCard key={payload.rev ?? 0} messageId={message.id} payload={payload} respond={respond} reopen={reopen} />;
}

function WidgetCard({ messageId, payload, respond, reopen }: { messageId: string; payload: WidgetPayload; respond: (press: WidgetRespond) => void; reopen: (onError: (message: string) => void) => void }) {
  const root = payload.root;
  /** The answer this card sent and the server has not yet echoed; the stored row, once it has one, decides. */
  const [settledHere, setSettledHere] = useState<WidgetSettled>();
  const settled = payload.settled ?? settledHere;
  const isSettled = settled !== undefined;
  const uid = useId();
  const frame = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  const watch = useCallback((element: HTMLDivElement | null) => {
    frame.current = element;
    if (!element) return;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) setCompact(width < WIDGET_COMPACT_BELOW);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [edits, setEdits] = useState<{ values: WidgetValues; other: WidgetOther }>({ values: {}, other: {} });
  const [pending, setPending] = useState<string>();
  const [problem, setProblem] = useState<{ text: string; field?: string }>();
  const [details, setDetails] = useState(false);
  const [reopening, setReopening] = useState(false);
  /** Set as the press starts, not on the next render: two presses in one tick are one press. */
  const sendingNow = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (isSettled) setPending(undefined);
  }, [isSettled]);

  const actions = useMemo(() => new Map(widgetActions(root).map((entry) => [entry.ref, entry])), [root]);
  const fields = useMemo(() => new Map(widgetFields(root).map((field) => [field.name, field])), [root]);
  const labelled = useMemo(() => labelledFields(root), [root]);
  const values = useMemo(() => ({ ...widgetInitialValues(root), ...edits.values, ...settled?.values }), [root, edits.values, settled]);
  const other = settled ? settled.other ?? {} : edits.other;

  const press = (ref: string) => {
    const entry = actions.get(ref);
    // a link is a plain link and never reaches here; only a press the server takes is sent
    if (!entry || entry.client || settled || sendingNow.current || pending !== undefined) return;
    const prepared = preparePress(root, entry, ref, values, other);
    if (!prepared.ok) {
      setProblem({ text: prepared.text, field: prepared.field });
      frame.current?.querySelector<HTMLElement>(`[${prepared.where}="${prepared.field}"]`)?.focus();
      return;
    }
    sendingNow.current = true;
    setProblem(undefined);
    setPending(ref);
    respond({
      ref,
      rev: payload.rev ?? 0,
      values: prepared.values,
      other: prepared.other,
      onSuccess: () => {
        sendingNow.current = false;
        if (!mounted.current) return;
        setSettledHere({ ref, label: entry.label, values: prepared.values ?? {}, sendId: `widget-${payload.id}`, ...(prepared.other ? { other: prepared.other } : {}) });
      },
      onError: (message, code) => {
        sendingNow.current = false;
        if (!mounted.current) return;
        setPending(undefined);
        // answered somewhere else: nothing to alarm about, the server's patch folds this card
        if (code === "already_settled") return;
        setProblem({ text: message || t("widget.sendFailed") });
      },
    });
  };

  const errorId = `${uid}-problem`;
  const title = widgetString(root, "title");
  const caption = widgetString(root, "caption");
  const meta = widgetString(root, "meta");
  const status = root.status && typeof root.status === "object" ? root.status as { text?: unknown; icon?: unknown } : {};
  const statusText = typeof status.text === "string" ? status.text : undefined;
  const headed = Boolean(title || caption || meta || statusText);
  const name = title ?? statusText ?? t("widget.aria.card");
  const form: WidgetForm = {
    uid,
    values,
    setValue: (field, value) => {
      setEdits((current) => editValue(current, field, value));
      if (problem?.field === field) setProblem(undefined);
    },
    other,
    chooseOther: (field) => {
      setEdits((current) => editChooseOther(current, field));
      if (problem?.field === field) setProblem(undefined);
    },
    setOther: (field, text) => {
      setEdits((current) => editOther(current, field, text));
      if (problem?.field === field) setProblem(undefined);
    },
    locked: isSettled || pending !== undefined,
    invalid: problem?.field,
    errorId,
    fields,
    actions,
    pendingRef: pending,
    press,
    labelled,
    compact,
    name: title ?? statusText ?? "",
  };
  const confirm = actions.get("confirm");
  const cancel = actions.get("cancel");

  const card = (
    <WidgetFormProvider value={form}>
      <div
        ref={watch}
        role="group"
        aria-label={name}
        aria-busy={pending !== undefined || undefined}
        data-widget={messageId}
        data-widget-state={settled ? "settled" : pending !== undefined ? "sending" : "live"}
        data-widget-compact={compact || undefined}
        className={cn("w-full text-start", WIDTH[widgetString(root, "size") ?? "lg"] ?? WIDTH.lg)}
      >
        <div className={cn(SURFACE, pending !== undefined && "opacity-[0.55]")}>
          {headed && (
            <div className={cn("flex items-start gap-3 px-4 pt-3.5", kids(root).length ? "pb-3" : "pb-3.5")}>
              <div className="min-w-0 flex-1">
                {statusText && (
                  <p className={cn("flex items-center gap-1.5 text-[12.5px] font-semibold leading-[18px] text-accent-text", (title || caption) && "mb-1")}>
                    {typeof status.icon === "string" && <WidgetGlyph name={status.icon} size={14} />}
                    <bdi dir="auto" className="min-w-0 truncate">{statusText}</bdi>
                  </p>
                )}
                {title && <div title={title} className="truncate text-[15px] font-semibold leading-6 text-ink"><bdi dir="auto">{title}</bdi></div>}
                {caption && <div dir="auto" className="mt-0.5 text-[13px] leading-snug text-ink-secondary">{caption}</div>}
              </div>
              {meta && <span dir="auto" className="mt-1 shrink-0 whitespace-nowrap text-[12px] leading-4 tabular-nums text-ink-secondary">{meta}</span>}
            </div>
          )}
          <WidgetBody root={root} headed={headed} />
          {problem && (
            <div id={errorId} role="alert" className="mx-4 flex items-start gap-2 border-t border-hairline/30 pb-3.5 pt-3 text-[13px] leading-[18px] text-danger">
              <CircleAlert aria-hidden="true" size={14} className="mt-0.5 shrink-0" />
              <span dir="auto" className="min-w-0 break-words">{problem.text}</span>
            </div>
          )}
        </div>
        {!settled && (confirm || cancel) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {confirm && <WidgetButton actionRef="confirm" label={confirm.label} look="primary" />}
            {cancel && <WidgetButton actionRef="cancel" label={cancel.label} look="outline" />}
          </div>
        )}
        <span role="status" className="sr-only">{pending !== undefined ? t("widget.sending") : isSettled ? t("widget.sent") : ""}</span>
      </div>
    </WidgetFormProvider>
  );

  if (!settled) return card;
  const detailsId = `${uid}-details`;
  const changeAnswer = () => {
    if (reopening) return;
    setReopening(true);
    setProblem(undefined);
    // the server appends a new widget with these answers filled in; this one stays as the record
    reopen((message) => {
      if (!mounted.current) return;
      setReopening(false);
      setProblem({ text: message || t("widget.sendFailed") });
    });
  };
  return (
    <div role="group" aria-label={name} data-widget-state="settled-line" className={cn("w-full text-start", WIDTH[widgetString(root, "size") ?? "lg"] ?? WIDTH.lg)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] leading-5 text-ink-secondary">
        <Check aria-hidden="true" size={14} className="shrink-0 text-success" />
        <span dir="auto" className="min-w-0 break-words text-ink">{settled.label}</span>
        <button type="button" aria-expanded={details} aria-controls={detailsId} onClick={() => setDetails((open) => !open)} className={QUIET}>
          {details ? t("widget.hideDetails") : t("widget.details")}
        </button>
        <button type="button" onClick={changeAnswer} disabled={reopening} className={QUIET}>{t("widget.changeAnswer")}</button>
      </div>
      {problem && !details && <p role="alert" className="mt-1 text-[12.5px] leading-snug text-danger">{problem.text}</p>}
      {details && <div id={detailsId} className="mt-2">{card}</div>}
    </div>
  );
}
