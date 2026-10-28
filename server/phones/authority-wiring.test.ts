// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Reads server/index.ts as text: the mint path stays singular and reachable only from the fresh idle entry.
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts"), "utf8");
const controlSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "control-murage.ts"), "utf8");
const lines = source.split("\n");
const lineOf = (needle: string): number => lines.findIndex((l) => l.includes(needle));
const countOf = (needle: string): number => source.split(needle).length - 1;

/** The text of a top-level function declaration, from its first line to the next top-level declaration. */
function bodyOf(header: string): string {
  const start = lineOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  let end = start + 1;
  while (end < lines.length && !/^(async function|function|interface|const|let|export|class|bus\.)\b/.test(lines[end]!)) end++;
  return lines.slice(start, end).join("\n");
}

describe("phone authority wiring in server/index.ts", () => {
  it("has exactly one phoneAuthorities.mint( call, followed within five lines by limitTurns.markPhoneHeld(", () => {
    // every occurrence, no exclusions: no test seam may mint
    expect(countOf("phoneAuthorities.mint(")).toBe(1);
    // S23: no phone test seam of any kind survives in the server or in the fixture launcher
    for (const text of [source, controlSource]) expect(text).not.toContain("MURAGE_TEST_PHONE_");
    const at = lines.findIndex((l) => l.includes("phoneAuthorities.mint(") && l.includes("turnId: userMessage.id"));
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at + 1, at + 6).some((l) => l.includes("limitTurns.markPhoneHeld("))).toBe(true);
  });

  it("mints inside startTurnAdmitting, after dispatchClaimId, and only with the ticket", () => {
    const body = bodyOf("async function startTurnAdmitting(");
    expect(body).toContain("phoneAuthorities.mint(");
    expect(body.indexOf("const dispatchClaimId = run.generation;")).toBeGreaterThan(-1);
    expect(body.indexOf("phoneAuthorities.mint(")).toBeGreaterThan(body.indexOf("const dispatchClaimId = run.generation;"));
    const guard = body.slice(body.indexOf("const dispatchClaimId = run.generation;"), body.indexOf("phoneAuthorities.mint("));
    for (const needle of ["opts?.phoneTicket === PHONE_TICKET", "automationSource === undefined", "delegationRun === undefined", "cardContinuation === undefined", "askerWake === undefined", "commsDepth", "unattended"]) {
      expect(guard).toContain(needle);
    }
  });

  it("PHONE_TICKET is declared once and used only in runIt and startTurnAdmitting", () => {
    const uses = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.includes("PHONE_TICKET"));
    const declaration = uses.filter(({ l }) => l.startsWith("const PHONE_TICKET"));
    expect(declaration).toHaveLength(1);
    const runItStart = lineOf("const runIt = async (entry?: typeof PHONE_IDLE_ENTRY)");
    const runItBody = lines.slice(runItStart, runItStart + 20).join("\n");
    const startTurnBody = bodyOf("async function startTurnAdmitting(");
    for (const { l, i } of uses) {
      if (l.startsWith("const PHONE_TICKET")) continue;
      const inRunIt = i >= runItStart && i < runItStart + 20 && runItBody.includes(l);
      const inStartTurn = startTurnBody.includes(l);
      expect(inRunIt || inStartTurn, `PHONE_TICKET escaped at line ${i + 1}: ${l.trim()}`).toBe(true);
    }
    expect(countOf("phoneTicket: PHONE_TICKET")).toBe(1);
  });

  it("runIt(PHONE_IDLE_ENTRY) appears once, and it is the last runIt( call in admitDirectSend, after the group-turn check", () => {
    expect(countOf("runIt(PHONE_IDLE_ENTRY)")).toBe(1);
    const body = bodyOf("function admitDirectSend(");
    const calls = [...body.matchAll(/runIt\(([^)]*)\)/g)];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[calls.length - 1]![1]).toBe("PHONE_IDLE_ENTRY");
    const groupCheck = body.indexOf("if (activeGroupTurnForBot(currentAtStart.id))");
    expect(groupCheck).toBeGreaterThan(-1);
    expect(body.lastIndexOf("runIt(PHONE_IDLE_ENTRY)")).toBeGreaterThan(groupCheck);
  });

  it("every other runIt( call in the file has empty parentheses", () => {
    const calls = [...source.matchAll(/\brunIt\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.filter((c) => c !== "").sort()).toEqual(["PHONE_IDLE_ENTRY"]);
    expect(source).not.toMatch(/runIt\(\s*PHONE_TICKET/);
  });

  it("runIt computes eligibility only on the idle entry symbol", () => {
    const at = lineOf("const runIt = async (entry?: typeof PHONE_IDLE_ENTRY)");
    expect(lines.slice(at, at + 16).join("\n")).toContain("entry === PHONE_IDLE_ENTRY && phoneMintEligible(");
  });

  it("flag off or a non-idle entry reads nothing: the direct-thread scan sits behind the offered check", () => {
    const at = lineOf("const runIt = async (entry?: typeof PHONE_IDLE_ENTRY)");
    const text = lines.slice(at, at + 14).join("\n");
    expect(text).toContain("const offeredNow = entry === PHONE_IDLE_ENTRY && phonesOfferedNow();");
    expect(text).toContain("directThread: offeredNow && phoneDirectThread(");
    expect(text).not.toMatch(/directThread: phoneDirectThread\(/);
    expect(bodyOf("function phonesOfferedNow(")).toMatch(/features\?\.phoneTools !== true\) return false/);
  });

  it("resendFailover passes phoneCarry and ownerActs: held", () => {
    const body = bodyOf("function resendFailover(");
    expect(body).toContain("phoneCarry: { held }");
    expect(body).toContain("ownerActs: held");
  });

  it("drainQueuedSends passes no phoneTicket", () => {
    const body = bodyOf("function drainQueuedSends(");
    expect(body).not.toContain("phoneTicket");
    expect(body).not.toContain("PHONE_");
  });

  it("the bot messages route states ownerActs from the owner proof, and the revoke functions revoke phone authority", () => {
    expect(source).toContain("unprovenSend, typedStop: true, ownerActs: mayApprove(req, url) });");
    expect(bodyOf("function revokeInternalGeneration(")).toContain("phoneAuthorities.revokeGeneration(generation)");
    expect(bodyOf("function revokeInternalThread(")).toContain("phoneAuthorities.revokeThread(threadId)");
    expect(bodyOf("function revokeInternalBot(")).toContain("phoneAuthorities.revokeBot(botId)");
    expect(bodyOf("function revokeAllInternalTurns(")).toContain("phoneAuthorities.revokeAll()");
  });

  it("S13: integrations.phoneJobs is assigned once, from phoneJobsIntegration, which first requires a live authority for the generation", () => {
    expect(countOf("integrations.phoneJobs =")).toBe(1);
    const body = bodyOf("function phoneJobsIntegration(");
    expect(body.indexOf("phoneAuthorities.live(generation)")).toBeGreaterThan(-1);
    expect(body.indexOf("phoneAuthorities.live(generation)")).toBeLessThan(body.indexOf('internalToken(botId, threadId, generation, "device")'));
    expect(body).toContain("offeredPhoneTools(");
    expect(body).toContain("tools.length === 0");
    const at = lineOf("integrations.phoneJobs =");
    expect(lines.slice(Math.max(0, at - 3), at).join("\n")).toContain("phoneJobsIntegration(bot.id, threadId, dispatchClaimId)");
  });

  it("S13: the inline internal kind mapping knows the device path, and the device route calls phoneRpc with the live claim", () => {
    expect(source).toContain('path.startsWith("/api/internal/device/") ? "device"');
    expect(countOf('if (path === "/api/internal/device/call") {')).toBe(1);
    expect(countOf("await phoneRpc(internalClaim,")).toBe(1);
  });
});
