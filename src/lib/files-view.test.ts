import { describe, expect, it, vi } from "vitest";
import type { Artifact } from "../../shared/artifacts";
import type { FileRevision, WorkspaceEntry } from "../../shared/workspace-files";
import {
  NO_SAVED_FILTERS, activeSavedFilters, canSaveEntry, entryNotice, formatFileSize, rootStateNotice, saveWorkspaceVersion, workspaceCrumbs, workspaceUrl,
} from "./files-view";

const scope = { botId: "bot-1", threadId: "thread-1" };
const file: WorkspaceEntry = { name: "report.html", relativePath: "reports/report.html", kind: "file", state: "local", bytes: 42, modifiedAt: 1, revision: "r1.abcdefghij" as FileRevision };
const artifact = { id: "a1", name: "report.html" } as Artifact;
const refused = (status: number, message: string) => Object.assign(new Error(message), { status });

describe("workspace addressing", () => {
  it("names the scope only and leaves undefined extras out", () => {
    expect(workspaceUrl("/api/workspace-files/list", scope, { directory: "reports/weekly & more", cursor: undefined }))
      .toBe("/api/workspace-files/list?botId=bot-1&threadId=thread-1&directory=reports%2Fweekly+%26+more");
  });

  it("builds breadcrumbs from the root to the current folder", () => {
    expect(workspaceCrumbs("", "Research bot")).toEqual([{ label: "Research bot", path: "" }]);
    expect(workspaceCrumbs("reports/2026/q3", "Research bot")).toEqual([
      { label: "Research bot", path: "" }, { label: "reports", path: "reports" }, { label: "2026", path: "reports/2026" }, { label: "q3", path: "reports/2026/q3" },
    ]);
  });

  it("formats sizes compactly", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(1023)).toBe("1023 B");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(25 * 1024 * 1024)).toBe("25 MB");
  });
});

describe("what each entry allows", () => {
  it("offers view and save only for a regular file with a server revision", () => {
    expect(canSaveEntry(file)).toBe(true);
    expect(canSaveEntry({ ...file, revision: undefined, state: "unsupported" })).toBe(false);
    expect(canSaveEntry({ ...file, kind: "link", state: "unsupported", revision: undefined })).toBe(false);
    expect(canSaveEntry({ name: "reports", relativePath: "reports", kind: "directory", state: "local" })).toBe(false);
  });

  it("explains links, missing, hard-linked and special entries", () => {
    expect(entryNotice(file)).toBeUndefined();
    expect(entryNotice({ ...file, kind: "link", state: "unsupported", revision: undefined })).toBe("filesWorkspace.entry.link");
    expect(entryNotice({ ...file, state: "missing", revision: undefined })).toBe("filesWorkspace.entry.missing");
    expect(entryNotice({ ...file, state: "unsupported", revision: undefined })).toBe("filesWorkspace.entry.unsupportedFile");
    expect(entryNotice({ ...file, kind: "other", state: "unsupported", revision: undefined })).toBe("filesWorkspace.entry.unsupported");
  });

  it("states legacy, remote and unavailable roots instead of listing them", () => {
    expect(rootStateNotice("ready")).toBeUndefined();
    expect(rootStateNotice("no-dedicated-workspace")).toBe("filesWorkspace.state.legacy");
    expect(rootStateNotice("remote")).toBe("filesWorkspace.state.remote");
    expect(rootStateNotice("unavailable")).toBe("filesWorkspace.state.unavailable");
  });
});

describe("saving a version", () => {
  it("saves the exact listed revision through save-version", async () => {
    const call = vi.fn(async () => ({ artifact }));
    await expect(saveWorkspaceVersion(call, { ...scope }, file)).resolves.toEqual({ artifact, pinnedRevision: true });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("/api/workspace-files/save-version", { method: "POST", body: JSON.stringify({ scope, relativePath: "reports/report.html", revision: file.revision }) });
  });

  it("falls back to exact-path registration only when save-version is not in this build", async () => {
    const call = vi.fn(async (path: string) => { if (path.startsWith("/api/workspace-files/")) throw refused(501, "not implemented"); return { artifact }; });
    await expect(saveWorkspaceVersion(call, scope, file)).resolves.toEqual({ artifact, pinnedRevision: false });
    expect(call).toHaveBeenLastCalledWith("/api/artifacts/register", { method: "POST", body: JSON.stringify({ botId: "bot-1", threadId: "thread-1", relativePath: "reports/report.html" }) });
  });

  it("never retries a changed file another way", async () => {
    const call = vi.fn(async () => { throw refused(409, "The file changed since it was listed."); });
    await expect(saveWorkspaceVersion(call, scope, file)).rejects.toThrow("The file changed since it was listed.");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("refuses an entry that cannot be saved without calling the server", async () => {
    const call = vi.fn(async () => ({ artifact }));
    await expect(saveWorkspaceVersion(call, scope, { ...file, kind: "link", state: "unsupported", revision: undefined })).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });
});

describe("active saved-version filters", () => {
  const bots = [{ id: "bot-1", name: "Research bot", tasks: [{ threadId: "thread-1", title: "Weekly report" }] }];
  it("is empty when nothing narrows the list", () => {
    expect(activeSavedFilters(NO_SAVED_FILTERS, bots)).toEqual([]);
  });
  it("names every filter in plain words", () => {
    expect(activeSavedFilters({ botId: "bot-1", threadId: "thread-1", kind: "html", since: "2026-09-01", until: "2026-09-11", query: "q3" }, bots)).toEqual([
      "Bot Research bot", "Task Weekly report", "Type HTML reports", "From 2026-09-01", "Until 2026-09-11", "Name contains “q3”",
    ]);
  });
});
