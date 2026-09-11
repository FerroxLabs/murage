import { useEffect, useState } from "react";
import { ShieldCheck, ShieldOff } from "lucide-react";

import { api } from "@/state/store";
import { t } from "@/lib/i18n";

export interface FolderTrustStatus {
  gated: boolean;
  sources: string[];
  record: { decision: "trust" | "reject"; decidedAt: number; source: "picker" | "card" | "upgrade" } | null;
  /** The user's own Fuigo install trusts this workspace (its
   * trusted_folders.toml): the engine applies the folder's files whatever
   * Murage remembers, so the note says so instead of a Murage decision. */
  upstreamTrusted?: boolean;
  /** FUIGOTRUST4 (2): which store speaks for the folder on this bot's turn —
   * the user's own install ("own"), a provider-routed turn's temporary home
   * ("temporary"), or none ("none": an engine that does not gate folders, or
   * a turn that would be refused). Absent from an older server. */
  upstreamStore?: "own" | "temporary" | "none";
  /** Whether the engine a turn would run on gates folders at all. */
  engineGates?: boolean;
  /** The instance a turn would run on, for grouping a room's members. */
  instanceId?: string | null;
  /** The turn's own refusal, when a turn on this bot would not start (a
   * disabled connection, an unavailable model). */
  refused?: string | null;
}

/** One bot the note describes: a bot's picker names one; a room's names its
 * Fuigo members (FUIGOTRUST4 (3)). */
export interface FolderTrustSubject {
  id: string;
  name: string;
}

export interface FolderTrustResult {
  subject: FolderTrustSubject | null;
  status: FolderTrustStatus;
}

/** The one-line verdict for a status: what the engine will do with the
 * folder's files on this bot's turn. Null when there is nothing to say. */
export function folderTrustStatusLabel(status: FolderTrustStatus): string | null {
  const record = status.record;
  const upstream = status.upstreamTrusted === true;
  if (status.refused) return t("folderTrust.statusRefused", { reason: status.refused });
  if (status.engineGates === false) return t("folderTrust.statusNotGated");
  if (!status.gated || (!status.sources.length && !record && !upstream)) return t("folderTrust.statusNothing");
  if (upstream) return t("folderTrust.statusUpstream");
  if (record) return record.decision === "trust" ? t("folderTrust.statusTrusted") : t("folderTrust.statusUntrusted");
  return t("folderTrust.statusUndecided");
}

/** The `data-folder-trust-status` a test or a screen reader keys on. */
export function folderTrustStatusKind(status: FolderTrustStatus): string {
  if (status.refused) return "refused";
  if (status.engineGates === false) return "not-gated";
  if (status.upstreamTrusted) return "upstream";
  return status.record?.decision ?? (status.gated ? "undecided" : "none");
}

/** What a verdict depends on: two members whose turns would treat the
 * folder identically (same engine instance, same store, same decision)
 * share one line; otherwise each member gets its own. */
function verdictKey(status: FolderTrustStatus): string {
  return JSON.stringify([
    status.instanceId ?? null,
    status.upstreamStore ?? null,
    status.engineGates ?? null,
    status.refused ?? null,
    status.upstreamTrusted === true,
    status.gated,
    status.record?.decision ?? null,
    [...status.sources].sort(),
  ]);
}

/** FUIGOTRUST4 (3): a room's members may run on different Fuigo instances
 * (different FUIGO_HOMEs, different stores) or routes. When every member's
 * verdict is the same, describe it once; when they differ, say so and list
 * each member's — never the first member's verdict as if it were the room's. */
export function folderTrustVerdicts(results: FolderTrustResult[]): { shared: FolderTrustResult | null; perMember: FolderTrustResult[] } {
  if (!results.length) return { shared: null, perMember: [] };
  const keys = new Set(results.map((result) => verdictKey(result.status)));
  if (keys.size === 1) return { shared: results[0], perMember: [] };
  return { shared: null, perMember: results };
}

function StatusLine({ status, name }: { status: FolderTrustStatus; name?: string }) {
  const label = folderTrustStatusLabel(status);
  if (!label) return null;
  const off = status.refused || (status.record?.decision === "reject" && !status.upstreamTrusted);
  return (
    <span className="inline-flex items-center gap-1" data-folder-trust-status={folderTrustStatusKind(status)} data-folder-trust-member={name}>
      {off ? <ShieldOff size={12} aria-hidden /> : <ShieldCheck size={12} aria-hidden />}
      {name ? <span className="font-medium">{name}:</span> : null}
      {label}
    </span>
  );
}

/** The note, rendered from what the server said (no fetching): a bot's
 * picker has one subject, a room's has its Fuigo members. */
export function FolderTrustNoteView({ folder, results, error, busy, onForget }: {
  folder: string | undefined;
  results: FolderTrustResult[] | null;
  error: string | null;
  busy: boolean;
  onForget: () => void;
}) {
  const { shared, perMember } = folderTrustVerdicts(results ?? []);
  const sources = results?.[0]?.status.sources ?? [];
  const anyRecord = Boolean(results?.some((result) => result.status.record));
  return (
    <div className="mt-2 text-[12px] text-ink-secondary" data-testid="folder-trust-note">
      <div>{t("folderTrust.pickerNote")}</div>
      {folder && shared && folderTrustStatusLabel(shared.status) && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <StatusLine status={shared.status} />
          {sources.length ? <span className="font-mono text-[11.5px]">{sources.join(", ")}</span> : null}
          {anyRecord && (
            <button
              type="button"
              onClick={onForget}
              disabled={busy}
              className="rounded-md px-1.5 py-0.5 text-[12px] text-ink underline-offset-2 hover:underline disabled:opacity-50"
            >
              {t("folderTrust.forget")}
            </button>
          )}
        </div>
      )}
      {folder && perMember.length > 0 && (
        <div className="mt-1" data-folder-trust-status="per-member">
          <div>{t("folderTrust.perMember")}</div>
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {perMember.map((result) => (
              <li key={result.subject?.id ?? "room"} className="flex flex-wrap items-center gap-1.5">
                <StatusLine status={result.status} name={result.subject?.name} />
              </li>
            ))}
          </ul>
          {sources.length ? <div className="mt-0.5 font-mono text-[11.5px]">{sources.join(", ")}</div> : null}
          {anyRecord && (
            <button
              type="button"
              onClick={onForget}
              disabled={busy}
              className="mt-0.5 rounded-md px-1.5 py-0.5 text-[12px] text-ink underline-offset-2 hover:underline disabled:opacity-50"
            >
              {t("folderTrust.forget")}
            </button>
          )}
        </div>
      )}
      {error && <div className="mt-1 text-danger">{error}</div>}
    </div>
  );
}

/** The one line under a working-folder picker (FUIGOTRUST1): a folder chosen
 * here is trusted — its AGENTS.md, CLAUDE.md, .mcp.json and skills apply —
 * and, for the folder currently set, what Murage remembers about it with a
 * way to forget it (the next turn there asks again). Reads the record
 * through GET /api/folder-trust; a folder with nothing to trust says so.
 * `botId` names the bot whose turn the note describes (its instance's
 * store, its route — FUIGOTRUST3 (4)); `members` names a room's Fuigo
 * members, each described as its own turn would be (FUIGOTRUST4 (3)). */
export function FolderTrustNote({ folder, botId, members }: { folder: string | undefined; botId?: string; members?: FolderTrustSubject[] }) {
  const [results, setResults] = useState<FolderTrustResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const subjects: Array<FolderTrustSubject | null> = members ? members : [botId ? { id: botId, name: "" } : null];
  const subjectKey = subjects.map((subject) => subject?.id ?? "").join(" ");

  useEffect(() => {
    let cancelled = false;
    setResults(null);
    setError(null);
    if (!folder) return;
    const query = (subject: FolderTrustSubject | null) =>
      api(`/api/folder-trust?folder=${encodeURIComponent(folder)}${subject ? `&bot=${encodeURIComponent(subject.id)}` : ""}`).then(
        (status: FolderTrustStatus): FolderTrustResult => ({ subject, status }),
      );
    Promise.all(subjects.map(query))
      .then((fetched) => {
        if (!cancelled) setResults(fetched);
      })
      .catch(() => {
        /* the note is advisory; a failed read shows only the sentence */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subjects is derived from subjectKey
  }, [folder, subjectKey]);

  const forget = async () => {
    if (!folder) return;
    setBusy(true);
    setError(null);
    try {
      // one Forget per subject: a card's record lives under that bot's
      // engine key (FUIGOTRUST4), which only its own picker route knows
      const ids = [...new Set(subjects.map((subject) => subject?.id).filter((id): id is string => Boolean(id)))];
      if (!ids.length) await api(`/api/folder-trust?folder=${encodeURIComponent(folder)}`, { method: "DELETE" });
      for (const id of ids) await api(`/api/folder-trust?folder=${encodeURIComponent(folder)}&bot=${encodeURIComponent(id)}`, { method: "DELETE" });
      setResults((current) => (current ? current.map((result) => ({ ...result, status: { ...result.status, record: null } })) : current));
    } catch {
      setError(t("folderTrust.forgetError"));
    } finally {
      setBusy(false);
    }
  };

  return <FolderTrustNoteView folder={folder} results={results} error={error} busy={busy} onForget={() => void forget()} />;
}
