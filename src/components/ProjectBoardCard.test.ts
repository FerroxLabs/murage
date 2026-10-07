// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { afterEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { localeVersion, setLocale, subscribeLocale } from "@/lib/i18n";

const store = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useId: () => "id",
  useSyncExternalStore: (...args: unknown[]) => { store.calls.push(args); return 0; },
}));
import { ProjectBoardCard } from "./ProjectBoardCard";

afterEach(() => setLocale("en"));

function text(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return text((node as ReactElement<{ children?: unknown }>).props?.children);
}
const face = { title: "T", assignee: "A", avatarId: null, state: "S", goalTitle: null, goalId: null, time: "1 h", work: "0 min", tokens: null, reason: null, review: false, depends: 0, queued: true, dependency: null, failed: false, pastDue: false };
const render = () => (ProjectBoardCard as unknown as { type: (props: unknown) => ReactElement }).type({ card: { id: "c", number: 3, title: "T", state: "todo", revision: 1 }, face, readOnly: true, onOpen: () => {}, onAction: () => {} });

it("re-renders the memoised card when the language changes", async () => {
  store.calls.length = 0;
  const english = render();
  expect(store.calls.some(([subscribe, snapshot]) => subscribe === subscribeLocale && snapshot === localeVersion)).toBe(true);
  expect(text(english)).toContain("queued");
  await setLocale("de");
  const german = render();
  expect(text(german)).toContain("eingereiht");
  expect(text(german)).not.toContain("queued");
});
