// The "what, exactly" body of an approval, shared by the chat card and the
// pending-approval bar. The headline says the main thing in plain words; every
// other argument stays visible as a key: value line (long values expand in
// place), a shell command is shown whole in monospace, and "Show details"
// reveals the original text exactly as the engine sent it.
import { useState } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { approvalDetail, formatsToolInput, type ApprovalLine } from "@/lib/approval-detail";
import { plainApproval, usePlainApprovalReady } from "@/lib/plain-approval";

function Line({ line }: { line: ApprovalLine }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("break-words", line.mono && "font-mono text-[12px]")}>
      {open ? line.full : line.text}
      {line.full !== undefined && line.hidden !== undefined && !open && (
        <>
          {" "}
          <button type="button" className="text-accent underline" onClick={() => setOpen(true)}>
            {t("approval.moreChars", { n: String(line.hidden) })}
          </button>
        </>
      )}
    </div>
  );
}

export function ApprovalDetailBody({ tool, detail, label, className, preClassName }: {
  tool: string | undefined;
  detail: string;
  label: string;
  className?: string;
  /** the existing monospace block styling, used when the text is shown as-is */
  preClassName: string;
}) {
  // Routine, skill, peer-bot and browser-extension cards pass no engine tool:
  // their text is shown exactly as written.
  // An engine's request is said in plain words: the facts an owner decides on
  // as short lines, and the request exactly as the engine sent it (raw JSON,
  // a shell line) folded under "Show details".
  // Until the plain words load (after the first paint) the request shows as
  // it did before them: every argument visible.
  usePlainApprovalReady();
  const plain = tool ? plainApproval(tool, detail) : undefined;
  if (plain) {
    return (
      <div className={cn("mt-2", className)}>
        {plain.lines.length > 0 && (
          <div tabIndex={0} aria-label={label} data-approval-plain className="space-y-0.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">
            {plain.lines.map((text, i) => <div key={i} className="break-words">{text}</div>)}
          </div>
        )}
        <details className="mt-1 text-[12px] text-ink-secondary">
          <summary className="cursor-pointer select-none">{t("approval.showDetails")}</summary>
          <pre aria-label={plain.lines.length ? undefined : label} className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset px-2 py-1 font-mono text-[11.5px] text-ink">{detail}</pre>
        </details>
      </div>
    );
  }
  const d = formatsToolInput(tool) ? approvalDetail(tool!, detail) : undefined;
  if (!d || !d.primary || d.primary === detail) {
    return <pre tabIndex={0} aria-label={label} className={preClassName}>{detail}</pre>;
  }
  return (
    <div className={cn("mt-2", className)}>
      <div tabIndex={0} aria-label={label} className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">
        <div className={cn("break-words", d.mono && "rounded-lg bg-inset px-2 py-1 font-mono text-[12.5px]")}>{d.primary}</div>
        {d.secondary !== undefined && <div className="mt-1 text-ink-secondary">{d.secondary}</div>}
        {d.extra.length > 0 && (
          <div className="mt-1 space-y-0.5 text-[12.5px] text-ink-secondary">
            {d.extra.map((l, i) => <Line key={i} line={l} />)}
          </div>
        )}
      </div>
      <details className="mt-1 text-[12px] text-ink-secondary">
        <summary className="cursor-pointer select-none">{t("approval.showDetails")}</summary>
        <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-inset px-2 py-1 font-mono text-[11.5px] text-ink">{detail}</pre>
      </details>
    </div>
  );
}
