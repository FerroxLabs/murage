import { track } from "@/lib/analytics";
import { teamImportPreview, type PendingTeamImport } from "@/lib/team-import";
import { api, useStore, type Bot } from "@/state/store";
import {
  ArrowLeft,
  ExternalLink,
  FileJson,
  Github,
  Library,
  Link as LinkIcon,
  Loader2,
  UploadCloud,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const MAX_TEAM_FILE_BYTES = 1_000_000;
const COMMUNITY_TEAMS_REPOSITORY = "https://github.com/milind-soni/openmausbot-teams";

interface TeamCatalogEntry {
  slug: string;
  name: string;
  summary: string;
  category: string;
  manifest: string;
  readme: string;
  members: number;
  skills: string[];
  requires: { apps: string[] };
}

interface TeamCatalog {
  repositoryUrl: string;
  teams: TeamCatalogEntry[];
}

type ImportSource = "library" | "file" | "github";
type ImportTab = "explore" | "file" | "github";

async function openExternal(url: string): Promise<void> {
  if (window.ogb?.openExternal) {
    await window.ogb.openExternal(url);
    return;
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (opened) opened.opener = null;
}

function teamSourceUrl(repositoryUrl: string, entry: TeamCatalogEntry): string {
  const folder = entry.readme.replace(/\/README\.md$/, "");
  return `${repositoryUrl}/tree/main/${folder}`;
}

export function TeamLibraryPanel({
  onClose,
  onImported,
  returnFocusRef,
}: {
  onClose: () => void;
  onImported: (name: string, members: number) => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const { dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<ImportTab>("explore");
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingTeamImport | null>(null);
  const [source, setSource] = useState<ImportSource>("file");
  const [githubUrl, setGithubUrl] = useState("");
  const [githubLoading, setGithubLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError("");
    try {
      const result = (await api("/api/team-library/catalog")) as TeamCatalog;
      setCatalog(result);
    } catch (cause) {
      setCatalogError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    dialogRef.current?.focus();
    return () => returnFocusRef.current?.focus();
  }, [returnFocusRef]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !importing) {
        event.preventDefault();
        event.stopPropagation();
        if (pending) setPending(null);
        else onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      const items = Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (!dialog || items.length === 0) return;
      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [importing, onClose, pending]);

  const previewManifest = (manifest: unknown, nextSource: ImportSource) => {
    setPending(teamImportPreview(manifest));
    setSource(nextSource);
    setError("");
  };

  const readFile = async (file: File) => {
    if (file.size > MAX_TEAM_FILE_BYTES) throw new Error("That team file is too large.");
    let manifest: unknown;
    try {
      manifest = JSON.parse(await file.text());
    } catch (cause) {
      if (cause instanceof SyntaxError) throw new Error("That team file is not valid JSON.");
      throw cause;
    }
    previewManifest(manifest, "file");
  };

  const loadLibraryTeam = async (entry: TeamCatalogEntry) => {
    setBusySlug(entry.slug);
    setError("");
    try {
      previewManifest(await api(`/api/team-library/teams/${entry.slug}`), "library");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusySlug(null);
    }
  };

  const loadGithubTeam = async () => {
    if (!githubUrl.trim()) return;
    setGithubLoading(true);
    setError("");
    try {
      const manifest = await api("/api/team-library/github", {
        method: "POST",
        body: JSON.stringify({ url: githubUrl.trim() }),
      });
      previewManifest(manifest, "github");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGithubLoading(false);
    }
  };

  const importTeam = async () => {
    if (!pending) return;
    setImporting(true);
    setError("");
    try {
      const response = (await api("/api/teams/import", {
        method: "POST",
        body: JSON.stringify(pending.manifest),
      })) as { bots: Bot[] };
      for (const bot of response.bots) dispatch({ type: "botAdded", bot });
      const first = response.bots[0];
      if (first) dispatch({ type: "select", id: first.id });
      track("team_imported", { members: response.bots.length, source });
      onImported(pending.name, response.bots.length);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(event) => event.target === event.currentTarget && !importing && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-library-title"
        tabIndex={-1}
        className="flex max-h-[min(760px,calc(100vh-32px))] w-[760px] max-w-full flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-hairline/40 px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {pending && (
                <button
                  onClick={() => {
                    setPending(null);
                    setError("");
                  }}
                  disabled={importing}
                  className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
                  aria-label="Back to team library"
                >
                  <ArrowLeft size={17} />
                </button>
              )}
              <h2 id="team-library-title" className="truncate text-[19px] font-semibold text-ink">
                {pending ? `Import ${pending.name}?` : "Add a team"}
              </h2>
            </div>
            <p className="mt-1 text-[13px] text-ink-secondary">
              {pending
                ? `This creates ${pending.members.length} new ${pending.members.length === 1 ? "bot" : "bots"}. No room is created.`
                : "Start with a community team, a local file, or a public GitHub link."}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => void openExternal(catalog?.repositoryUrl ?? COMMUNITY_TEAMS_REPOSITORY)}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              title="Open the community team repository"
            >
              <Github size={15} />
              <span className="max-sm:hidden">Community repo</span>
              <ExternalLink size={12} />
            </button>
            <button
              onClick={onClose}
              disabled={importing}
              className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
              aria-label="Close team library"
            >
              <X size={19} />
            </button>
          </div>
        </header>

        {pending ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {pending.description && <p className="mb-4 text-[13.5px] leading-relaxed text-ink-secondary">{pending.description}</p>}
            <div className="space-y-1 rounded-xl bg-raised/45 p-2">
              {pending.members.map((member, index) => (
                <div key={`${member.name}-${index}`} className="flex items-baseline gap-3 rounded-lg px-2.5 py-2">
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{member.name}</span>
                  <span className="max-w-[280px] truncate text-[12.5px] text-ink-secondary">
                    {member.title || "General assistant"}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-4 text-[12.5px] leading-relaxed text-ink-secondary">
              Bots use your default engine. Conversations, API keys, permissions, provider sessions, and computer access are never imported.
            </p>
            {source === "library" && (
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">
                The team&apos;s role playbooks are available in the community repo for you to review; this import currently adds the bot roles only.
              </p>
            )}
            {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
          </div>
        ) : (
          <>
            <div className="flex gap-1 border-b border-hairline/40 px-5 pt-3" role="tablist" aria-label="Team import source">
              {([
                ["explore", Library, "Explore"],
                ["file", FileJson, "From file"],
                ["github", Github, "From GitHub"],
              ] as const).map(([value, Icon, label]) => (
                <button
                  key={value}
                  role="tab"
                  aria-selected={tab === value}
                  onClick={() => {
                    setTab(value);
                    setError("");
                  }}
                  className={`flex items-center gap-2 border-b-2 px-3 py-2 text-[13.5px] transition-colors ${
                    tab === value ? "border-accent text-ink" : "border-transparent text-ink-secondary hover:text-ink"
                  }`}
                >
                  <Icon size={15} /> {label}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {tab === "explore" && (
                <div>
                  {catalogLoading && (
                    <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-ink-secondary">
                      <Loader2 size={17} className="animate-spin" /> Loading community teams…
                    </div>
                  )}
                  {!catalogLoading && catalogError && (
                    <div className="rounded-xl border border-danger/20 bg-danger/5 p-4 text-[13px] text-danger">
                      <p>{catalogError}</p>
                      <button onClick={() => void loadCatalog()} className="mt-3 rounded-lg bg-raised px-3 py-1.5 text-ink hover:bg-raised/80">
                        Try again
                      </button>
                    </div>
                  )}
                  {!catalogLoading && catalog && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {catalog.teams.map((entry) => (
                        <article key={entry.slug} className="flex min-h-52 flex-col rounded-xl border border-hairline/45 bg-raised/25 p-4">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <span className="text-[11px] font-medium uppercase tracking-wide text-accent">{entry.category}</span>
                              <h3 className="mt-0.5 text-[15px] font-semibold text-ink">{entry.name}</h3>
                            </div>
                            <button
                              onClick={() => void openExternal(teamSourceUrl(catalog.repositoryUrl, entry))}
                              className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
                              title={`View ${entry.name} on GitHub`}
                              aria-label={`View ${entry.name} on GitHub`}
                            >
                              <ExternalLink size={14} />
                            </button>
                          </div>
                          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">{entry.summary}</p>
                          <div className="mt-3 flex flex-wrap gap-1.5 text-[11.5px] text-ink-secondary">
                            <span className="flex items-center gap-1 rounded-md bg-raised px-2 py-1"><Users size={12} /> {entry.members} bots</span>
                            <span className="rounded-md bg-raised px-2 py-1">{entry.skills.length} playbooks</span>
                          </div>
                          {entry.requires.apps.length > 0 && (
                            <p className="mt-2 line-clamp-2 text-[11.5px] text-ink-secondary">
                              Works with {entry.requires.apps.join(", ")}
                            </p>
                          )}
                          <button
                            onClick={() => void loadLibraryTeam(entry)}
                            disabled={busySlug !== null}
                            className="mt-auto flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white hover:bg-accent/90 disabled:opacity-50"
                          >
                            {busySlug === entry.slug && <Loader2 size={14} className="animate-spin" />}
                            {busySlug === entry.slug ? "Loading…" : "Preview team"}
                          </button>
                        </article>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {tab === "file" && (
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,.mausteam.json,application/json"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (!file) return;
                      void readFile(file).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
                    }}
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    onDragEnter={(event) => {
                      event.preventDefault();
                      setDragging(true);
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragging(false);
                      const file = event.dataTransfer.files[0];
                      if (file) void readFile(file).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
                    }}
                    className={`flex min-h-64 w-full flex-col items-center justify-center rounded-2xl border border-dashed px-6 text-center transition-colors ${
                      dragging ? "border-accent bg-accent/5" : "border-hairline bg-raised/20 hover:bg-raised/40"
                    }`}
                  >
                    <UploadCloud size={32} className="text-accent" />
                    <span className="mt-3 text-[15px] font-medium text-ink">Drop a team JSON here</span>
                    <span className="mt-1 text-[12.5px] text-ink-secondary">or click to choose a `.mausteam.json` file</span>
                  </button>
                </div>
              )}

              {tab === "github" && (
                <div className="mx-auto max-w-xl py-8">
                  <div className="flex size-11 items-center justify-center rounded-xl bg-raised text-ink-secondary"><LinkIcon size={21} /></div>
                  <h3 className="mt-4 text-[16px] font-semibold text-ink">Load a public GitHub team</h3>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
                    Paste a repository containing `team.mausteam.json`, or a direct GitHub link to any OpenMaus team JSON file.
                  </p>
                  <div className="mt-4 flex gap-2">
                    <input
                      value={githubUrl}
                      onChange={(event) => setGithubUrl(event.target.value)}
                      onKeyDown={(event) => event.key === "Enter" && void loadGithubTeam()}
                      placeholder="https://github.com/owner/team-repo"
                      aria-label="GitHub team URL"
                      className="min-w-0 flex-1 rounded-lg bg-raised/70 px-3 py-2.5 text-[13.5px] text-ink placeholder:text-ink-secondary focus:outline-none"
                    />
                    <button
                      onClick={() => void loadGithubTeam()}
                      disabled={!githubUrl.trim() || githubLoading}
                      className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-[13.5px] font-medium text-white hover:bg-accent/90 disabled:opacity-40"
                    >
                      {githubLoading && <Loader2 size={14} className="animate-spin" />}
                      {githubLoading ? "Loading…" : "Load"}
                    </button>
                  </div>
                  <p className="mt-3 text-[11.5px] text-ink-secondary">Only public HTTPS links from github.com are fetched.</p>
                </div>
              )}

              {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
            </div>
          </>
        )}

        {pending && (
          <footer className="flex items-center justify-end gap-2 border-t border-hairline/40 px-5 py-4">
            <button
              onClick={() => setPending(null)}
              disabled={importing}
              className="rounded-lg px-3.5 py-2 text-[13.5px] text-ink-secondary hover:bg-raised disabled:opacity-50"
            >
              Back
            </button>
            <button
              onClick={() => void importTeam()}
              disabled={importing}
              className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[13.5px] font-medium text-white hover:bg-accent/90 disabled:opacity-60"
            >
              {importing && <Loader2 size={15} className="animate-spin" />}
              {importing ? "Importing…" : `Import ${pending.members.length} ${pending.members.length === 1 ? "bot" : "bots"}`}
            </button>
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
