// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NL-CARD-1018 (legs seat, z42 package, real Linux): a real owner turn at No limits, `bash ./build.sh` in the bot's folder, showed an
// "Approval needed" card (held=unread why=unseen-script outside=outside-tool). The turn was marked "outside tool" 1.5 s after it
// started, before any engine item: the Claude process lists the browser's tools at startup (POST /api/internal/unified-browser
// {"method":"tools/list"}) and the own-tool gate marked every route it had no table row for. Listing tools touches nothing and
// brings nothing in. Acting calls on the same mounts still mark.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { autoVerdict } from "./auto-approve.ts";
import { beginOutsideTurn, forgetOutsideState, turnOutsideRead, wireOutsideStore } from "./email/external-marks.ts";
import { fileOutsideStore } from "./outside-store.ts";
import { LISTING_RPC_MOUNTS, STATUS_GET_MOUNTS, ownToolGate, ownToolOfRoute } from "./outside-own.ts";

type Context = Parameters<typeof autoVerdict>[3];
const NO_LIMITS = { id: "owned", autoApprove: true, fullAccess: true, noLimits: true };

describe("NL-CARD-1018 a listing call on an acting mount is not a tool", () => {
  afterEach(() => forgetOutsideState());
  it("names no tool for tools/list on the JSON-RPC mounts and for the status GETs", () => {
    for (const path of LISTING_RPC_MOUNTS) expect(ownToolOfRoute("POST", path, { method: "tools/list" }), path).toBe("");
    for (const path of STATUS_GET_MOUNTS) expect(ownToolOfRoute("GET", path), path).toBe("");
  });
  it("keeps every acting call a route that marks", () => {
    for (const path of LISTING_RPC_MOUNTS) {
      expect(ownToolOfRoute("POST", path, { method: "tools/call", params: { name: "navigate" } }), path).toBe(`route:${path}`);
      expect(ownToolOfRoute("POST", path), path).toBe(`route:${path}`);
      expect(ownToolOfRoute("POST", path, { method: "tools/list-and-more" }), path).toBe(`route:${path}`);
      expect(ownToolOfRoute("GET", path, { method: "tools/list" }), path).toBe(`route:${path}`);
    }
    for (const path of STATUS_GET_MOUNTS) {
      expect(ownToolOfRoute("POST", path), path).toBe(`route:${path}`);
      expect(ownToolOfRoute("DELETE", path), path).toBe(`route:${path}`);
    }
    expect(ownToolOfRoute("POST", "/api/internal/headless-browser", { method: "tools/list" })).toBe("route:/api/internal/headless-browser");
    expect(ownToolOfRoute("POST", "/api/internal/mcp-remote/x", { method: "tools/list" })).toBe("route:/api/internal/mcp-remote/x");
  });
  it("the own-tool gate leaves a clean turn clean after a tools/list, and an acting call still marks it", () => {
    expect(wireOutsideStore(fileOutsideStore(join(mkdtempSync(join(tmpdir(), "nlcard-store-")), "outside-state.jsonl")), () => 0)).toBe(true);
    beginOutsideTurn("t1", "i", undefined, false);
    expect(turnOutsideRead("t1")).toBeNull();
    const list = ownToolOfRoute("POST", "/api/internal/unified-browser", { method: "tools/list" });
    expect(ownToolGate({ threadId: "t1", botId: "b1", tool: list, lane: true })).toBeNull();
    expect(turnOutsideRead("t1")).toBeNull();
    const act = ownToolOfRoute("POST", "/api/internal/unified-browser", { method: "tools/call" });
    expect(ownToolGate({ threadId: "t1", botId: "b1", tool: act, lane: true })).toBeNull();
    expect(turnOutsideRead("t1")).toBe("outside tool");
  });
});

describe("NL-CARD-1018 the exact turn: owner-clean No limits, bash ./build.sh in the bot's folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "nlcard-"));
  writeFileSync(join(dir, "build.sh"), "#!/bin/bash\necho NL-MARK > out.txt\n");
  const turn = (extra: object) => autoVerdict(NO_LIMITS as never, "Bash", "bash ./build.sh", {
    fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null, commandText: "bash ./build.sh", commandCwd: dir, workFolder: dir, ...extra,
  } as unknown as Context);
  it("runs with no card when the turn is clean", () => {
    expect(turn({}).approve).toBe("auto-approved Bash (no limits)");
  });
  // NOLIM 1.0.19 (N1, N2.4): the owner's work runs whether or not the turn is marked or cut; the finalizer reads the STORED origin only.
  // Only work no longer provably the owner's (unattended here) keeps its card.
  it("runs on a marked turn (a real outside source), the owner's work without a start proof, or a cut input; unattended work still cards", () => {
    expect(turn({ outsideRead: ["outside tool"] }).approve).toBeTruthy();
    expect(turn({ outsideRead: ["web page"] }).approve).toBeTruthy();
    expect(turn({ ownerStarted: false }).approve).toBeTruthy();
    expect(turn({ inputTruncated: true }).approve).toBeTruthy();
    expect(turn({ unattended: true }).approve).toBeNull();
  });
});
