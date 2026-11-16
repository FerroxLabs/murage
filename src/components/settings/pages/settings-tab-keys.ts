import type { KeyboardEvent } from "react";

/** Automatic tab activation, scoped to this tablist (which may contain nested panels). */
export function settingsTabKeys(event: KeyboardEvent<HTMLButtonElement>) {
  const tabs = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(':scope > [role="tab"]') ?? []);
  const index = tabs.indexOf(event.currentTarget);
  if (index < 0 || tabs.length === 0) return;
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
    : event.key === "ArrowRight" ? (index + 1) % tabs.length
      : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : null;
  if (next === null) return;
  event.preventDefault();
  tabs[next]?.focus();
  tabs[next]?.click();
}
