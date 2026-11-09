// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NLINT-FIX4 (1.0.18): the four Mediums Astra A found in the No limits line, each red first with a named test:
// B1 a continuation-split `-C` root move, B2 external readers on a marked turn, B3 a taint that did not save, B4 the lane hold
// after a restart (B4 lives in email/send-service.test.ts). Fixture strings are inert data, never executed.
import { removeTempDirSync } from "./testing/cleanup.ts";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
const { outsideScanMarks, readOnlyShape } = await import("./outside-scan.ts");
let marks = await import("./email/external-marks.ts");
let wire = await import("./outside-wire.ts");
let { noteEnginePath, forgetEngineEnv } = await import("./outside-scan.ts");

beforeEach(async () => {
  vi.resetModules();
  marks = await import("./email/external-marks.ts");
  wire = await import("./outside-wire.ts");
  ({ noteEnginePath, forgetEngineEnv } = await import("./outside-scan.ts"));
});

type Loaded = ReturnType<import("./email/external-marks.ts").OutsideStore["load"]>;
function store(initial: Partial<Loaded> = {}, setSession?: import("./email/external-marks.ts").OutsideStore["setSession"]): import("./email/external-marks.ts").OutsideStore {
  return {
    load: () => ({ opens: [], marks: [], sessions: [], markedTurns: [], outsideSince: 1, ...initial }) as Loaded,
    openTurn() {}, seal() {}, setMark() {}, clearMark() {}, setSession: setSession ?? (() => {}), addSessionEdits() {}, addMarkedTurn() {}, setOutsideSince() {},
    loadRegistry: () => [], writeRegistry() {},
  };
}

describe("NLINT-FIX4 B1: a backslash-newline inside a root option cannot hide the -C move", () => {
  const hooks = { cwd: "/w", home: "/h" };
  it("B1 pnpm -\\<newline>C /other run build marks like the one-line form", () => {
    const plain = outsideScanMarks("pnpm -C /other run build", hooks);
    expect(plain).toContain("interpreter");
    expect(outsideScanMarks("pnpm -\\\nC /other run build", hooks)).toEqual(plain);
  });
});

describe("NLINT-FIX4 B2: an external reader on a marked turn gets the read-only allowance from the thread's PATH", () => {
  afterEach(() => { marks.forgetAllTurnMarks(); forgetEngineEnv(); });
  it("B2 ls is read-only when the thread's noted PATH holds it, and the write is not recorded", () => {
    marks.wireOutsideStore(store());
    noteEnginePath("t1", "/usr/bin:/bin");
    marks.beginOutsideTurn("t1", "i1", "turn-a", false);
    const fields = wire.outsideContextFields("t1", "/w");
    expect(readOnlyShape("ls -la", fields.readOnlyHooks)).toBe(true);
  });
  it("B2 a thread whose PATH was never noted stays not read-only (fail closed)", () => {
    marks.wireOutsideStore(store());
    marks.beginOutsideTurn("t2", "i2", "turn-a", false);
    const fields = wire.outsideContextFields("t2", "/w");
    expect(readOnlyShape("ls -la", fields.readOnlyHooks)).toBe(false);
  });
});

describe("NLINT-FIX4 B2 (Astra B): the program is judged by its realpath", () => {
  afterEach(() => { marks.forgetAllTurnMarks(); forgetEngineEnv(); });
  const rig = (link: (bin: string, work: string, outside: string) => void) => {
    const root = mkdtempSync(join(tmpdir(), "nlint-b2-"));
    const [bin, work, outside] = ["bin", "work", "outside"].map((d) => { const dir = join(root, d); mkdirSync(dir); return dir; });
    link(bin, work, outside);
    marks.wireOutsideStore(store());
    noteEnginePath("t3", bin);
    marks.beginOutsideTurn("t3", "i3", "turn-a", false);
    return { root, work, hooks: wire.outsideContextFields("t3", work).readOnlyHooks };
  };
  it("B2 a PATH ls that is a link to a script in the work folder is not read-only", () => {
    const r = rig((bin, work) => { writeFileSync(join(work, "evil.sh"), "#!/bin/sh\n", { mode: 0o755 }); symlinkSync(join(work, "evil.sh"), join(bin, "ls")); });
    try { expect(readOnlyShape("ls -la", r.hooks)).toBe(false); } finally { removeTempDirSync(r.root); }
  });
  it("B2 control: a PATH ls that is a link to a program outside the work folder is still read-only", () => {
    const r = rig((bin, _work, outside) => { writeFileSync(join(outside, "ls-real"), "#!/bin/sh\n", { mode: 0o755 }); symlinkSync(join(outside, "ls-real"), join(bin, "ls")); });
    try { expect(readOnlyShape("ls -la", r.hooks)).toBe(true); } finally { removeTempDirSync(r.root); }
  });
});

describe("NLINT-FIX4 own-tool classes: HighLevel and phone stay outside actions", () => {
  afterEach(() => marks.forgetAllTurnMarks());
  it("every HighLevel read or helper tool and the highlevel/mcp route mark the turn; none is clean-listed", async () => {
    const own = await import("./outside-own.ts");
    const { HIGHLEVEL_READ_TOOL_NAMES, HIGHLEVEL_HELPER_NAMES } = await import("../shared/highlevel.ts");
    marks.wireOutsideStore(store());
    const tools = [...HIGHLEVEL_READ_TOOL_NAMES, ...HIGHLEVEL_HELPER_NAMES, own.ownToolOfRoute("POST", "/api/internal/highlevel/mcp"), own.ownToolOfRoute("GET", "/api/internal/highlevel/mcp")];
    for (const tool of tools) {
      expect(own.OWN_READ_CLEAN_TOOLS, tool).not.toContain(tool);
      marks.beginOutsideTurn("t1", "i1", `turn-${tool}`, false);
      expect(own.ownToolGate({ threadId: "t1", botId: "b1", tool, lane: false }), tool).toBeNull();
      expect(marks.turnOutsideRead("t1"), tool).not.toBeNull();
    }
  });
  it("the phone route marks the turn, and a phone call on a marked lane turn is refused", async () => {
    const own = await import("./outside-own.ts");
    marks.wireOutsideStore(store());
    marks.beginOutsideTurn("t1", "i1", "turn-a", false);
    expect(own.ownToolGate({ threadId: "t1", botId: "b1", tool: own.ownToolOfRoute("POST", "/api/internal/phone/"), lane: false })).toBeNull();
    expect(marks.turnOutsideRead("t1")).not.toBeNull();
    marks.beginOutsideTurn("t2", "i2", "turn-b", false);
    marks.markTurnOutside("t2", "web page");
    expect(own.ownToolGate({ threadId: "t2", botId: "b1", tool: "phone_call_dial", lane: true })).toEqual({ refuse: expect.any(String) });
  });
});

describe("NLINT-FIX4 B3: a taint that could not be saved fails closed", () => {
  afterEach(() => marks.forgetAllTurnMarks());
  it("B3 a failed tainted-session write leaves the store not ready: every turn reads as marked", () => {
    marks.wireOutsideStore(store({}, (row) => { if (row.tainted) throw new Error("busy"); }));
    marks.beginOutsideTurn("t1", "i1", "turn-a", false);
    marks.markTurnOutside("t1", "web page");
    expect(marks.outsideReady()).toBe(false);
    expect(marks.turnOutsideRead("t2")).toBe("outside tool");
  });
  it("B3 after a restart a clean session record whose thread has a marked turn begun since it started resumes tainted", () => {
    marks.wireOutsideStore(store({
      sessions: [
        { threadId: "t1", instanceId: "i1", tainted: false, wrote: false, edits: [], startedAt: 100 },
        { threadId: "t2", instanceId: "i2", tainted: false, wrote: false, edits: [], startedAt: 200 },
      ],
      markedTurns: [{ threadId: "t1", turnId: "a", at: 150, begunAt: 120 }, { threadId: "t2", turnId: "b", at: 150, begunAt: 120 }],
    }));
    expect(marks.sessionTainted("t1", "i1")).toBe(true);
    expect(marks.sessionTainted("t2", "i2")).toBe(false);
  });
});
