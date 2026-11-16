// SPDX-License-Identifier: AGPL-3.0-or-later
// Ticket issuer owner: scperf-p1. Helper reservation and acknowledgement owner: scperf-p1.
import { afterEach, expect, it } from "vitest";
import { acceptHelperTicket, configureHelperAdmission, helperHasGrant, helperStepBudget, settleHelperAdmission, stopHelperAdmission } from "./helper-admission.ts";

afterEach(() => configureHelperAdmission(undefined));
const ticket = () => ({ id: "fixture-ticket", bytes: 4096, expiresAt: Date.now() + 60_000 });

it("uses an inline ticket without a false admission refusal or maintenance retry", () => {
  let requests = 0;
  const settled: number[] = [];
  configureHelperAdmission({ request() { requests++; acceptHelperTicket(ticket()); }, settle(_ticket, used) { settled.push(used); } });
  // MAIN RULING 2026-11-14 SCALE admission must not add work after a ticket is already available
  expect(helperHasGrant(4096)).toBe(true);
  expect(helperHasGrant(4096)).toBe(true);
  expect(requests).toBe(1);
  stopHelperAdmission();
  expect(settled).toEqual([0]);
});

it("a stopped request remains outstanding until its reply is returned before acknowledgement", async () => {
  let requests = 0, acknowledged = false;
  const settled: number[] = [];
  configureHelperAdmission({ request() { requests++; }, settle(_ticket, used) { settled.push(used); } });
  expect(helperHasGrant(4096)).toBe(false);
  stopHelperAdmission();
  const acknowledgement = settleHelperAdmission().then(() => { acknowledged = true; });
  await Promise.resolve();
  // MAIN RULING 2026-11-14 the checked batch must return its unused permit BEFORE acknowledgement; zero outstanding
  expect(acknowledged).toBe(false);
  expect(helperHasGrant(4096)).toBe(false);
  expect(requests).toBe(1);
  acceptHelperTicket(ticket());
  await acknowledgement;
  expect(settled).toEqual([0]);
  expect(acknowledged).toBe(true);
});

it("an inline smaller step plan resizes the caller before its first write", () => {
  configureHelperAdmission({ request() { acceptHelperTicket({ ...ticket(), stepBytes: 2048 }); }, settle() {} });
  // MAIN RULING 2026-11-14 byte admission preserves the issuer's remaining-room step plan
  expect(helperHasGrant(4096)).toBe(false);
  expect(helperStepBudget()).toBe(2048);
  expect(helperHasGrant(2048)).toBe(true);
});

it("a denied in-flight request completes settlement without inventing a permit", async () => {
  const settled: number[] = [];
  configureHelperAdmission({ request() {}, settle(_ticket, used) { settled.push(used); } });
  expect(helperHasGrant(4096)).toBe(false);
  const done = settleHelperAdmission();
  acceptHelperTicket(null, 1000);
  await done;
  expect(settled).toEqual([]);
});
