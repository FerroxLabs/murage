// R3-T2: Workspace and Saved versions live in the same Files surface.
//
// The renderer suite runs in node with no DOM, so this file pins what the
// first paint says — which half you are looking at, which conversation's
// folder is being browsed, and which filters are still narrowing the saved
// list — plus the source wiring the browser proof depends on. Clicking,
// navigating, saving a version and Refresh reloading both halves are proved
// in a real browser by src/e2e/files.human.spec.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Files, downloadSavedArtifact, openedArtifactScope, type FilesBot } from "./Files";
import { resetNativeShellForTest } from "@/lib/native-shell";
import type { Artifact } from "../../shared/artifacts";

const auth = vi.hoisted(() => ({ ensure: vi.fn(), headers: vi.fn(() => ({ "x-murage-surface-secret": "synthetic-proof" })) }));
vi.mock("@/lib/live-events", () => ({ ensureDesktopSurfaceSecret: auth.ensure, desktopSurfaceHeaders: auth.headers, desktopResourceUrl: (url: unknown) => url }));

const source = readFileSync(fileURLToPath(new URL("./Files.tsx", import.meta.url)), "utf8");
const bots: FilesBot[] = [
  { id: "research", name: "Research bot", threadId: "task", tasks: [{ threadId: "task", title: "Weekly report" }] },
  { id: "ops", name: "Ops bot", threadId: "ops-task" },
];
const render = (props: Parameters<typeof Files>[0]) => renderToStaticMarkup(createElement(Files, props));

describe("both halves are on the same page", () => {
  it("names the workspace half and the saved half, and says Refresh reloads both", () => {
    const markup = render({ bots, initialBotId: "research" });
    expect(markup).toContain("Workspace</h2>");
    expect(markup).toContain("Saved versions</h2>");
    expect(markup).toContain("The files in this conversation&#x27;s folder right now. Not saved copies.");
    expect(markup).toContain("Verified copies Murage keeps.");
    expect(markup).toContain("Refresh reloads both.");
  });

  it("gives the workspace half the selected conversation and keeps the saved list on it", () => {
    const markup = render({ bots, initialBotId: "research", initialThreadId: "task" });
    expect(markup).toContain("Browsing Research bot · Weekly report");
    expect(markup).toContain("Showing only: Bot Research bot · Task Weekly report");
  });

  it("asks for a bot rather than guessing a folder when no conversation is chosen", () => {
    const markup = render({ bots });
    expect(markup).toContain("Choose a bot above to browse the folder Murage resolved for its conversation.");
    expect(markup).not.toContain("Browsing ");
    // Nothing narrows the saved list, so there is no way out to offer.
    expect(markup).toContain("Showing every saved file.");
    expect(markup).not.toContain("All saved files");
  });

  it("offers the way out of every filter that is narrowing the saved list", () => {
    const markup = render({ bots, initialBotId: "ops" });
    expect(markup).toContain("Showing only: Bot Ops bot");
    expect(markup).toContain(">All saved files</button>");
  });
});

describe("wiring the browser proof depends on", () => {
  it("passes the resolved conversation, not the picker text, to the workspace half", () => {
    expect(source).toContain("const scope: WorkspaceScopeRef | null = bot && targetThread ? { botId: bot.id, threadId: targetThread } : null;");
    expect(source).toMatch(/<WorkspaceFiles scope=\{scope\}[^>]*refreshToken=\{revision\}/);
  });

  it("drives one Refresh into both halves through the same counter", () => {
    expect(source).toContain("const refresh = () => { setNotice(null); setRevision(value => value + 1); };");
    expect(source).toContain("onClick={refresh}");
    // The saved query re-runs on `revision`; the workspace half re-reads on
    // the same value arriving as `refreshToken`.
    expect(source).toMatch(/\}, \[savedBotId, savedThreadId, kind, since, until, query, page, revision\]\);/);
  });

  it("re-runs the saved query on the widened scope, never on the picker directly", () => {
    expect(source).toContain('const savedBotId = savedEveryBot ? "" : botId, savedThreadId = savedEveryBot ? "" : threadId;');
    expect(source).toContain('if (savedBotId) params.set("botId", savedBotId); if (savedThreadId) params.set("threadId", savedThreadId);');
  });

  it("widens only the saved list, leaving the browsed workspace where it was", () => {
    const button = source.slice(source.indexOf('t("filesWorkspace.allSavedFiles")') - 400, source.indexOf('t("filesWorkspace.allSavedFiles")'));
    expect(button).toContain("setSavedEveryBot(true)");
    expect(button).not.toContain("setBotId(");
    expect(button).not.toContain("setThreadId(");
  });

  it("re-binds the saved list to the conversation whenever the pickers move", () => {
    for (const picker of [/setBotId\(event\.target\.value\);[^}]*setSavedEveryBot\(false\)/, /setThreadId\(event\.target\.value\);[^}]*setSavedEveryBot\(false\)/]) expect(source).toMatch(picker);
  });

  it("reloads the saved list after a workspace version is saved, and says which it was", () => {
    expect(source).toContain('setNotice(t(saved.pinnedRevision ? "filesWorkspace.saved" : "filesWorkspace.savedUnpinned", { name: saved.artifact.name }));');
    expect(source).toMatch(/const savedFromWorkspace[\s\S]{0,320}setRevision\(value => value \+ 1\);/);
  });
});

// R6 (D4 fix round 1): the artifact download route is desktop-authority-only
// (server/route-policy.ts, class desktop) and answers 404 for
// anything that cannot prove the desktop surface — a phone cannot, so
// downloadSavedArtifact must never ask native to fetch the route itself.
describe("downloadSavedArtifact stays on the desktop-proof fetch", () => {
  const artifact: Artifact = {
    id: "artifact-1", name: "Weekly report", filename: "weekly-report.md", kind: "text", mime: "text/markdown",
    bytes: 42, sha256: "synthetic-sha", createdAt: Date.now(), botId: "research", botName: "Research bot",
    threadId: "task", relativePath: "reports/weekly.md", sourceState: "current", savedState: "available",
    sourceConversationAvailable: true,
  };
  beforeEach(() => {
    auth.ensure.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("document", { createElement: vi.fn(() => ({ href: "", download: "", rel: "", referrerPolicy: "", click: vi.fn(), remove: vi.fn() })), body: { appendChild: vi.fn() } });
    vi.stubGlobal("window", { setTimeout });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("synthetic bytes")));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:synthetic");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetNativeShellForTest(); });

  it("never calls murageNative.saveFile, even when the phone app advertises it", async () => {
    const saveFile = vi.fn(async () => undefined);
    vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: ["saveFile"] }), saveFile });
    await downloadSavedArtifact(artifact);
    expect(saveFile).not.toHaveBeenCalled();
    expect(auth.ensure).toHaveBeenCalledOnce();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/artifacts/artifact-1/download",
      { headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": "synthetic-proof" } },
    );
  });
});

// A saved file opened by id (the Inbox's "Open file") belongs to its own bot
// and conversation, not to whichever one was on screen. Closing its preview
// showed a list scoped to the visible conversation, so the file just opened
// was not in it and its "Source conversation" could not be reached
// (0.1.61 CI, candidate-report-integration).
describe("a saved file opened by id", () => {
  const known = [{ id: "report-bot" }, { id: "joined" }];
  it("browses its own bot and conversation once it loads", () => {
    const artifact = { botId: "report-bot", threadId: "report-a" } as Artifact;
    expect(openedArtifactScope(artifact, { botId: "joined", threadId: "sibling-b" }, { bots: known, active: true })).toEqual({ botId: "report-bot", threadId: "report-a" });
    expect(openedArtifactScope(artifact, { botId: "report-bot", threadId: "report-a" }, { bots: known, active: true })).toBeNull();
  });
  // The preview answers after the person has already gone back to Saved
  // versions or picked another bot: their choice stands.
  it("leaves the pickers alone once the person has moved on", () => {
    const artifact = { botId: "report-bot", threadId: "report-a" } as Artifact;
    expect(openedArtifactScope(artifact, { botId: "joined", threadId: "sibling-b" }, { bots: known, active: false })).toBeNull();
  });
  // Saved files outlive their bot. A picker cannot show a bot that is gone,
  // so the saved list widens to every bot instead, where the file is.
  it("widens to every bot when the file's bot is gone", () => {
    const artifact = { botId: "deleted-bot", threadId: "old" } as Artifact;
    expect(openedArtifactScope(artifact, { botId: "joined", threadId: "sibling-b" }, { bots: known, active: true })).toEqual({ everyBot: true });
  });
  // A file opened by id at boot can answer before the bots have loaded; an
  // empty list does not mean its bot is gone (Kimi, audit of b1f1a611).
  it("does not call the bot gone before any bots are known", () => {
    const artifact = { botId: "report-bot", threadId: "report-a" } as Artifact;
    expect(openedArtifactScope(artifact, { botId: "", threadId: "" }, { bots: [], active: true })).toEqual({ botId: "report-bot", threadId: "report-a" });
  });
  it("wires the decision to the person's own moves", () => {
    // Backing out of the opened file and touching either picker end the flow.
    expect(source.match(/rescopeOpened\.current = false/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    // "All saved files" is the person choosing a scope too.
    expect(source).toMatch(/onClick=\{\(\) => \{ rescopeOpened\.current = false; setSavedEveryBot\(true\)/);
    expect(source).toContain("active: rescopeOpened.current");
  });
});

