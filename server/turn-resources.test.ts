import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { admissionComputerClaims, TurnResources, unusedComputerClaims, workspaceResource } from "./turn-resources.ts";

const a = { threadId: "a", generation: "1" }, b = { threadId: "b", generation: "2" };
it("holds shared resources for one generation and admits independent resources", () => {
  const leases = new TurnResources();
  expect(leases.claim("computer:host", a)).toBe(true);
  expect(leases.claim("computer:host", a)).toBe(true);
  expect(leases.claim("computer:host", b)).toBe(false);
  expect(leases.claim("browser:other", b)).toBe(true);
  leases.release(a);
  expect(leases.claim("computer:host", b)).toBe(true);
  leases.release(a);
  expect(leases.owns("computer:host", b)).toBe(true);
});
it("does not retain partial claims or let a stale generation release the replacement", () => {
  const leases = new TurnResources();
  leases.claim("computer:host", a);
  expect(leases.claimAll(["browser:one", "computer:host"], b)).toBe(false);
  expect(leases.owns("browser:one", b)).toBe(false);
  const next = { ...a, generation: "next" };
  expect(leases.claim("computer:host", next)).toBe(false);
  leases.release(a);expect(leases.claim("computer:host", next)).toBe(true);
  leases.release(a);expect(leases.owns("computer:host", next)).toBe(true);
});
it("serializes ancestor and symlink workspaces while allowing siblings", () => {
  const root = mkdtempSync(join(tmpdir(), "murage-thread-resources-"));
  try {
    mkdirSync(join(root, "Project", "nested"), { recursive: true });mkdirSync(join(root, "sibling"));
    symlinkSync(join(root, "Project"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    const leases = new TurnResources();
    expect(leases.claim(workspaceResource(join(root, "Project")), a)).toBe(true);
    expect(leases.claim(workspaceResource(join(root, "alias")), b)).toBe(false);
    expect(leases.claim(workspaceResource(join(root, "Project", "nested")), b)).toBe(false);
    expect(leases.claim(workspaceResource(root), b)).toBe(false);
    expect(leases.claim(workspaceResource(join(root, "sibling")), b)).toBe(true);
    if (existsSync(join(root, "project"))) expect(workspaceResource(join(root, "project"))).toBe(workspaceResource(join(root, "Project")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("reports what a generation holds and who blocks a request, for release-then-wait", () => {
  const leases = new TurnResources();
  leases.claimAll(["workspace:/a/project", "screen:bot:x"], a);
  expect(leases.heldBy(a).sort()).toEqual(["screen:bot:x", "workspace:/a/project"]);
  expect(leases.heldBy(b)).toEqual([]);
  expect(leases.conflicts(["workspace:/a/project/nested", "browser:free", "screen:bot:x"], b))
    .toEqual([{ resource: "workspace:/a/project/nested", owner: a }, { resource: "screen:bot:x", owner: a }]);
  expect(leases.conflicts(["screen:bot:x"], a)).toEqual([]);
  leases.release(a);
  expect(leases.heldBy(a)).toEqual([]);
});

// W14: a turn claims the bot's computer and screen before it knows which
// destination it will resolve to, so it has to be able to give back what it
// did not use. Releasing everything would drop the working folder with it.
it("hands back only the named resources this generation holds", () => {
  const leases = new TurnResources();
  expect(leases.claimAll(["computer:bot:x", "screen:bot:x", "workspace:/project"], a)).toBe(true);
  expect(leases.releaseSome(a, ["computer:bot:x", "screen:bot:x"])).toEqual(["computer:bot:x", "screen:bot:x"]);
  expect(leases.owns("workspace:/project", a)).toBe(true);
  expect(leases.claim("computer:bot:x", b)).toBe(true);
});
it("never lets one generation release another's claim", () => {
  const leases = new TurnResources();
  leases.claim("computer:bot:x", a);
  expect(leases.releaseSome(b, ["computer:bot:x"])).toEqual([]);
  expect(leases.owns("computer:bot:x", a)).toBe(true);
});

// The admission boundary. An explicit destination is known here; Auto is not.
it("claims the bot's computer and screen for an explicit destination", () => {
  const auto = { autoCloudPossible: false, autoHostScreenPossible: false };
  expect(admissionComputerClaims({ botId: "x", wants: "cloud", ...auto })).toEqual(["computer:bot:x", "screen:bot:x"]);
  expect(admissionComputerClaims({ botId: "x", wants: "vm", ...auto })).toEqual(["computer:vm", "screen:bot:x"]);
  // host tools are arbitrated per action by the broker, never reserved
  expect(admissionComputerClaims({ botId: "x", wants: "local", ...auto })).toEqual(["screen:bot:x"]);
  expect(admissionComputerClaims({ botId: "x", wants: "off", ...auto })).toEqual([]);
  expect(admissionComputerClaims({ botId: "x", wants: "browser", ...auto })).toEqual([]);
});

// The defect: Auto resolves to an existing box or a reachable VPS LATER, and
// used to claim nothing for either — so two Auto threads of the same bot could
// mount the same box and drive the same screen at the same time.
it("claims the bot's computer for Auto when a cloud destination is still reachable", () => {
  expect(admissionComputerClaims({ botId: "x", wants: undefined, autoCloudPossible: true, autoHostScreenPossible: false }))
    .toEqual(["computer:bot:x", "screen:bot:x"]);
});
it("claims only the screen for Auto that can reach nothing but the host", () => {
  expect(admissionComputerClaims({ botId: "x", wants: undefined, autoCloudPossible: false, autoHostScreenPossible: true }))
    .toEqual(["screen:bot:x"]);
});
it("claims nothing for Auto with no destination within reach", () => {
  expect(admissionComputerClaims({ botId: "x", wants: undefined, autoCloudPossible: false, autoHostScreenPossible: false }))
    .toEqual([]);
});

// The other half: what an optimistic claim must give back once the
// destination has resolved, so a sibling thread is not queued for the rest of
// the turn behind a computer nobody mounted.
const autoClaimed = ["computer:bot:x", "screen:bot:x"];
it("gives back the whole pair when Auto mounted nothing", () => {
  expect(unusedComputerClaims({ botId: "x", claimed: autoClaimed, mountedKind: null, previewRouted: false, browserHoldsScreen: false }))
    .toEqual(["computer:bot:x", "screen:bot:x"]);
});
it("keeps both once a bot-scoped computer is mounted", () => {
  for (const mountedKind of ["box", "vps", "vm"] as const) {
    expect(unusedComputerClaims({ botId: "x", claimed: autoClaimed, mountedKind, previewRouted: true, browserHoldsScreen: false }))
      .toEqual([]);
  }
});
it("gives back the computer but keeps the screen when Auto fell back to the host", () => {
  expect(unusedComputerClaims({ botId: "x", claimed: autoClaimed, mountedKind: "local", previewRouted: false, browserHoldsScreen: false }))
    .toEqual(["computer:bot:x"]);
});
it("keeps a screen that a preview or the browser is still routing", () => {
  expect(unusedComputerClaims({ botId: "x", claimed: autoClaimed, mountedKind: null, previewRouted: true, browserHoldsScreen: false }))
    .toEqual(["computer:bot:x"]);
  expect(unusedComputerClaims({ botId: "x", claimed: autoClaimed, mountedKind: null, previewRouted: false, browserHoldsScreen: true }))
    .toEqual(["computer:bot:x"]);
});
it("never gives back a claim this turn never made", () => {
  expect(unusedComputerClaims({ botId: "x", claimed: [], mountedKind: null, previewRouted: false, browserHoldsScreen: false }))
    .toEqual([]);
  expect(unusedComputerClaims({ botId: "x", claimed: ["screen:bot:x"], mountedKind: null, previewRouted: false, browserHoldsScreen: false }))
    .toEqual(["screen:bot:x"]);
});

// The wiring, pinned at the source: the helpers above are only worth anything
// if startTurn actually admits through them and hands back afterwards.
// Comments are stripped first so this matches code, never prose; only
// whole-line comments go, so a URL's "//" is never mistaken for one.
it("startTurn admits through the claim boundary and releases what it did not mount", () => {
  const code = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  expect(code).toContain("admissionComputerClaims({ botId: bot.id, wants, autoCloudPossible, autoHostScreenPossible })");
  expect(code).toContain("unusedComputerClaims({");
  expect(code).toContain("directRuns.releaseResources(run, giveBack)");
  // and the wait that had no deadline now has one
  expect(code).toContain("RESOURCE_WAIT_TIMEOUT_MS");
});
