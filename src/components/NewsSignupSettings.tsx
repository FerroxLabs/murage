// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > About > Get Murage news (1.0.7). The way back to the list for
// anyone who skipped the Chief's ask on the first run, which is asked once
// and never again. Desktop only. The post itself is the local server's job
// (server/news-signup.ts); this card only ever talks to its own server.
import { useEffect, useState } from "react";
import { api, useStore } from "@/state/store";
import { NEWS_COPY } from "@/lib/news-consent";
import { Card } from "./SettingsPrimitives";

export { NEWS_COPY };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** What the button does, out of the component so a test can run it. */
export async function joinNews(
  typed: { email: string; name?: string },
  deps: { api: (path: string, init?: RequestInit) => Promise<any> } = { api },
): Promise<"ok" | "invalid" | "failed"> {
  const email = typed.email.trim().toLowerCase();
  if (!EMAIL.test(email)) return "invalid";
  const name = (typed.name ?? "").trim();
  try {
    const answer = await deps.api("/api/subscribe", { method: "POST", body: JSON.stringify(name ? { email, name, from: "settings" } : { email, from: "settings" }) });
    if (answer?.ok === true) return "ok";
    return answer?.reason === "invalid-email" ? "invalid" : "failed";
  } catch {
    return "failed";
  }
}

export function NewsSignupSettings() {
  const { state } = useStore();
  // undefined while the record is read; then whether the address is on the list.
  const [onList, setOnList] = useState<boolean | undefined>(undefined);
  const [email, setEmail] = useState(state.config?.profile?.email ?? "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  // The profile can arrive after the card mounts; prefill only an empty box.
  const profileEmail = state.config?.profile?.email ?? "";
  useEffect(() => { if (profileEmail) setEmail((typed) => typed || profileEmail); }, [profileEmail]);

  useEffect(() => {
    let live = true;
    api("/api/news")
      .then((answer: { onList?: unknown }) => { if (live) setOnList(answer?.onList === true); })
      // No answer (a Cloud home has no news signup): the card stays hidden.
      .catch(() => {});
    return () => { live = false; };
  }, []);

  const join = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    const outcome = await joinNews({ email, name: state.config?.profile?.name });
    setBusy(false);
    if (outcome === "ok") {
      setOnList(true);
      setNote(NEWS_COPY.justAdded);
    } else {
      setError(outcome === "invalid" ? NEWS_COPY.invalid : NEWS_COPY.failure);
    }
  };

  if (onList === undefined) return null;
  return (
    <Card title={NEWS_COPY.title} subtitle={NEWS_COPY.subtitle}>
      {onList ? (
        <p role="status" className="text-[13px] text-ink-secondary">{note || NEWS_COPY.onList}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="email"
            inputMode="email"
            aria-label={NEWS_COPY.emailLabel}
            placeholder="you@example.com"
            value={email}
            disabled={busy}
            onChange={(event) => { setEmail(event.target.value); setError(""); }}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void join(); } }}
            className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
          />
          <button
            type="button"
            disabled={busy || !email.trim()}
            onClick={() => void join()}
            className="min-h-11 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
          >
            {busy ? NEWS_COPY.working : NEWS_COPY.submit}
          </button>
        </div>
      )}
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card>
  );
}
