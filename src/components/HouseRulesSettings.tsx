// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings → House rules: the owner's standing guidance every bot follows,
// written once in their own words (Wayland called it the Constitution).
// The text goes first in every bot's instructions while it is on. The
// built-in protections are not part of it and cannot be turned off here;
// the "Always on" note says what they are.
import { useEffect, useMemo, useState } from "react";

import { RichMarkdownEditor } from "./editor/RichMarkdownEditor";
import { richEditable } from "./skills/SkillEditor";
import { api } from "@/state/store";

export interface HouseRules {
  text: string;
  enabled: boolean;
  isDefault: boolean;
  defaultText?: string;
}

/** Above this many words the hint says what length costs. */
export const HOUSE_RULES_LONG_WORDS = 1000;

export function wordCount(text: string): number {
  const words = text.replace(/[#>*_`~|[\]()-]+/g, " ").trim().split(/\s+/);
  return words[0] === "" ? 0 : words.length;
}

export function lengthHint(words: number): { text: string; long: boolean } {
  const count = `${words.toLocaleString("en-US")} ${words === 1 ? "word" : "words"}`;
  if (words > HOUSE_RULES_LONG_WORDS) {
    return { text: `${count}. Every bot reads these on every reply, so this length makes every reply slower and costlier. Shorter works better.`, long: true };
  }
  return { text: `${count}. Every bot reads these on every reply, so shorter is better.`, long: false };
}

/** What the app enforces in code, whatever the house rules say or whether
 *  they are on: the approval guards in server/auto-approve.ts (destructive
 *  commands and key reads always stop for a person in Ask and Auto mode;
 *  the Auto reviewer in server/auto-review.ts refuses money, outside
 *  messages and deletes), the credential rule in every prompt, and the
 *  untrusted-input labels on channel, webhook and web text. Full access
 *  approves before those guards, so the note says so. */
export const ALWAYS_ON_RULES = [
  "In Ask and Auto mode, bots stop and ask you before they delete things, read your keys and passwords, move money or message people for you. They never ask you to paste a key into chat.",
  "A message from a channel, a webhook or a web page can't approve anything or give a bot more access. Full access approves on its own, so give it only to bots you trust with that.",
] as const;

const BUTTON = "min-h-9 rounded-lg px-3 py-1.5 text-[12.5px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50";

function Switch({ on, disabled, label, onChange }: { on: boolean; disabled?: boolean; label: string; onChange(next: boolean): void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-hairline/50 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50 ${on ? "bg-accent" : "bg-control"}`}
    >
      <span aria-hidden="true" className={`inline-block h-4.5 w-4.5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-[22px]" : "translate-x-[3px]"}`} />
    </button>
  );
}

export function HouseRulesSettings() {
  const [loaded, setLoaded] = useState<HouseRules | null>(null);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  // Bumped when the text is replaced from outside (load, reset), so an
  // editor that fell back to plain text re-decides for the new text.
  const [version, setVersion] = useState(0);

  const take = (rules: HouseRules) => {
    setLoaded(rules);
    setDraft(rules.text);
    setSaved(rules.text);
    setVersion((current) => current + 1);
  };

  useEffect(() => {
    let live = true;
    (api("/api/house-rules") as Promise<HouseRules>)
      .then((rules) => { if (live) take(rules); })
      .catch((cause: unknown) => { if (live) setLoadError(cause instanceof Error && cause.message ? cause.message : "House rules couldn't be loaded."); });
    return () => { live = false; };
  }, []);

  const rich = useMemo(() => richEditable(saved), [saved, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const words = wordCount(draft);
  const hint = lengthHint(words);
  const dirty = draft !== saved;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const save = () => run(async () => {
    const rules = (await api("/api/house-rules", { method: "PUT", body: JSON.stringify({ text: draft }) })) as HouseRules;
    setLoaded(rules);
    setSaved(draft);
    setNotice("Saved. Bots use the new rules from their next reply.");
  });

  const toggle = (enabled: boolean) => run(async () => {
    const rules = (await api("/api/house-rules", { method: "PUT", body: JSON.stringify({ enabled }) })) as HouseRules;
    setLoaded(rules);
    setNotice(enabled ? "House rules are on." : "House rules are off. Bots still keep the built-in protections.");
  });

  const reset = () => run(async () => {
    const rules = (await api("/api/house-rules/reset", { method: "POST", body: "{}" })) as HouseRules;
    take(rules);
    setConfirmReset(false);
    setNotice("The default house rules are back.");
  });

  return (
    <section aria-labelledby="house-rules-heading" className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 id="house-rules-heading" className="text-[15px] font-medium text-ink">House rules</h3>
          <p className="mt-1 text-[12.5px] text-ink-secondary">Every bot follows these. Write them once, in your own words.</p>
        </div>
        {loaded && (
          <label className="flex shrink-0 items-center gap-2 text-[12.5px] text-ink">
            <span>{loaded.enabled ? "On" : "Off"}</span>
            <Switch on={loaded.enabled} disabled={busy} label="Use house rules" onChange={(next) => void toggle(next)} />
          </label>
        )}
      </div>

      {loadError && <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{loadError}</div>}
      {!loaded && !loadError && <p className="text-[12.5px] text-ink-secondary">Loading…</p>}

      {loaded && (
        <>
          {!loaded.enabled && (
            <p role="note" className="rounded-lg bg-control px-3 py-2 text-[12.5px] text-ink">House rules are off, so bots don't read them. You can still edit them here.</p>
          )}
          <div>
            {rich ? (
              <RichMarkdownEditor key={version} value={draft} onChange={setDraft} ariaLabel="House rules" className="max-h-[520px]" />
            ) : (
              <>
                <p className="mb-1 text-[11.5px] text-ink-secondary">These rules use formatting the editor can't show, so they open as plain text.</p>
                <textarea
                  aria-label="House rules"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  spellCheck={false}
                  className="min-h-72 w-full resize-y rounded-lg border border-hairline/50 bg-inset px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                />
              </>
            )}
            <p data-testid="house-rules-length" className={`mt-1.5 text-[11.5px] ${hint.long ? "text-danger" : "text-ink-secondary"}`}>{hint.text}</p>
          </div>

          {error && <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
          {notice && !error && <p role="status" className="text-[12.5px] text-ink-secondary">{notice}</p>}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy || !dirty} onClick={() => void save()} className={`${BUTTON} bg-accent text-white`}>{busy ? "Saving…" : "Save"}</button>
            {dirty && <button type="button" disabled={busy} onClick={() => { setDraft(saved); setVersion((current) => current + 1); }} className={`${BUTTON} bg-control text-ink`}>Undo changes</button>}
            {!loaded.isDefault && !confirmReset && (
              <button type="button" disabled={busy} onClick={() => setConfirmReset(true)} className={`${BUTTON} ml-auto bg-control text-ink`}>Reset to default</button>
            )}
          </div>

          {confirmReset && (
            <div role="group" aria-label="Reset to default" className="rounded-lg border border-hairline/50 bg-inset px-3 py-3">
              <p className="text-[12.5px] text-ink">Put back the default house rules? Your own wording will be replaced.</p>
              <div className="mt-2 flex gap-2">
                <button type="button" disabled={busy} onClick={() => void reset()} className={`${BUTTON} bg-accent text-white`}>Reset</button>
                <button type="button" disabled={busy} onClick={() => setConfirmReset(false)} className={`${BUTTON} bg-control text-ink`}>Keep mine</button>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-hairline/50 px-3 py-2.5">
            <div className="text-[12px] font-medium text-ink">Always on, even with house rules off</div>
            {ALWAYS_ON_RULES.map((line) => <p key={line} className="mt-0.5 text-[12px] text-ink-secondary">{line}</p>)}
          </div>
        </>
      )}
    </section>
  );
}
