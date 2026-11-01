// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-L1A-1013 r1 (Astra item 5, Fable H1): the paired app reaches the task
// allowance's Undo and Settings "Clear", forwarded with the owner's launch
// proof; a browser pairing does not; the bot card's Undo stays off the phone.
import { describe, expect, it } from "vitest";

import { denyReason, deviceProofHeaders, launchProofHeaders } from "../src/routes.ts";

const TOKEN = "a".repeat(64);
const PATHS = ["/api/bots/bot_123/task-allow/remove", "/api/bots/bot_123/task-allow/clear"];

describe("task-allow from the paired app", () => {
  it("the device door allows both and forwards the launch proof", () => {
    for (const path of PATHS) {
      expect(denyReason({ method: "POST", path, authenticated: true, surface: "device" })).toBeNull();
      expect(launchProofHeaders("POST", path, TOKEN)).toEqual({ "x-murage-companion-token": TOKEN });
      expect(deviceProofHeaders("POST", path, TOKEN)).toEqual({ "x-murage-companion-token": TOKEN });
    }
  });
  it("only POST, only these two, never unauthenticated, never the browser door", () => {
    for (const path of PATHS) {
      expect(denyReason({ method: "GET", path, authenticated: true, surface: "device" })).not.toBeNull();
      expect(denyReason({ method: "POST", path, authenticated: false, surface: "device" })?.status).toBe(401);
      expect(denyReason({ method: "POST", path, authenticated: true, surface: "browser" })).not.toBeNull();
    }
    expect(denyReason({ method: "POST", path: "/api/bots/bot_123/task-allow/grant", authenticated: true, surface: "device" })).not.toBeNull();
    expect(denyReason({ method: "POST", path: "/api/bots/bot_123/always-allow/undo", authenticated: true, surface: "device" })).not.toBeNull();
  });
});
