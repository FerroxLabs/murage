// THE CONFIRMED LABEL FORM, ONE FOR EVERY SIGN-IN.
//
// Every connected app sign-in starts from a label the person confirmed
// (#758). This is the one form that asks for it: the connected apps dialog
// (PluginsPanel) before a new account and before a Reconnect, the first-run
// cards, and the chat card a bot posts. The label can arrive filled in, so a
// first run stays one press: confirm it, or change it, and the sign-in opens.
// Nothing here starts a sign-in on its own; only a confirmed, non-empty label
// reaches onConfirm, typed as a ConfirmedConnectLabel so nothing else fits
// where a sign-in asks for one.
import { useState } from "react";

import {
  CONNECT_APP_LABEL_MAX,
  CONNECT_APP_LABEL_TAKEN,
  CONNECT_APP_NEEDS_LABEL,
  confirmedConnectLabel,
  type ConfirmedConnectLabel,
} from "@/lib/connect-app";
import { t } from "@/lib/i18n";

export { confirmedConnectLabel };

export interface ConnectLabelFormProps {
  /** The app's name, as the row shows it. */
  service: string;
  /** The label filled in when the form opens. */
  initial: string;
  busy: boolean;
  /** Called only with a confirmed, trimmed, non-empty label. */
  onConfirm: (alias: ConfirmedConnectLabel) => void;
  onCancel: () => void;
  /** For the form's ids; one form per row. */
  id: string;
  /** The line above the field. Defaults to the first-account hint. */
  hint?: string;
  /** The field's accessible name. Defaults to the first-account wording. */
  label?: string;
  /** A label the server refused as already in use: while the field still
   *  holds it, the form says so on its own line. */
  takenLabel?: string;
  /** Where an empty label is reported. Without one the form says it inline. */
  onInvalid?: (message: string) => void;
  /** The connected apps dialog's smaller type and its indent. */
  compact?: boolean;
}

export interface ConnectLabelFormViewProps extends ConnectLabelFormProps {
  draft: string;
  setDraft: (value: string) => void;
  problem: string;
  setProblem: (value: string) => void;
}

/** The line the form shows under the field, or "". */
export function connectLabelProblem(input: { problem: string; draft: string; takenLabel?: string }): string {
  if (input.problem) return input.problem;
  const taken = input.takenLabel?.trim().toLowerCase();
  return taken && input.draft.trim().toLowerCase() === taken ? CONNECT_APP_LABEL_TAKEN : "";
}

/** The form itself, with its state handed in: what ConnectLabelForm draws. */
export function ConnectLabelFormView(props: ConnectLabelFormViewProps) {
  const { service, busy, onConfirm, onCancel, id, draft, setDraft, problem, setProblem, onInvalid, compact } = props;
  const hintId = `connect-label-hint-${id}`;
  const line = connectLabelProblem({ problem, draft, takenLabel: props.takenLabel });
  const text = compact ? "text-[12px]" : "text-[13px]";
  return (
    <form
      className={compact ? "ml-14 mt-3" : "mt-2 w-full"}
      data-connect-label-form={id}
      onSubmit={(event) => {
        event.preventDefault();
        const alias = confirmedConnectLabel(draft);
        if (!alias) {
          if (onInvalid) onInvalid(CONNECT_APP_NEEDS_LABEL);
          else setProblem(CONNECT_APP_NEEDS_LABEL);
          return;
        }
        setProblem("");
        onConfirm(alias);
      }}
    >
      <p id={hintId} className={`mb-2 ${compact ? "text-[11.5px]" : "text-[12.5px]"} leading-snug text-ink-secondary`}>
        {props.hint ?? t("connectedApps.alias.firstHint")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          autoFocus
          value={draft}
          maxLength={CONNECT_APP_LABEL_MAX}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Cancel only the label form; a dialog around it stays open.
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }}
          placeholder="Account label (work, personal…)"
          aria-label={props.label ?? t("connectedApps.alias.firstLabel", { service })}
          aria-describedby={hintId}
          aria-invalid={line ? true : undefined}
          className={`min-w-0 flex-1 basis-40 rounded-lg bg-raised px-3 py-2 ${text} text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent`}
        />
        <button
          type="submit"
          disabled={busy || !draft.trim()}
          className={`rounded-lg bg-accent px-3 py-2 ${text} font-medium text-white disabled:opacity-40`}
        >
          Continue
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className={`rounded-lg px-3 py-2 ${text} text-ink-secondary transition-colors hover:bg-raised hover:text-ink disabled:opacity-40`}
        >
          {t("connectedApps.alias.cancel")}
        </button>
      </div>
      {line && <p role="alert" className="mt-1 text-[12.5px] text-danger">{line}</p>}
    </form>
  );
}

export function ConnectLabelForm(props: ConnectLabelFormProps) {
  const [draft, setDraft] = useState(props.initial);
  const [problem, setProblem] = useState("");
  return <ConnectLabelFormView {...props} draft={draft} setDraft={setDraft} problem={problem} setProblem={setProblem} />;
}
