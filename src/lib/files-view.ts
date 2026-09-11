// Files view helpers (R3-T2). The Workspace view shows a bot's files as they
// are right now; Saved versions shows verified copies that never change.
// Kept free of React and the DOM so the node renderer suite can test them.
import type { Artifact, ArtifactKind } from "../../shared/artifacts";
import {
  WORKSPACE_FILES_ROUTES,
  type WorkspaceEntry, type WorkspaceRootState, type WorkspaceSaveVersionResponse, type WorkspaceScopeRef,
} from "../../shared/workspace-files";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

export type ApiCall = (path: string, init?: RequestInit) => Promise<unknown>;

/** Query URL for one workspace route. The client names a scope only, never
 * a root; undefined extras are left out. */
export function workspaceUrl(route: string, scope: WorkspaceScopeRef, extra: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams({ botId: scope.botId, threadId: scope.threadId });
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) params.set(key, value);
  return `${route}?${params}`;
}

export interface WorkspaceCrumb { label: string; path: string }
export function workspaceCrumbs(directory: string, rootLabel: string): WorkspaceCrumb[] {
  const crumbs: WorkspaceCrumb[] = [{ label: rootLabel, path: "" }];
  let path = "";
  for (const part of directory ? directory.split("/") : []) { path = path ? `${path}/${part}` : part; crumbs.push({ label: part, path }); }
  return crumbs;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.trunc(bytes || 0))} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

export const isHtmlPath = (relativePath: string) => /\.html?$/i.test(relativePath);

/** Only a regular, singly linked file the server issued a revision for can be
 * viewed or saved. Links, hard links and special files cannot. */
export function canSaveEntry(entry: WorkspaceEntry): boolean {
  return entry.kind === "file" && entry.state === "local" && typeof entry.revision === "string";
}

export function entryNotice(entry: WorkspaceEntry): LocaleKey | undefined {
  if (entry.kind === "link") return "filesWorkspace.entry.link";
  if (entry.state === "missing") return "filesWorkspace.entry.missing";
  if (entry.state === "unsupported") return entry.kind === "file" ? "filesWorkspace.entry.unsupportedFile" : "filesWorkspace.entry.unsupported";
  if (entry.kind === "other") return "filesWorkspace.entry.other";
  return undefined;
}

/** Legacy (cwd null) and remote conversations answer a state, never a listing
 * of HOME or a path on another computer. */
export function rootStateNotice(state: WorkspaceRootState): LocaleKey | undefined {
  if (state === "no-dedicated-workspace") return "filesWorkspace.state.legacy";
  if (state === "remote") return "filesWorkspace.state.remote";
  if (state === "unavailable") return "filesWorkspace.state.unavailable";
  return undefined;
}

/** Native open/reveal of one live workspace file (F4-T5). The renderer
 * names the conversation and the entry's relative path only; the Electron
 * main process authorizes the file through the server, applies the extension
 * allowlist, warns before a browser opens HTML/SVG, and revalidates the path
 * immediately before the OS call. Absent outside the desktop shell. */
export type WorkspaceNativeAction = (scope: WorkspaceScopeRef, entry: WorkspaceEntry, action: "open" | "reveal") => Promise<void>;

export function workspaceNativeAction(): WorkspaceNativeAction | undefined {
  const bridge = typeof window === "undefined" ? undefined : window.muragebox;
  if (typeof bridge?.workspaceFileAction !== "function") return undefined;
  const act = bridge.workspaceFileAction;
  return (scope, entry, action) => {
    if (!canSaveEntry(entry)) return Promise.reject(new Error(t("filesWorkspace.nativeUnavailable")));
    return act({ botId: scope.botId, threadId: scope.threadId }, entry.relativePath, action);
  };
}

export interface SavedVersionResult { artifact: Artifact; pinnedRevision: boolean }

/** Save the exact revision the owner picked (F4-T1 `save-version`). Only when
 * that route is absent from this build (501) does it fall back to the
 * existing exact-path registration, which re-verifies the file on the server
 * but cannot pin the listed revision. A conflict, or any other refusal, is
 * surfaced as is and never retried another way. */
export async function saveWorkspaceVersion(call: ApiCall, scope: WorkspaceScopeRef, entry: WorkspaceEntry): Promise<SavedVersionResult> {
  if (!canSaveEntry(entry)) throw new Error(t("filesWorkspace.saveUnavailable"));
  const exactScope = { botId: scope.botId, threadId: scope.threadId };
  try {
    const response = await call(WORKSPACE_FILES_ROUTES.saveVersion, {
      method: "POST", body: JSON.stringify({ scope: exactScope, relativePath: entry.relativePath, revision: entry.revision }),
    }) as WorkspaceSaveVersionResponse;
    return { artifact: response.artifact, pinnedRevision: true };
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status !== 501) throw error;
  }
  const response = await call("/api/artifacts/register", {
    method: "POST", body: JSON.stringify({ ...exactScope, relativePath: entry.relativePath }),
  }) as { artifact: Artifact };
  return { artifact: response.artifact, pinnedRevision: false };
}

export interface SavedFilters { botId: string; threadId: string; kind: ArtifactKind | ""; since: string; until: string; query: string }
export const NO_SAVED_FILTERS: SavedFilters = { botId: "", threadId: "", kind: "", since: "", until: "", query: "" };

const KIND_LABEL: Record<ArtifactKind, LocaleKey> = {
  html: "filesWorkspace.kind.html", text: "filesWorkspace.kind.text", image: "filesWorkspace.kind.image", other: "filesWorkspace.kind.other",
};

export interface FilterBot { id: string; name: string; tasks?: { threadId: string; title: string }[] }

/** Human labels for every saved-version filter currently narrowing the list,
 * so an empty result can never hide why it is empty. */
export function activeSavedFilters(filters: SavedFilters, bots: FilterBot[]): string[] {
  const bot = bots.find(item => item.id === filters.botId), labels: string[] = [];
  if (filters.botId) labels.push(t("filesWorkspace.filter.bot", { value: bot?.name ?? filters.botId }));
  if (filters.threadId) labels.push(t("filesWorkspace.filter.task", { value: bot?.tasks?.find(task => task.threadId === filters.threadId)?.title ?? t("filesWorkspace.currentTask") }));
  if (filters.kind) labels.push(t("filesWorkspace.filter.type", { value: t(KIND_LABEL[filters.kind]) }));
  if (filters.since) labels.push(t("filesWorkspace.filter.since", { value: filters.since }));
  if (filters.until) labels.push(t("filesWorkspace.filter.until", { value: filters.until }));
  if (filters.query) labels.push(t("filesWorkspace.filter.name", { value: filters.query }));
  return labels;
}
