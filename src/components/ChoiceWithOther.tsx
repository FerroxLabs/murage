// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One "Other" for every choice Murage shows (QW Q4, item 24): the question card's rows and the chat widget's
// RadioGroup, Select and named ListView. A row or radio that, once chosen, takes the owner's own words in a text
// field. Confirm waits while Other is chosen and empty, and the words are clipped to one limit.
import type { HTMLAttributes, ReactNode, Ref } from "react";
import { Check } from "lucide-react";

import { cn } from "@/lib/cn";

/** The most characters of the owner's own words one Other keeps (the question card's limit; a widget's `fieldValue` is the same number). */
export const OTHER_MAX_LENGTH = 2000;

/** The owner's words, cut to `max` characters. Typing and pasting both go through this. */
export function clipOther(text: string, max: number = OTHER_MAX_LENGTH): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** Other is chosen but holds no words yet: whatever sends the choice waits. */
export function otherBlocksConfirm(chosen: boolean, text: string): boolean {
  return chosen && text.trim() === "";
}

/** The radio or checkbox glyph: 18px, sitting on the label's first line
 * (`inline` centres it on a one-line row instead). */
export function ChoiceIndicator({ multi, checked, inline = false }: { multi: boolean; checked: boolean; inline?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-[18px] shrink-0 items-center justify-center border transition-colors",
        !inline && "mt-px",
        multi ? "rounded-[5px]" : "rounded-full",
        checked ? "border-accent bg-accent text-white" : "border-hairline bg-raised",
      )}
    >
      {checked && (multi ? <Check size={12} strokeWidth={3} /> : <span className="size-2 rounded-full bg-current" />)}
    </span>
  );
}

export interface OtherFieldProps {
  value: string;
  onChange: (text: string) => void;
  disabled?: boolean;
  maxLength?: number;
  /** A secret answer is hidden as it is typed. */
  secret?: boolean;
  id?: string;
  ariaLabel: string;
  placeholder: string;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
  autoFocus?: boolean;
  invalid?: boolean;
  describedBy?: string;
  dir?: "auto";
  /** Extra data attributes (a widget finds its field by name). */
  data?: Record<`data-${string}`, string>;
}

/** The text field for the owner's own words. */
export function OtherField({
  value, onChange, disabled = false, maxLength = OTHER_MAX_LENGTH, secret = false, id, ariaLabel, placeholder, className, inputRef, autoFocus,
  invalid, describedBy, dir, data,
}: OtherFieldProps) {
  return (
    <input
      ref={inputRef}
      id={id}
      type={secret ? "password" : "text"}
      dir={dir}
      value={value}
      disabled={disabled}
      maxLength={maxLength}
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      placeholder={placeholder}
      onChange={(event) => onChange(clipOther(event.target.value, maxLength))}
      className={className}
      {...data}
    />
  );
}

export interface OtherRowProps {
  /** "inline": one pill with the field on it (the question card). "stacked": the row alone, its field set by the caller below the group. */
  layout: "inline" | "stacked";
  chosen: boolean;
  text: string;
  disabled: boolean;
  multi?: boolean;
  label: string;
  /** The row was pressed (or its label clicked): Other becomes the choice. */
  onChoose: () => void;
  onText: (text: string) => void;
  /** inline: the field's id, its labels and limits. */
  inputId?: string;
  inputLabel?: string;
  placeholder?: string;
  secret?: boolean;
  maxLength?: number;
  /** stacked: the radio mark the caller draws, and the row's own role, keys and look. */
  mark?: ReactNode;
  rowProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined>;
  rowClassName?: string;
}

/** The Other row. Inline, it is the question card's pill exactly; stacked, it is one radio row in a list. */
export function OtherRow(props: OtherRowProps) {
  const { layout, chosen, text, disabled, multi = false, label, onChoose, onText } = props;
  if (layout === "stacked") {
    return (
      <div {...props.rowProps} onClick={() => onChoose()} className={props.rowClassName}>
        {props.mark}
        <span dir="auto" className="min-w-0 text-[14px] leading-5 text-ink">{label}</span>
      </div>
    );
  }
  return (
    <label
      htmlFor={props.inputId}
      onClick={(event) => {
        if (disabled) return;
        onChoose();
        event.currentTarget.querySelector("input")?.focus();
      }}
      className={cn(
        "flex w-full items-center gap-3 rounded-[10px] border px-3 py-2 transition-colors",
        chosen ? "border-accent-border bg-accent/10" : "border-hairline/40 bg-card",
      )}
    >
      <button
        type="button"
        role={multi ? "checkbox" : "radio"}
        aria-label={label}
        aria-checked={chosen}
        tabIndex={-1}
        disabled={disabled}
        className="shrink-0"
      >
        <ChoiceIndicator multi={multi} checked={chosen} inline />
      </button>
      <span className="shrink-0 text-[14px] font-medium text-ink">{label}</span>
      <OtherField dir="auto"
        id={props.inputId}
        value={text}
        onChange={onText}
        disabled={disabled}
        maxLength={props.maxLength}
        secret={props.secret}
        ariaLabel={props.inputLabel ?? label}
        placeholder={props.placeholder ?? ""}
        // the composer's own pill: rounded, raised, a hairline that brightens on focus
        className="min-w-0 flex-1 rounded-full border border-hairline/40 bg-raised px-3.5 py-1.5 text-[14px] text-ink placeholder:text-ink-secondary focus:border-accent-border disabled:opacity-60"
      />
    </label>
  );
}
