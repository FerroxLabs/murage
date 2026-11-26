import { useEffect, useRef, useState } from "react";
import { ShieldCheck, ShieldOff } from "lucide-react";

import type { FolderTrustDestination, FolderTrustObservation } from "../../shared/folder-trust";
import { isPhoneClient } from "@/lib/phone-client";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { FolderTrustRecords } from "./FolderTrustRecords";

/** One stored decision, as GET /api/folder-trust lists it. `onPath` is a
 * display hint: it groups rows and decides nothing. */
export interface FolderTrustRecordRow {
  key: string;
  folder: string;
  decision: "trust" | "reject";
  consent?: 2;
  source: "picker" | "card" | "upgrade";
  decidedAt: number;
  onPath: boolean;
}

export interface FolderTrustStatus {
  /** The folder the server looked at (for a conversation, its actual folder). */
  folder?: string;
  key?: string;
  gated: boolean;
  sources: string[];
  record: { key?: string; decision: "trust" | "reject"; consent?: 2; decidedAt: number; source: "picker" | "card" | "upgrade" } | null;
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
  /** Every stored decision, whatever folder it was made on. */
  records?: FolderTrustRecordRow[];
  recordsNext?: string | null;
  recordsTotal?: number;
  recordsRevision?: string;
  lastObserved?: FolderTrustObservation | null;
  destination?: FolderTrustDestination;
  observedVersion?: string | null;
  /** The engine's own trust file for this bot, own home only. */
  upstreamTrustFile?: string | null;
  /** Keys that file answers no for, exactly as written there. */
  upstreamDeclines?: string[];
  /** That file exists and could not be read or parsed. */
  upstreamUnreadable?: boolean;
  /** The trust protocol of the engine a turn would run on. */
  trustGeneration?: 1 | 2;
}

/** The request that forgets one stored decision: the key alone says which. */
export function folderTrustForgetKeyPath(target: string, key: string): string {
  return `/api/folder-trust?${target}&key=${encodeURIComponent(key)}`;
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
  if (record?.decision === "trust" && record.consent !== 2 && status.trustGeneration === 2) return t("folderTrust.rowUnstamped");
  if (record) return record.decision === "trust" ? t("folderTrust.statusTrusted") : t("folderTrust.statusUntrusted");
  return t("folderTrust.statusUndecided");
}

/** The `data-folder-trust-status` a test or a screen reader keys on. */
export function folderTrustStatusKind(status: FolderTrustStatus): string {
  if (status.refused) return "refused";
  if (status.engineGates === false) return "not-gated";
  if (status.upstreamTrusted) return "upstream";
  if (status.record?.decision === "trust" && status.record.consent !== 2 && status.trustGeneration === 2) return "legacy";
  return status.record?.decision ?? (status.gated ? "undecided" : "none");
}

/** What a verdict depends on: two members whose turns would treat the
 * folder identically (same engine instance, same store, same decision)
 * share one line; otherwise each member gets its own. */
function verdictKey(status: FolderTrustStatus): string {
  return JSON.stringify([
    status.instanceId ?? null,
    status.upstreamStore ?? null,
    status.destination ?? null,
    status.observedVersion ?? "unknown",
    status.lastObserved ?? null,
    status.engineGates ?? null,
    status.refused ?? null,
    status.upstreamTrusted === true,
    status.gated,
    status.record?.decision ?? null,
    status.record?.consent ?? null,
    status.trustGeneration ?? null,
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
export function FolderTrustNoteView({ folder, results, error, busy, onForget, onForgetKey, onTrust, conversation, onSearch, onMore, searchQuery, phone = isPhoneClient() }: {
  folder: string | undefined;
  results: FolderTrustResult[] | null;
  error: string | null;
  busy: boolean;
  onForget: () => void;
  /** Forgets one stored decision by its exact key. */
  onForgetKey?: (key: string) => void;
  /** Present for a conversation's own folder: records Trust for that exact folder. */
  onTrust?: () => void;
  /** The note describes the conversation's actual folder, not a picked one. */
  conversation?: boolean;
  onSearch?: (query: string) => void;
  onMore?: () => void;
  searchQuery?: string;
  phone?: boolean;
}) {
  const { shared, perMember } = folderTrustVerdicts(results ?? []);
  const sources = results?.[0]?.status.sources ?? [];
  const anyRecord = Boolean(results?.some((result) => result.status.record));
  const first = results?.[0]?.status;
  const canTrust = Boolean(!phone && onTrust && first && first.gated && first.sources.length && !first.upstreamTrusted && first.engineGates !== false && !first.refused && first.record?.decision !== "trust");
  const trustButton = canTrust ? (
    <button
      type="button"
      onClick={onTrust}
      disabled={busy}
      data-testid="folder-trust-trust"
      className="rounded-md px-1.5 py-0.5 text-[12px] text-ink underline-offset-2 hover:underline disabled:opacity-50"
    >
      {t("folderTrust.trust")}
    </button>
  ) : null;
  return (
    <div className="mt-2 text-[12px] text-ink-secondary" data-testid="folder-trust-note">
      <div>{conversation ? t("folderTrust.conversationNote") : t("folderTrust.pickerNote")}</div>
      {conversation && first?.folder && (
        <div className="mt-1 break-all" data-testid="folder-trust-folder">
          {t("folderTrust.conversationFolder")} <span className="font-mono text-[11.5px]">{first.folder}</span>
        </div>
      )}
      {(folder || conversation) && shared && folderTrustStatusLabel(shared.status) && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <StatusLine status={shared.status} />
          {sources.length ? <span className="font-mono text-[11.5px]">{sources.join(", ")}</span> : null}
          {trustButton}
          {!phone && anyRecord && (
            <button
              type="button"
              data-testid="folder-trust-forget"
              onClick={onForget}
              disabled={busy}
              className="rounded-md px-1.5 py-0.5 text-[12px] text-ink underline-offset-2 hover:underline disabled:opacity-50"
            >
              {t("folderTrust.forget")}
            </button>
          )}
        </div>
      )}
      {(folder || conversation) && perMember.length > 0 && (
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
          {!phone && anyRecord && (
            <button
              type="button"
              data-testid="folder-trust-forget"
              onClick={onForget}
              disabled={busy}
              className="mt-0.5 rounded-md px-1.5 py-0.5 text-[12px] text-ink underline-offset-2 hover:underline disabled:opacity-50"
            >
              {t("folderTrust.forget")}
            </button>
          )}
        </div>
      )}
      {(folder || conversation) && results?.map(({ subject, status }) => (
        <div key={subject?.id ?? "folder"} className="mt-1" data-folder-trust-member={subject?.id}>
          {status.destination && <div data-testid="folder-trust-engine">
            {subject?.name ? `${subject.name}: ` : ""}{t(`folderTrust.destination.${status.destination}`)}
            {" · "}{t("folderTrust.engineVersion", { generation: status.trustGeneration ?? 2, version: status.observedVersion ?? "unknown" })}
          </div>}
          <div data-testid="folder-trust-last-turn">
            {t("folderTrust.lastTurn")}: {status.lastObserved?.kind === "process-choice-sent" ? <>{t("folderTrust.processLabel")} {t("folderTrust.processDescription")}</>
              : status.lastObserved?.kind === "configuration-withheld" ? <>{t("folderTrust.withheldObservation")} {status.lastObserved.reason && status.lastObserved.reason !== "none" && t(`folderTrust.reason.${status.lastObserved.reason}`)}</>
              : status.lastObserved?.kind === "saved-choice-sent" ? t("folderTrust.savedChoiceSent") : t("folderTrust.observationUnknown")}
          </div>
        </div>
      ))}
      {!phone && (folder || conversation) && results && onForgetKey && <FolderTrustRecords results={results} busy={busy} onForgetKey={onForgetKey} onSearch={onSearch} onMore={onMore} searchQuery={searchQuery} />}
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
export function FolderTrustNote({ folder, botId, members, threadId }: { folder: string | undefined; botId?: string; members?: FolderTrustSubject[]; threadId?: string }) {
  const phone = isPhoneClient();
  const [results, setResults] = useState<FolderTrustResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const subjects: Array<FolderTrustSubject | null> = members ? members : [botId ? { id: botId, name: "" } : null];
  const subjectKey = subjects.map((subject) => subject?.id ?? "").join(" ");

  // the newest read wins: a Forget's re-read never lands on a note that has moved to another folder
  const readSeq = useRef(0);
  const [searchQuery, setSearchQuery] = useState("");
  const recordSearch = useRef("");
  const read = (page?: { cursor?: string; append?: boolean }) => {
    const seq = ++readSeq.current;
    const query = (subject: FolderTrustSubject | null) => {
      const previous = results?.find(item => item.subject?.id === subject?.id);
      if (page?.append && !previous?.status.recordsNext) return Promise.resolve(previous!);
      const cursor = page?.append ? previous?.status.recordsNext : page?.cursor;
      return api(`/api/folder-trust?${threadId ? `thread=${encodeURIComponent(threadId)}` : `folder=${encodeURIComponent(folder ?? "")}`}${subject ? `&bot=${encodeURIComponent(subject.id)}` : ""}&search=${encodeURIComponent(recordSearch.current)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`).then(
        (status: FolderTrustStatus): FolderTrustResult => ({ subject, status }),
      );
    };
    return Promise.all(subjects.map(query))
      .then((fetched) => {
        if (seq === readSeq.current) setResults(current => page?.append ? fetched.map(result => {
          const previous = current?.find(item => item.subject?.id === result.subject?.id);
          const records = [...(previous?.status.recordsRevision === result.status.recordsRevision ? previous?.status.records ?? [] : []), ...(result.status.records ?? [])];
          return { ...result, status: { ...result.status, records: [...new Map(records.map(row => [row.key, row])).values()] } };
        }) : fetched);
      })
      .catch(() => {
        if (seq === readSeq.current && page?.append) void read();
      });
  };

  useEffect(() => {
    setResults(null);
    setError(null);
    setBusy(false);
    recordSearch.current = "";
    setSearchQuery("");
    if (phone || (!folder && !threadId)) return;
    void read();
    return () => {
      readSeq.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subjects is derived from subjectKey
  }, [folder, threadId, subjectKey, phone]);

  const target = (id: string | undefined) => (threadId ? `thread=${encodeURIComponent(threadId)}` : `folder=${encodeURIComponent(folder ?? "")}`) + (id ? `&bot=${encodeURIComponent(id)}` : "");

  const trust = async () => {
    if (!threadId || !botId) return;
    const seq = ++readSeq.current;
    setBusy(true);
    setError(null);
    try {
      const status: FolderTrustStatus = await api("/api/folder-trust", { method: "POST", body: JSON.stringify({ bot: botId, thread: threadId }) });
      if (seq === readSeq.current) setResults([{ subject: subjects[0], status }]);
    } catch {
      if (seq === readSeq.current) setError(t("folderTrust.trustError"));
    } finally {
      if (seq === readSeq.current) setBusy(false);
    }
  };

  const forget = async () => {
    if (!folder && !threadId) return;
    const seq = ++readSeq.current;
    setBusy(true);
    setError(null);
    try {
      // Forget exactly the saved answers returned for this subject, even if its cwd has changed.
      const keys = [...new Set(results?.map(result => result.status.record?.key).filter((key): key is string => Boolean(key)))];
      for (const key of keys) await api(folderTrustForgetKeyPath(target(subjects[0]?.id), key), { method: "DELETE" });
    } catch {
      if (seq === readSeq.current) setError(t("folderTrust.forgetError"));
    } finally {
      if (seq === readSeq.current) { setBusy(false); await read(); }
    }
  };

  const forgetKey = async (key: string) => {
    const seq = ++readSeq.current;
    setBusy(true);
    setError(null);
    try {
      await api(folderTrustForgetKeyPath(target(subjects[0]?.id), key), { method: "DELETE" });
    } catch {
      if (seq === readSeq.current) setError(t("folderTrust.forgetError"));
    } finally {
      if (seq === readSeq.current) { setBusy(false); await read(); }
    }
  };

  if (phone) return null;
  return (
    <FolderTrustNoteView
      folder={folder}
      results={results}
      error={error}
      busy={busy}
      onForget={() => void forget()}
      onForgetKey={(key) => void forgetKey(key)}
      searchQuery={searchQuery}
      onSearch={query => { setSearchQuery(query); recordSearch.current = query; void read(); }}
      onMore={() => { const cursor = results?.[0]?.status.recordsNext; if (cursor) void read({ cursor, append: true }); }}
      {...(threadId && botId ? { onTrust: () => void trust(), conversation: true } : {})}
    />
  );
}
