// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings → About me: a short profile the owner writes once so every bot
// knows who it works for (server/about-me.ts). Bots read it only on turns
// whose audience is the owner; people who message a bot on a messaging app
// never get it. Before the first save the editor opens with a draft made
// only of what Murage already knows (the profile name, the time zone).
import { useEffect, useMemo, useState } from "react";

import { RichMarkdownEditor } from "./editor/RichMarkdownEditor";
import { richEditable } from "./skills/SkillEditor";
import { api } from "@/state/store";

export interface AboutMe {
  text: string;
  saved: boolean;
  chars: number;
  maxChars: number;
  suggestion: string;
}

export const ABOUT_ME_COPY = {
  intro: "Tell your bots about yourself once: who you are, what you do, how you like to work, and anything every bot should know.",
  audience: "Bots read this only when they are working for you. People who message your bots on Telegram, Slack or Discord never see it. You can leave it out for one bot in that bot's settings.",
  started: "We started this with what Murage already knows. Change anything you like, then save.",
  saved: "Saved. Bots use it from their next reply.",
  cleared: "Cleared. Bots no longer get an About me.",
} as const;

/** Characters as a person counts them, matching the server's cap. */
export const countChars = (text: string): number => [...text].length;

export function charCounter(chars: number, max: number): { text: string; over: boolean } {
  const n = (value: number) => value.toLocaleString("en-US");
  const base = `${n(chars)} of ${n(max)} characters`;
  return chars > max ? { text: `${base}. Shorten it by ${n(chars - max)} to save.`, over: true } : { text: base, over: false };
}

const BUTTON = "min-h-9 rounded-lg px-3 py-1.5 text-[12.5px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50";

export function AboutMeSettings() {
  const [loaded, setLoaded] = useState<AboutMe | null>(null);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Bumped when the text is replaced from outside (load, undo), so an
  // editor that fell back to plain text re-decides for the new text.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    (api("/api/about-me") as Promise<AboutMe>)
      .then((about) => {
        if (!live) return;
        setLoaded(about);
        setSaved(about.text);
        // Nothing saved yet: open on the draft, unsaved until they say so.
        setDraft(about.saved ? about.text : about.suggestion);
        setVersion((current) => current + 1);
      })
      .catch((cause: unknown) => { if (live) setLoadError(cause instanceof Error && cause.message ? cause.message : "About me couldn't be loaded."); });
    return () => { live = false; };
  }, []);

  const rich = useMemo(() => richEditable(draft), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const max = loaded?.maxChars ?? 4000;
  const counter = charCounter(countChars(draft), max);
  const dirty = draft !== saved;

  const save = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const about = (await api("/api/about-me", { method: "PUT", body: JSON.stringify({ text: draft }) })) as AboutMe;
      setLoaded(about);
      setSaved(about.text);
      if (about.text !== draft) { setDraft(about.text); setVersion((current) => current + 1); }
      setNotice(about.text ? ABOUT_ME_COPY.saved : ABOUT_ME_COPY.cleared);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "That didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="about-me-heading" className="space-y-4">
      <div>
        <h3 id="about-me-heading" className="text-[15px] font-medium text-ink">About me</h3>
        <p className="mt-1 text-[12.5px] text-ink-secondary">{ABOUT_ME_COPY.intro}</p>
      </div>
      <p role="note" className="rounded-lg bg-control px-3 py-2 text-[12.5px] text-ink">{ABOUT_ME_COPY.audience}</p>

      {loadError && <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{loadError}</div>}
      {!loaded && !loadError && <p className="text-[12.5px] text-ink-secondary">Loading…</p>}

      {loaded && (
        <>
          {!loaded.saved && loaded.suggestion && draft === loaded.suggestion && (
            <p className="text-[12.5px] text-ink-secondary">{ABOUT_ME_COPY.started}</p>
          )}
          <div>
            {rich ? (
              <RichMarkdownEditor key={version} value={draft} onChange={setDraft} ariaLabel="About me" className="max-h-[420px] min-h-40" />
            ) : (
              <textarea
                aria-label="About me"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="min-h-48 w-full resize-y rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[12.5px] leading-relaxed text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              />
            )}
            <p data-testid="about-me-length" aria-live="polite" className={`mt-1.5 text-[11.5px] ${counter.over ? "text-danger" : "text-ink-secondary"}`}>{counter.text}</p>
          </div>

          {error && <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
          {notice && !error && <p role="status" className="text-[12.5px] text-ink-secondary">{notice}</p>}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy || !dirty || counter.over} onClick={() => void save()} className={`${BUTTON} bg-accent text-white`}>{busy ? "Saving…" : "Save"}</button>
            {dirty && loaded.saved && (
              <button type="button" disabled={busy} onClick={() => { setDraft(saved); setVersion((current) => current + 1); }} className={`${BUTTON} bg-control text-ink`}>Undo changes</button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
