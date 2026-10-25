// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from "vitest";

import { SIGN_IN_REJECTED_REASON, instanceAuthFailed, resetKeyRejectionsForTests, withInstanceMark } from "../key-rejections.ts";
import { EventBus } from "./bus.ts";
import type { ProviderInstance, RuntimeEvent, RuntimeEventListener } from "../contracts.ts";

beforeEach(() => resetKeyRejectionsForTests());

function fakeInstance(instanceId: string, extra: Partial<ProviderInstance> = {}) {
  let listener: RuntimeEventListener | null = null;
  const instance = {
    instanceId, driverKind: "opencodeGo", displayName: "x", enabled: true, models: { default: "m", options: [] },
    adapter: { provider: "opencodeGo", onEvent: (l: RuntimeEventListener) => { listener = l; return () => {}; } },
    ...extra,
  } as unknown as ProviderInstance;
  return { instance, emit: (event: Partial<RuntimeEvent>) => listener?.({ eventId: "e", provider: "opencodeGo", threadId: "t", turnId: "u", ...event } as unknown as RuntimeEvent) };
}

describe("a failed turn marks the engine signed out; a good one clears it (item 139)", () => {
  it("OpenCode: an authentication failure then success", () => {
    const bus = new EventBus(() => {});
    const { instance, emit } = fakeInstance("opencode-1");
    bus.attach([instance]);
    emit({ type: "runtime.error", message: "Invalid API key (401)" });
    expect(instanceAuthFailed("opencode-1")).toBe(true);
    emit({ type: "turn.completed", ok: true, stopReason: null, cost: null });
    expect(instanceAuthFailed("opencode-1")).toBe(false);
  });

  it("an ACP engine's expired login marks it, a quota error does not", () => {
    const bus = new EventBus(() => {});
    const acp = fakeInstance("acp-1");
    const quota = fakeInstance("acp-2");
    bus.attach([acp.instance, quota.instance]);
    acp.emit({ type: "runtime.error", message: "Your session expired. Please sign in again." });
    quota.emit({ type: "runtime.error", message: "You exceeded your quota" });
    expect(instanceAuthFailed("acp-1")).toBe(true);
    expect(instanceAuthFailed("acp-2")).toBe(false);
  });

  it("Claude and Codex are marked from their own sign-in failures and cleared by a good turn", () => {
    const bus = new EventBus(() => {});
    const claude = fakeInstance("claude-1", { driverKind: "claude" });
    const codex = fakeInstance("codex-1", { driverKind: "codex" });
    bus.attach([claude.instance, codex.instance]);
    claude.emit({ provider: "claude", type: "runtime.error", message: "Not logged in · Please run /login" });
    codex.emit({ provider: "codex", type: "runtime.error", message: "unexpected status 401 Unauthorized: Your access token could not be refreshed; please sign in again" });
    expect(instanceAuthFailed("claude-1")).toBe(true);
    expect(instanceAuthFailed("codex-1")).toBe(true);
    claude.emit({ provider: "claude", type: "turn.completed", ok: true, stopReason: null, cost: null });
    expect(instanceAuthFailed("claude-1")).toBe(false);
    expect(instanceAuthFailed("codex-1")).toBe(true);
  });

  it("an engine that tracks its own key refusal is not marked twice", () => {
    const bus = new EventBus(() => {});
    const { instance, emit } = fakeInstance("chat-1", { tracksKeyRejection: true });
    bus.attach([instance]);
    emit({ type: "runtime.error", message: "401 invalid api key" });
    expect(instanceAuthFailed("chat-1")).toBe(false);
  });
  it("L2: an MCP tool error that mentions 401 does not sign Claude or Codex out, and their mark says sign-in", () => {
    const bus = new EventBus(() => {});
    const claude = fakeInstance("claude-2", { driverKind: "claude" });
    const codex = fakeInstance("codex-2", { driverKind: "codex" });
    bus.attach([claude.instance, codex.instance]);
    claude.emit({ provider: "claude", type: "runtime.error", message: "MCP tool github failed: HTTP 401 Unauthorized" });
    codex.emit({ provider: "codex", type: "runtime.error", message: "tool call returned 401" });
    expect(instanceAuthFailed("claude-2")).toBe(false);
    expect(instanceAuthFailed("codex-2")).toBe(false);
    codex.emit({ provider: "codex", type: "runtime.error", message: "unexpected status 401 Unauthorized: please sign in again" });
    expect(withInstanceMark("codex-2", { state: "available", authenticated: true, version: null } as never)).toMatchObject({ reason: SIGN_IN_REJECTED_REASON });
  });
});
