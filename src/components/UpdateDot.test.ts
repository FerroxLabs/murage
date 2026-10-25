// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdaterState } from "../types/muragebox";

const current = vi.hoisted(() => ({ value: null as UpdaterState | null }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => current.value }));
import { UpdateDot } from "./UpdateDot";
import { BotListButton } from "./OpenBotListButton";

afterEach(() => { current.value = null; });

it("marks the drawer button and the rail toggle only while an update needs attention", () => {
  expect(renderToStaticMarkup(createElement(UpdateDot))).toBe("");
  current.value = { status: "idle" };
  expect(renderToStaticMarkup(createElement(UpdateDot))).toBe("");
  current.value = { status: "available", version: "1.0.5" };
  expect(renderToStaticMarkup(createElement(UpdateDot))).toContain("update-dot");
  const control = { expanded: false, open: () => {}, buttonRef: { current: null }, takeFocusReturn: () => false };
  expect(renderToStaticMarkup(createElement(BotListButton, { control }))).toContain("update-dot");
});

it("the rail's expand toggle carries the dot too", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
  expect(source).toContain('{density === "icons" && <UpdateDot />}');
});
