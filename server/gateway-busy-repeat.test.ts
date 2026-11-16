// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { GatewayBusyStreaks, gatewayBusyLogLine, gatewayBusyShortReason } from "./gateway-busy-repeat.ts";
const turn = { driverKind: "fuigoAgent", engineName: "Fuigo", selection: { instanceId: "f", model: "flux-auto" }, errorText: "HTTP 429: capacity unavailable", httpStatus: 429 };
describe("busyloop decisions", () => {
  it("first and second busy stay quiet, third offers help; success resets", () => {
    const counts = new GatewayBusyStreaks();
    expect(counts.refused(turn, "busy", 0, false)).toEqual({ count: 1, repeated: false });
    expect(counts.refused(turn, "busy", 1, false)).toEqual({ count: 2, repeated: false });
    expect(counts.refused(turn, "busy", 2, false)).toEqual({ count: 3, repeated: true });
    counts.succeeded(turn);
    expect(counts.refused(turn, "busy", 3, false)).toEqual({ count: 1, repeated: false });
  });
  it("engine, model and account selections are independent", () => {
    const counts = new GatewayBusyStreaks();
    counts.refused(turn, "busy", 0, false); counts.refused(turn, "busy", 1, false);
    for (const selection of [{ instanceId: "other", model: "flux-auto" }, { instanceId: "f", model: "other" }, { ...turn.selection, connectionId: "account" }]) {
      expect(counts.refused({ ...turn, selection }, "busy", 2, false).repeated).toBe(false);
    }
    expect(counts.refused(turn, "busy", 3, false).repeated).toBe(true);
  });
  it("first job escalates on two busy refusals within ten minutes, including a rolling window", () => {
    const counts = new GatewayBusyStreaks();
    expect(counts.refused(turn, "busy", 0, true).repeated).toBe(false);
    expect(counts.refused(turn, "busy", 600_000, true).repeated).toBe(true);
    counts.succeeded(turn);
    counts.refused(turn, "busy", 0, true);
    expect(counts.refused(turn, "busy", 600_001, true).repeated).toBe(false);
    expect(counts.refused(turn, "busy", 600_002, true).repeated).toBe(true);
  });
  it("known caps keep their own copy and break the genuine-busy streak", () => {
    const counts = new GatewayBusyStreaks();
    counts.refused(turn, "busy", 0, false); counts.refused(turn, "busy", 1, false);
    expect(counts.refused(turn, "freeCap", 2, false).repeated).toBe(false);
    expect(counts.refused(turn, "busy", 3, false)).toEqual({ count: 1, repeated: false });
  });
  it("one-line diagnostics mask credentials before truncation and carry decision evidence", () => {
    const line = gatewayBusyLogLine({ ...turn, gatewayCode: "free_cap_reached", errorText: 'refused\nAuthorization: Bearer sk-secret12345678901234567890' }, "freeCap", 2);
    expect(line).toContain('engine="Fuigo"'); expect(line).toContain('http=429');
    expect(line).toContain('gatewayCode=free_cap_reached'); expect(line).toContain('consecutive=2');
    expect(line).not.toContain('sk-secret'); expect(line.split("\n")).toHaveLength(1);
    expect(gatewayBusyShortReason('API error (status 429): capacity unavailable')).toBe('capacity unavailable');
    expect(gatewayBusyShortReason('API error (status 429): {"token":"secret"}')).toBeUndefined();
  });
});
