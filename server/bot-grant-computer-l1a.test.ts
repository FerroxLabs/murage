// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-L1A-1013, designs/L1A-GRANT-AUTHORITY-1013.md (revision 2, Astra AGREE):
// a bot-level or task-level "Always" grant is the owner's computer's alone.
// `isOwnersComputer` is the local desktop app with its renderer secret proven;
// on a Cloud home NO surface is the computer (not the phone, not the passkey
// browser, not owner-desktop, whose ticket kind its caller chooses). Every
// enumerated request writer (B1 save, B2 Undo, B3 remove, B4 task refresh
// preview and apply, B5 PATCH alwaysAllow, and /api/config's `computer`) is
// checked against {local computer, Cloud phone, Cloud passkey browser, Cloud
// owner-desktop, peer}. B9 (MCP server removal drops that mount's grants) is a
// subtractive lifecycle exception, pinned below. Section 4: both respond
// routes check the task row before any branch can answer.
// The index.ts wiring checks are RED until handoffs/INDEX-PATCH-1013-UX-L1A.diff
// is applied (the integrator diff), like route-policy-l1a.test.ts.
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { acpToolKey } from "../shared/mount-identity.ts";
import { botAlwaysAllowSave, botAlwaysAllowUndo, taskGrantRefusal, type BotGrantDeps, type BotUndoDeps } from "./approval-grant-routes.ts";
import { isDesktopApp, isOwnersComputer } from "./cloud-owner-surface.ts";
import { setCloudIdentity } from "./cloud-request-identity.ts";
import type { CloudDevice } from "./cloud-sessions.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { COMPANION_HEADER, desktopSurfaceSecret, SURFACE_HEADER, SURFACE_SECRET_HEADER } from "./sse-visibility.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const here = dirname(fileURLToPath(import.meta.url));
afterEach(() => vi.unstubAllEnvs());

type Headers = Record<string, string>;
const P256 = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "pem" }).toString();
const cloud = (scope: string, extra: Record<string, unknown> = {}): Headers => {
  const headers = {};
  setCloudIdentity(headers, { id: "d1", account: "owner", scope, revoked: false, ...extra } as unknown as CloudDevice);
  return headers;
};
const proven = (): Headers => ({ [SURFACE_HEADER]: "desktop", [SURFACE_SECRET_HEADER]: desktopSurfaceSecret() });

/** Each surface: whether it runs on a Cloud home, its headers, and whether it is the owner's computer. */
const SURFACES: { name: string; home: boolean; headers: () => Headers; computer: boolean }[] = [
  { name: "local computer (renderer secret proven)", home: false, headers: proven, computer: true },
  { name: "Cloud phone (owner-phone)", home: true, headers: () => cloud("owner-phone"), computer: false },
  { name: "Cloud passkey browser", home: true, headers: () => cloud("browser", { factor: "passkey", publicKey: P256, assertionKey: P256 }), computer: false },
  { name: "Cloud remembered owner browser", home: true, headers: () => cloud("browser", { factor: "remembered-owner", publicKey: P256, assertionKey: P256 }), computer: false },
  { name: "Cloud owner-desktop", home: true, headers: () => cloud("owner-desktop"), computer: false },
  { name: "Cloud owner-desktop with a local desktop proof", home: true, headers: () => ({ ...cloud("owner-desktop"), ...proven() }), computer: false },
  { name: "peer: unmarked local request", home: false, headers: () => ({}), computer: false },
  { name: "peer: companion-marked phone with the proof", home: false, headers: () => ({ ...proven(), [COMPANION_HEADER]: "1" }), computer: false },
  { name: "peer: desktop marker without the secret", home: false, headers: () => ({ [SURFACE_HEADER]: "desktop" }), computer: false },
  { name: "peer: desktop marker with a wrong secret", home: false, headers: () => ({ [SURFACE_HEADER]: "desktop", [SURFACE_SECRET_HEADER]: "0".repeat(64) }), computer: false },
];
const as = (surface: (typeof SURFACES)[number]): Headers => {
  if (surface.home) vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  else vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  return surface.headers();
};

const saveDeps = (desktop: boolean): BotGrantDeps & { calls: string[] } => {
  const calls: string[] = [];
  const touch = (name: string) => () => { calls.push(name); throw new Error(`${name} must not run`); };
  return {
    calls, desktop,
    readBody: vi.fn(async () => { calls.push("readBody"); return { allowKey: "Bash:git", requestId: "r1", threadId: "t1" }; }),
    botName: () => { calls.push("botName"); return undefined; },
    isTask: touch("isTask"), roomHas: touch("roomHas"), directThread: touch("directThread"), pendingCard: touch("pendingCard"),
    routineName: touch("routineName"), remember: touch("remember") as never, plan: touch("plan"), write: touch("write"), publish: touch("publish"),
  };
};
const undoDeps = (desktop: boolean): BotUndoDeps & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls, desktop,
    readBody: async () => { calls.push("readBody"); return { bot: ["Bash:git"], task: [] }; },
    botName: () => { calls.push("botName"); return undefined; },
    isTask: () => { calls.push("isTask"); return false; },
    remove: () => { calls.push("remove"); throw new Error("remove must not run"); },
    publish: () => { calls.push("publish"); return {}; },
  };
};

const source = readFileSync(join(here, "index.ts"), "utf8");
const after = (marker: string, length: number): string => {
  const at = source.indexOf(marker);
  expect(at, marker).toBeGreaterThan(-1);
  return source.slice(at, at + length);
};
/** One route's handler: from its path.match line to the next route's. */
const route = (marker: string): string => {
  const at = source.indexOf(marker);
  expect(at, marker).toBeGreaterThan(-1);
  const next = source.indexOf("\n    m = path.match(", at + marker.length);
  return source.slice(at, next > at ? next : at + 20000);
};
const GATE = "isOwnersComputer(req.headers, url.searchParams)";

/** The index.ts gate of each enumerated writer that is not a pure handler: it asks the predicate, and nothing else. */
const WIRED: { writer: string; gate: () => string }[] = [
  { writer: "B3 remove (Settings take-back)", gate: () => after("m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/always-allow\\/remove$/);", 400) },
  { writer: "B4 task refresh, preview and apply", gate: () => after("m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/tasks\\/([\\w-]+)\\/permissions\\/refresh$/);", 400) },
  { writer: "B5 PATCH /api/bots/:id with alwaysAllow", gate: () => { const at = source.indexOf("if (body.alwaysAllow !== undefined && !isOwnersComputer("); expect(at).toBeGreaterThan(-1); return source.slice(at, at + 200); } },
  { writer: "/api/config computer", gate: () => after('if (method === "GET" && path === "/api/config") {', 900) },
];

describe.each(SURFACES)("$name", (surface) => {
  it(`is ${surface.computer ? "" : "not "}the owner's computer`, () => {
    expect(isOwnersComputer(as(surface))).toBe(surface.computer);
  });

  it("B1 save: the computer passes the gate; anything else is 404 before the body is read", async () => {
    const deps = saveDeps(isOwnersComputer(as(surface)));
    const reply = await botAlwaysAllowSave(deps, "b1", {});
    if (surface.computer) {
      expect(reply.status).toBe(404); // past the gate: the fake has no such bot
      expect(deps.calls).toEqual(["readBody", "botName"]);
    } else {
      expect(reply).toEqual({ status: 404, body: { error: "no such route" } });
      expect(deps.calls).toEqual([]);
    }
  });

  it("B2 Undo: the computer passes the gate; anything else is 404 before the body is read", async () => {
    const deps = undoDeps(isOwnersComputer(as(surface)));
    const reply = await botAlwaysAllowUndo(deps, "b1");
    if (surface.computer) {
      expect(reply).toEqual({ status: 404, body: { error: "no such bot" } });
      expect(deps.calls).toEqual(["botName"]);
    } else {
      expect(reply).toEqual({ status: 404, body: { error: "no such route" } });
      expect(deps.calls).toEqual([]);
    }
  });

  it.each(WIRED)("$writer asks the owner's computer, which answers this surface accordingly", ({ gate }) => {
    expect(gate()).toContain(GATE);
    expect(isOwnersComputer(as(surface))).toBe(surface.computer);
  });
});

describe("on a Cloud home, isDesktopApp still admits the owner-desktop for other handlers; the grant predicate does not", () => {
  beforeEach(() => vi.stubEnv("MURAGE_CLOUD_ROLE", "home"));
  it("owner-desktop", () => {
    expect(isDesktopApp(cloud("owner-desktop"))).toBe(true);
    expect(isOwnersComputer(cloud("owner-desktop"))).toBe(false);
  });
});

describe("index.ts: every enumerated writer asks isOwnersComputer and no older gate (integrator diff)", () => {
  it("B1 save and B2 Undo hand the predicate to the handler", () => {
    for (const marker of ["m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/always-allow$/);", "m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/always-allow\\/undo$/);"]) {
      const text = after(marker, 300);
      expect(text).toContain(`desktop: ${GATE},`);
      expect(text).not.toContain("isDesktopApp(");
      expect(text).not.toContain("requestSurface(");
    }
  });
  it("B3 and B4 refuse first, with no requestSurface or isDesktopApp gate left", () => {
    for (const { gate } of WIRED.slice(0, 2)) {
      const text = gate();
      expect(text).toMatch(new RegExp(`if \\(m && method === "POST"\\) \\{\\n(?:\\s*//[^\\n]*\\n)*\\s*if \\(!isOwnersComputer\\(req\\.headers, url\\.searchParams\\)\\) return json\\(res, 404`));
      expect(text).not.toContain("isDesktopApp(");
      expect(text).not.toContain("requestSurface(");
    }
  });
  it("B5 is refused right after body validation, before the bot's turn is taken or any patch is built", () => {
    const gateAt = source.indexOf("if (body.alwaysAllow !== undefined && !isOwnersComputer(req.headers, url.searchParams)) return json(res, 404");
    expect(gateAt).toBeGreaterThan(-1);
    const patchAt = source.lastIndexOf('if (m && method === "PATCH") {', gateAt);
    expect(gateAt - patchAt).toBeLessThan(500); // right after the body validation of the handler's first lines
    for (const later of ["const patchBotId = m[1]!;", "const patch: Record<string, unknown> = {};", "patch.alwaysAllow ="]) {
      expect(source.indexOf(later, patchAt), later).toBeGreaterThan(gateAt);
    }
  });
  it("/api/config says computer from the predicate", () => {
    expect(WIRED[3]!.gate()).toContain(`computer: ${GATE} });`);
  });
});

describe("B9: removing, renaming or re-pointing an MCP server only drops that mount's grants (subtractive lifecycle exception)", () => {
  it("each drop names the server's own mount and nothing from the body", () => {
    const calls = [...source.matchAll(/store\.dropMountGrants\(([^)]*)\)/g)].map((match) => match[1]);
    expect(calls.length).toBe(3);
    for (const arg of calls) expect(arg).toBe("`custom:${name}`");
  });

  const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
  beforeEach(() => { removeTempDirSync(DATA_DIR); });
  it("the store's drop never adds, widens or moves a key, and leaves other mounts", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const task = store.createTask(bot.id, undefined, false)!;
    const gone = acpToolKey("custom:github", "create_issue");
    const kept = acpToolKey("custom:linear", "create_issue");
    store.patchBot(bot.id, { alwaysAllow: [gone, kept, "Grep"] }, { preserveTaskSettings: true });
    store.patchTask(bot.id, task.threadId, { alwaysAllow: [gone, "Read"] });
    const before = { bot: [...store.bot(bot.id)!.alwaysAllow!], task: [...store.taskByThread(bot.id, task.threadId)!.alwaysAllow!] };
    expect(store.dropMountGrants("custom:github")).toBe(2);
    const afterBot = store.bot(bot.id)!.alwaysAllow!;
    const afterTask = store.taskByThread(bot.id, task.threadId)!.alwaysAllow!;
    expect(afterBot).toEqual([kept, "Grep"]);
    expect(afterTask).toEqual(["Read"]);
    for (const key of [...afterBot]) expect(before.bot).toContain(key);
    for (const key of [...afterTask]) expect(before.task).toContain(key);
    // a mount nobody holds changes nothing
    expect(store.dropMountGrants("custom:nobody")).toBe(0);
    expect(store.bot(bot.id)!.alwaysAllow).toEqual([kept, "Grep"]);
  });
});

describe("section 4: both respond routes check the task row before any branch can answer", () => {
  const ROUTES = [
    "m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/respond$/);",
    "m = path.match(/^\\/api\\/threads\\/([\\w-]+)\\/respond$/);",
  ];
  const ANSWERING = ["answerLimitCard(", "isEmailRequestId(", "resolveAndSendRoutine(", "answerAsSendReply(", "questionReply(", "resolvePeerComms(", "answerRequest("];
  it.each(ROUTES)("%s", (marker) => {
    const text = route(marker);
    const check = text.indexOf("taskGrantRefusal(");
    expect(check).toBeGreaterThan(-1);
    expect(text.indexOf("taskGrantRefusal(", check + 1)).toBe(-1); // the later duplicate is gone
    expect(check).toBeGreaterThan(text.indexOf("!mayApprove(req, url)"));
    let seen = 0;
    for (const branch of ANSWERING) {
      const at = text.indexOf(branch);
      if (at < 0) continue;
      seen++;
      expect(at, branch).toBeGreaterThan(check);
    }
    expect(seen).toBeGreaterThanOrEqual(5);
  });
  it("a peer-, extension- or host-consent-shaped card (no task row) is refused, never answered Allow once", () => {
    expect(taskGrantRefusal(undefined)).toBeTruthy();
    expect(taskGrantRefusal({ requestId: "r1" } as never)).toBeTruthy();
  });
});
