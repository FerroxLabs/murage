// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The composer is keyed by thread, so its mount is a thread switch. It takes
// focus then, except on touch screens where focus opens the keyboard over the
// conversation. Adapted from OpenMausBot #1872 (Apache-2.0).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const composer = readFileSync(new URL("./Composer.tsx", import.meta.url), "utf8");
const chat = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
const group = readFileSync(new URL("./GroupView.tsx", import.meta.url), "utf8");

describe("focus the composer on thread switch", () => {
  it("mounts one composer per thread in chats and rooms", () => {
    expect(chat).toMatch(/<Composer\s+key=\{bot\.threadId\}/);
    expect(group).toMatch(/<Composer\s+key=\{group\.threadId\}/);
  });

  it("focuses the draft on mount, skipping touch screens and other fields", () => {
    const at = composer.indexOf("composerTakesFocusOnOpen(document.activeElement, input)");
    expect(at).toBeGreaterThan(0);
    const effect = composer.slice(composer.lastIndexOf("useEffect(", at), composer.indexOf("}, []);", at));
    expect(effect).toContain("matchMedia?.(COARSE_POINTER_QUERY).matches) return;");
    expect(effect).toContain("input.disabled");
    expect(effect).toContain("input.setSelectionRange(input.value.length, input.value.length)");
    expect(effect).toContain("cancelAnimationFrame(frame)");
  });
});
