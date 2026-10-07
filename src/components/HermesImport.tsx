// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// New Bot → Import from Hermes (0.1.61, DESIGN-0161-PROFILES-AND-GATEWAYS
// 2.1). Lists the Hermes profiles on this computer; each one ticked becomes a
// bot on its own engine, "Hermes · <profile>". Nothing is copied: memory,
// skills and SOUL.md stay in the profile. Loaded on first use.
import { ChevronLeft } from "lucide-react";
import { useEffect, useState } from "react";

import { api, useStore, type InstanceInfo } from "@/state/store";

export interface HermesProfileRow {
  name: string;
  label: string;
  description: string;
  model: string | null;
  skillCount: number;
  hasSoul: boolean;
  sticky: boolean;
  importedAs: string | null;
}

export interface HermesImportResult {
  created: Array<{ profile: string; botId: string; name: string }>;
  skipped: Array<{ profile: string; reason: "already-imported" | "not-found" | "invalid" | "limit"; botName?: string }>;
  instances?: InstanceInfo[];
}

/** One plain sentence per profile that was not made into a bot. */
export function hermesSkipSentence(item: HermesImportResult["skipped"][number]): string {
  switch (item.reason) {
    case "already-imported": return `${item.profile} already runs as ${item.botName ?? "a bot"}.`;
    case "not-found": return `Hermes has no profile named ${item.profile} any more.`;
    case "limit": return `${item.profile} was left out: this workspace has as many bots as it can hold.`;
    default: return `${item.profile} is not a name Hermes accepts.`;
  }
}

function detail(profile: HermesProfileRow): string {
  const parts = [profile.model ?? "", profile.skillCount ? `${profile.skillCount} ${profile.skillCount === 1 ? "skill" : "skills"}` : "", profile.hasSoul ? "has SOUL.md" : ""];
  return parts.filter(Boolean).join(" · ");
}

export default function HermesImport({ onBack, onDone }: { onBack(): void; onDone(result: HermesImportResult): void }) {
  const { dispatch } = useStore();
  const [profiles, setProfiles] = useState<HermesProfileRow[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [skipped, setSkipped] = useState<string[]>([]);
  const [finished, setFinished] = useState<HermesImportResult | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = (await api("/api/hermes/profiles")) as { profiles: HermesProfileRow[] };
        setProfiles(response.profiles);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The Hermes profiles couldn't be read.");
        setProfiles([]);
      }
    })();
  }, []);

  const toggle = (name: string) => setChosen((current) => {
    const next = new Set(current);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const result = (await api("/api/hermes/profiles/import", { method: "POST", body: JSON.stringify({ profiles: [...chosen] }) })) as HermesImportResult;
      if (result.instances) dispatch({ type: "instances", instances: result.instances });
      if (result.created[0]) dispatch({ type: "select", id: result.created[0].botId });
      // Anything left out is said before the dialog closes (audit, Kimi 6).
      if (!result.created.length || result.skipped.length) {
        setSkipped(result.skipped.map(hermesSkipSentence));
        setBusy(false);
        if (result.created.length) setFinished(result);
        return;
      }
      onDone(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "These profiles couldn't be imported.");
      setBusy(false);
    }
  };

  return (
    <div>
      <button type="button" onClick={onBack} disabled={busy} className="-ml-1.5 flex items-center gap-1 rounded px-1.5 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink">
        <ChevronLeft size={14} aria-hidden="true" />
        Back
      </button>
      <h3 className="mt-2 text-[16px] font-medium text-ink">Import from Hermes</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">Each profile you tick becomes a bot. Its memory, skills and sign-ins stay in the Hermes profile, and deleting the bot never deletes the profile.</p>
      {profiles === null && <p className="mt-3 text-[12px] text-ink-secondary">Looking…</p>}
      {profiles?.length === 0 && !error && <p className="mt-3 text-[12px] text-ink-secondary">No Hermes profiles were found on this computer.</p>}
      {!!profiles?.length && (
        <ul className="mt-3 space-y-1">
          {profiles.map((profile) => (
            <li key={profile.name}>
              <label className={`flex items-start gap-3 rounded-lg px-2 py-2 ${profile.importedAs ? "opacity-60" : "hover:bg-control"}`}>
                <input type="checkbox" className="mt-1" disabled={!!profile.importedAs || busy} checked={chosen.has(profile.name)} onChange={() => toggle(profile.name)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium text-ink">{profile.label}{profile.sticky && <span className="ml-2 text-[11.5px] font-normal text-ink-secondary">Hermes' current default</span>}</span>
                  {profile.description && <span className="block truncate text-[12px] text-ink-secondary">{profile.description}</span>}
                  <span className="block truncate text-[11.5px] text-ink-secondary">{profile.importedAs ? `Already a bot: ${profile.importedAs}` : detail(profile)}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {skipped.map((line) => <p key={line} className="mt-2 text-[12px] text-ink-secondary">{line}</p>)}
      {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
      {finished ? (
        <>
          <p className="mt-3 text-[12.5px] text-ink">{finished.created.length === 1 ? "1 bot was created." : `${finished.created.length} bots were created.`}</p>
          <button type="button" onClick={() => onDone(finished)} className="mt-4 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white">Done</button>
        </>
      ) : (
        <button type="button" disabled={!chosen.size || busy} onClick={() => void create()} className="mt-4 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white disabled:opacity-50">
          {busy ? "Creating…" : chosen.size > 1 ? `Create ${chosen.size} bots` : "Create"}
        </button>
      )}
    </div>
  );
}
