// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { projectRequestLabel, ProjectStripDetails } from "./ProjectStripDetails";
import { ProjectStrip } from "./ProjectStrip";
import { ProjectTabs } from "./ProjectTabs";
import { projectWriteReason, type ProjectRead } from "@/lib/project-client";

vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { groups: [], bots: [] } }),
}));

const project: ProjectRead = {
  lifecycle: "open", settings: { groupId: "g", mode: "ongoing", leadBotId: "a", parts: {}, runState: "paused", closedAt: null, endedAt: null, revision: 1 },
  brief: null, goal: { id: "goal", title: "Finish the launch", state: "working", revision: 1 }, budgets: [],
  strip: { line: "Finch answering", needsYou: 2, usage: { workMs: 60000, input: 4, output: 6, tokensReported: true, charge: null } },
  sinceYouLeft: { messages: 0, cards: 0, decisions: 0 }, revision: 1,
};
it("keeps goal, paused state, decision count and accessible usage in the compact strip", () => {
  const html = renderToStaticMarkup(createElement(ProjectStrip, { project, title: "Project", groupId: "g", onBoard: vi.fn() }));
  expect(html).toContain("Finish the launch"); expect(html).toContain("Paused"); expect(html).toContain("2 needs you");
  expect(html).toContain('aria-expanded="false"'); expect(html).toContain('aria-live="polite"'); expect(html).toContain('aria-label="Usage details"');
  expect(html).not.toContain("Finch answering");
});
it("shows nothing when the aggregate route is absent", () => {
  expect(renderToStaticMarkup(createElement(ProjectStrip, { project: null, title: "Project", groupId: "g", onBoard: vi.fn() }))).toBe("");
});
it("retains a plain lifecycle reason for disabled writes", () => {
  expect(projectWriteReason({ ...project, settings: { ...project.settings, closedAt: 1 } })).toBe("This project is closed");
  expect(projectWriteReason({ ...project, settings: { ...project.settings, endedAt: 1 } })).toBe("This is a channel now");
  expect(projectWriteReason(null)).toBe("Project details are not available yet");
  expect(projectWriteReason({ ...project, lifecycle: "closed" })).toBe("This project is closed");
  expect(projectWriteReason({ ...project, lifecycle: "ended" })).toBe("This is a channel now");
});
it("puts Chat first, gives projects Board and keeps channel tabs to Chat, Files, Memory", () => {
  const draw = (isProject: boolean) => renderToStaticMarkup(createElement(ProjectTabs, { isProject, value: "chat", onChange: vi.fn(), onSettings: vi.fn() }));
  const html = draw(true);
  expect(html.indexOf('>Chat<')).toBeLessThan(html.indexOf('>Board<'));
  for (const name of ["Overview", "Files", "Memory", "Activity"]) expect(html).toContain(name);
  const channel = draw(false); expect(channel).toContain("Files"); expect(channel).toContain("Memory");
  expect(channel).not.toContain("Board"); expect(channel).not.toContain("Overview"); expect(channel).not.toContain("Activity");
  expect(html).toContain('aria-label="Project settings"');
});

it("explains budget limits without implying running work is interrupted", () => {
  const limited = { ...project, budgets: [{ id: "budget", state: "paused" as const, revision: 1 }] };
  const props = { project: limited, title: "Project", groupId: "g", onBoard: vi.fn() };
  for (const element of [createElement(ProjectStrip, props), createElement(ProjectStripDetails, props)]) {
    const html = renderToStaticMarkup(element);
    expect(html).toContain(element.type === ProjectStrip ? ">Limit reached<" : "This project stops starting new work at your limit.");
    expect(html).not.toMatch(/[$€£]|estimated charge/i);
  }
});
it("shows usage without a money estimate when no engine charge is reported", () => {
  const html = renderToStaticMarkup(createElement(ProjectStripDetails, { project, groupId: "g", onBoard: vi.fn() }));
  expect(html).toContain("10 tokens reported");
  expect(html).not.toMatch(/[$€£]|estimated charge/i);
});

it("uses the theme foreground for selected tabs in light and dark themes", () => {
  const html = renderToStaticMarkup(createElement(ProjectTabs, { isProject: true, value: "chat", onChange: vi.fn(), onSettings: vi.fn() }));
  const selected = html.match(/<button[^>]*aria-selected="true"[^>]*>/)?.[0];
  expect(selected).toContain("text-ink");
  expect(selected).not.toContain("text-accent");
});

it("describes requests with member names and plain states", () => {
  const members = [{ id: "jax", name: "Jax" }];
  expect(projectRequestLabel({ verb: "owner_send", state: "waiting_owner", toBotId: null }, members)).toBe("Your message: waiting for you");
  expect(projectRequestLabel({ verb: "ask", state: "queued", toBotId: "jax" }, members)).toBe("Ask to Jax: queued");
  expect(projectRequestLabel({ verb: "room_turn", state: "waiting_bot", toBotId: "jax" }, members)).toBe("Reply from Jax: waiting for a bot");
  expect(projectRequestLabel({ verb: "ask", state: "unknown", toBotId: "deleted-id" }, members)).toBe("Ask: interrupted at restart");
  for (const verb of ["message", "assign", "review", "wake", "routine"] as const) {
    for (const state of ["running", "done", "failed", "cancelled", "expired"] as const) {
      expect(projectRequestLabel({ verb, state, toBotId: "jax" }, members)).toContain("Jax:");
    }
  }
});

it("hides the Board tab when its flag or project part disables it", () => {
  const html = renderToStaticMarkup(createElement(ProjectTabs, { isProject: true, board: false, value: "chat", onChange: vi.fn(), onSettings: vi.fn() }));
  expect(html).not.toContain(">Board<"); expect(html).toContain(">Chat<");
});
