// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "One more step.": the 6-digit code an owner browser on a Cloud home types before a high-risk change (src/lib/owner-code.ts
// opens it from api()). Always mounted (App.tsx), shows nothing until a flow is running.
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { uxCloud } from "@/lib/cloud-ux-copy";
import { getOwnerCodeSession, ownerCodeActions, subscribeOwnerCode, type OwnerCodeSession } from "@/lib/owner-code";

export const CODE_LENGTH = 6;
export const emptyDigits = (): string[] => Array.from({ length: CODE_LENGTH }, () => "");

/** Typing or pasting into box `index`: digits only; several digits (a paste, or the phone's code suggestion) fill from there. */
export function applyDigits(digits: readonly string[], index: number, text: string): { digits: string[]; focus: number } {
  const typed = text.replace(/\D/g, "");
  const next = [...digits];
  if (typed === "") { next[index] = ""; return { digits: next, focus: index }; }
  // A full code lands in the boxes whatever box it was pasted into.
  const start = typed.length >= CODE_LENGTH ? 0 : index;
  let at = start;
  for (const digit of typed) { if (at >= CODE_LENGTH) break; next[at++] = digit; }
  return { digits: next, focus: Math.min(at, CODE_LENGTH - 1) };
}

/** Backspace: clears this box, or when it is already empty steps back and clears the one before. */
export function afterBackspace(digits: readonly string[], index: number): { digits: string[]; focus: number } {
  const next = [...digits];
  if (next[index] !== "") { next[index] = ""; return { digits: next, focus: index }; }
  const back = Math.max(0, index - 1);
  next[back] = "";
  return { digits: next, focus: back };
}

export interface OwnerCodeDialogViewProps {
  session: OwnerCodeSession;
  digits: readonly string[];
  secondsLeft: number;
  onChange(index: number, text: string): void;
  onKey(index: number, event: ReactKeyboardEvent<HTMLInputElement>): void;
  onConfirm(): void;
  onResend(): void;
  onCancel(): void;
  inputRef?(index: number): (element: HTMLInputElement | null) => void;
  rootRef?: React.Ref<HTMLDivElement>;
  onRootKeyDown?(event: ReactKeyboardEvent<HTMLDivElement>): void;
}

export function OwnerCodeDialogView({ session, digits, secondsLeft, onChange, onKey, onConfirm, onResend, onCancel, inputRef, rootRef, onRootKeyDown }: OwnerCodeDialogViewProps) {
  const sending = session.phase === "sending", checking = session.phase === "checking";
  const complete = digits.every((digit) => /^\d$/.test(digit));
  const body = uxCloud("ux.cloud.ownerCode.body").replace("{email}", session.maskedEmail || "your email").replace("{act}", session.act);
  return (
    <div className="overlay-inset fixed inset-x-0 top-0 z-[60] flex h-[var(--vvh,100dvh)] items-center justify-center bg-black/50 p-4">
      <div ref={rootRef} role="dialog" aria-modal="true" data-box-exempt="code card whose own body scrolls inside the viewport" aria-labelledby="owner-code-title" aria-describedby="owner-code-body" onKeyDown={onRootKeyDown}
        className="max-h-full w-full max-w-sm overflow-y-auto overscroll-contain rounded-xl bg-card p-5 text-[13px] text-ink shadow-2xl">
        <h2 id="owner-code-title" className="text-[15px] font-semibold">{uxCloud("ux.cloud.ownerCode.title")}</h2>
        <p id="owner-code-body" className="mt-2 text-ink-secondary">{sending && session.maskedEmail === "" ? uxCloud("ux.cloud.ownerCode.sending") : body}</p>
        <div role="group" aria-label={uxCloud("ux.cloud.ownerCode.groupLabel")} className="mt-4 flex justify-between gap-2">
          {digits.map((digit, index) => (
            <input key={index} ref={inputRef?.(index)} value={digit} onChange={(event) => onChange(index, event.target.value)} onKeyDown={(event) => onKey(index, event)}
              type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" disabled={(sending && session.maskedEmail === "") || checking}
              aria-label={uxCloud("ux.cloud.ownerCode.digitLabel").replace("{n}", String(index + 1))}
              className="h-12 w-10 min-w-0 rounded-md border border-hairline/50 bg-inset text-center text-[18px] font-semibold text-ink focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50" />
          ))}
        </div>
        <p role="alert" className="mt-2 min-h-[1.25rem] text-danger">{session.error}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" onClick={onConfirm} disabled={!complete || sending || checking} className="rounded-md bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-inset disabled:opacity-50">
            {checking ? uxCloud("ux.cloud.ownerCode.checking") : uxCloud("ux.cloud.ownerCode.confirm")}
          </button>
          <button type="button" onClick={onResend} disabled={secondsLeft > 0 || sending || checking} className="rounded-md px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-inset disabled:opacity-50">{uxCloud("ux.cloud.ownerCode.resend")}</button>
          <button type="button" onClick={onCancel} className="ml-auto rounded-md px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-inset">{uxCloud("ux.cloud.ownerCode.cancel")}</button>
        </div>
        {secondsLeft > 0 ? <p className="mt-2 text-[12px] text-ink-secondary">{uxCloud("ux.cloud.ownerCode.resendWait").replace("{seconds}", String(secondsLeft))}</p> : null}
      </div>
    </div>
  );
}

/** Mounted once for the whole app. Renders nothing unless a code step is running. */
export function OwnerCodeDialog() {
  const session = useSyncExternalStore(subscribeOwnerCode, getOwnerCodeSession, getOwnerCodeSession);
  if (!session) return null;
  return <OwnerCodeDialogOpen session={session} />;
}

function OwnerCodeDialogOpen({ session }: { session: OwnerCodeSession }) {
  const [digits, setDigits] = useState<string[]>(emptyDigits);
  const [now, setNow] = useState(() => Date.now());
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const root = useRef<HTMLDivElement | null>(null);
  const focusBox = (index: number) => { inputs.current[index]?.focus(); inputs.current[index]?.select(); };

  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 500); return () => window.clearInterval(timer); }, []);
  // The boxes are ready (and focused) once the code has been sent; a wrong code clears them for the next try.
  useEffect(() => { if (session.phase === "ready") focusBox(Math.max(0, digits.findIndex((digit) => digit === ""))); }, [session.phase, session.error]);
  useEffect(() => { if (session.error) setDigits(emptyDigits()); }, [session.error]);

  const apply = (next: { digits: string[]; focus: number }) => { setDigits(next.digits); window.requestAnimationFrame(() => focusBox(next.focus)); };
  const confirm = () => { const code = digits.join(""); if (/^\d{6}$/.test(code)) ownerCodeActions.submit(code); };
  const onChange = (index: number, text: string) => {
    // Typing over a filled box arrives as two characters: keep the new one.
    const typed = digits[index] !== "" && text.length === 2 ? text.replace(digits[index]!, "") : text;
    apply(applyDigits(digits, index, typed));
  };
  const onKey = (index: number, event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace") { event.preventDefault(); apply(afterBackspace(digits, index)); }
    else if (event.key === "ArrowLeft" && index > 0) { event.preventDefault(); focusBox(index - 1); }
    else if (event.key === "ArrowRight" && index < CODE_LENGTH - 1) { event.preventDefault(); focusBox(index + 1); }
    else if (event.key === "Enter") { event.preventDefault(); confirm(); }
  };
  // Escape cancels. Tab stays inside the dialog.
  const onRootKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); ownerCodeActions.cancel(); return; }
    if (event.key !== "Tab") return;
    const items = Array.from(root.current?.querySelectorAll<HTMLElement>("input:not([disabled]), button:not([disabled])") ?? []);
    if (items.length === 0) { event.preventDefault(); return; }
    const first = items[0]!, last = items[items.length - 1]!, active = document.activeElement;
    if (event.shiftKey && (active === first || !root.current?.contains(active))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (active === last || !root.current?.contains(active))) { event.preventDefault(); first.focus(); }
  };
  const secondsLeft = Math.max(0, Math.ceil((session.resendAt - now) / 1000));
  return <OwnerCodeDialogView session={session} digits={digits} secondsLeft={secondsLeft} onChange={onChange} onKey={onKey} onConfirm={confirm} onResend={() => ownerCodeActions.resend()} onCancel={() => ownerCodeActions.cancel()}
    inputRef={(index) => (element) => { inputs.current[index] = element; }} rootRef={root} onRootKeyDown={onRootKeyDown} />;
}
