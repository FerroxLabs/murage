// The folder-trust note under a working-folder picker, rendered in node the
// way the rest of the renderer suite is (no DOM): the verdict as a pure
// function of what GET /api/folder-trust said, and the room rule
// (FUIGOTRUST4 (3)): a room's note describes its Fuigo members' own turns —
// one line when they all resolve the same, one line PER MEMBER when they do
// not — never the first Fuigo instance's store as if it were the room's.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FolderTrustNoteView, folderTrustStatusKind, folderTrustStatusLabel, folderTrustVerdicts, type FolderTrustResult, type FolderTrustStatus } from "./FolderTrustNote";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

const status = (over: Partial<FolderTrustStatus> = {}): FolderTrustStatus => ({
  gated: true,
  sources: ["AGENTS.md"],
  record: null,
  upstreamTrusted: false,
  upstreamStore: "own",
  engineGates: true,
  instanceId: "fuigo",
  refused: null,
  ...over,
});
const result = (name: string, over: Partial<FolderTrustStatus> = {}): FolderTrustResult => ({ subject: { id: name.toLowerCase(), name }, status: status(over) });
const renderAt = (folder: string | undefined, results: FolderTrustResult[] | null) =>
  renderToStaticMarkup(createElement(FolderTrustNoteView, { folder, results, error: null, busy: false, onForget: () => {} }));
const render = (results: FolderTrustResult[] | null) => renderAt("/work/repo", results);

describe("folderTrustStatusLabel", () => {
  it("says what the engine will do with the folder's files on this bot's turn", () => {
    expect(folderTrustStatusLabel(status())).toBe("Not decided yet — the first turn here will ask");
    expect(folderTrustStatusLabel(status({ record: { decision: "trust", decidedAt: 1, source: "picker" } }))).toBe("Trusted");
    expect(folderTrustStatusLabel(status({ record: { decision: "reject", decidedAt: 1, source: "card" } }))).toBe("Not trusted");
    expect(folderTrustStatusLabel(status({ upstreamTrusted: true, record: { decision: "reject", decidedAt: 1, source: "card" } }))).toContain("Trusted by your own Fuigo install");
    expect(folderTrustStatusLabel(status({ sources: [] }))).toBe("Nothing to trust here yet");
    expect(folderTrustStatusLabel(status({ gated: false }))).toBe("Nothing to trust here yet");
  });

  // FUIGOTRUST4 (2): a turn that would be refused consults no store; the
  // note must say the refusal, not "no upstream store"
  it("names a refused turn and an engine that gates nothing, before any trust verdict", () => {
    const refused = status({ refused: "Selected provider connection is disabled or unavailable", upstreamStore: "none", engineGates: false, instanceId: null, record: { decision: "trust", decidedAt: 1, source: "picker" } });
    expect(folderTrustStatusLabel(refused)).toBe("This bot's turns would not start: Selected provider connection is disabled or unavailable");
    expect(folderTrustStatusKind(refused)).toBe("refused");
    const cloud = status({ upstreamStore: "none", engineGates: false, instanceId: "computer", upstreamTrusted: false });
    expect(folderTrustStatusLabel(cloud)).toBe("Not gated by this bot's engine — the folder's files apply as they always did");
    expect(folderTrustStatusKind(cloud)).toBe("not-gated");
    // an older server without the fields: the FUIGOTRUST3 verdicts, unchanged
    const legacy: FolderTrustStatus = { gated: true, sources: ["AGENTS.md"], record: null, upstreamTrusted: true };
    expect(folderTrustStatusKind(legacy)).toBe("upstream");
  });
});

describe("folderTrustVerdicts", () => {
  it("describes a room once when every member's turn resolves the folder the same way", () => {
    const a = result("Ada", { upstreamTrusted: true });
    const b = result("Bob", { upstreamTrusted: true });
    expect(folderTrustVerdicts([a, b])).toEqual({ shared: a, perMember: [] });
    const html = render([a, b]);
    expect(html).toContain("Trusted by your own Fuigo install");
    expect(html).not.toContain("Per member");
    expect(html).not.toContain("Ada:");
  });

  it("lists each member's own verdict when they differ: a routed member runs without the user's store while a native one runs trusted", () => {
    const native = result("Ada", { upstreamTrusted: true, upstreamStore: "own" });
    const routed = result("Bob", { upstreamTrusted: false, upstreamStore: "temporary" });
    const otherHome = result("Cy", { upstreamTrusted: false, upstreamStore: "own", instanceId: "fuigo-other-home", record: { decision: "reject", decidedAt: 1, source: "card" } });
    expect(folderTrustVerdicts([native, routed, otherHome])).toEqual({ shared: null, perMember: [native, routed, otherHome] });
    const html = render([native, routed, otherHome]);
    expect(html).toContain("Per member — each member&#x27;s own engine decides:");
    expect(html).toContain('data-folder-trust-status="per-member"');
    // each member, by name, with its own verdict — the first member's is
    // never shown as the room's
    expect(html).toMatch(/data-folder-trust-status="upstream" data-folder-trust-member="Ada"[^<]*<svg.*?<\/svg><span[^>]*>Ada:<\/span>Trusted by your own Fuigo install/);
    expect(html).toMatch(/data-folder-trust-status="undecided" data-folder-trust-member="Bob"/);
    expect(html).toContain("Bob:</span>Not decided yet — the first turn here will ask");
    expect(html).toMatch(/data-folder-trust-status="reject" data-folder-trust-member="Cy"/);
    expect(html).toContain("Cy:</span>Not trusted");
    // one Forget for the record that exists, and the sources line once
    expect(html.match(/>Forget</g)).toHaveLength(1);
    expect(html.match(/font-mono[^>]*>AGENTS\.md</g)).toHaveLength(1);
  });

  it("differs on the engine instance alone: two members on different Fuigo installs are two verdicts even when both say undecided", () => {
    const one = result("Ada", { instanceId: "fuigo" });
    const two = result("Bob", { instanceId: "fuigo-other-home" });
    expect(folderTrustVerdicts([one, two]).perMember).toHaveLength(2);
    expect(folderTrustVerdicts([one, result("Bob", { instanceId: "fuigo" })]).perMember).toHaveLength(0);
  });

  it("a room without Fuigo members, or nothing fetched yet, shows only the picker sentence", () => {
    for (const html of [render([]), render(null), renderAt(undefined, [result("Ada")])]) {
      expect(html).toContain("A folder you choose here is trusted");
      expect(html).not.toContain("data-folder-trust-status");
      expect(html).not.toContain("Forget");
    }
  });

  it("a single bot's picker renders one verdict with Forget when Murage remembers the folder", () => {
    const html = render([{ subject: { id: "b1", name: "" }, status: status({ record: { decision: "trust", decidedAt: 1, source: "picker" } }) }]);
    expect(html).toContain('data-folder-trust-status="trust"');
    expect(html).toContain(">Trusted<");
    expect(html).toContain(">Forget<");
    expect(html).not.toContain("Per member");
  });
});

describe("where it is rendered", () => {
  const group = read("./GroupView.tsx");
  const settings = read("./SettingsPanel.tsx");
  const note = read("./FolderTrustNote.tsx");

  it("a room passes its Fuigo members, chosen by the engine their selection runs on; a bot's settings pass the bot", () => {
    expect(group).toContain("<FolderTrustNote folder={shownCwd} members={fuigoMembers} />");
    expect(group).toContain('i.driverKind === "fuigoAgent"');
    expect(settings).toContain("<FolderTrustNote folder={bot.cwd} botId={bot.id} />");
  });

  it("asks the server about each subject and forgets per subject, so a card's record under a bot's engine key is reached", () => {
    expect(note).toContain("Promise.all(subjects.map(query))");
    expect(note).toContain("&bot=${encodeURIComponent(id)}`, { method: \"DELETE\" }");
  });
});
