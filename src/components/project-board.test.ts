// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import ProjectBoard from "./ProjectBoard";
import { ProjectBoardCard } from "./ProjectBoardCard";
import type { ProjectRead, ProjectBoardRead, ProjectCard } from "@/lib/project-client";
import type { Group } from "@/state/store";
import { cardFace } from "@/lib/project-board";
vi.mock("@/state/store", async original => ({ ...await original<typeof import("@/state/store")>(), useStore: () => ({ state: { config: { features: {} }, bots: [], groups: [] }, dispatch: vi.fn() }) }));
const project: ProjectRead = { lifecycle: "open", settings: { groupId: "g", mode: "ongoing", leadBotId: null, parts: {}, runState: "running", closedAt: null, endedAt: null, revision: 0 }, goal: null, brief: null, budgets: [], strip: { line: "", needsYou: 0, usage: { workMs: 0, input: 0, output: 0, tokensReported: false, charge: null } }, sinceYouLeft: { messages: 0, cards: 0, decisions: 0 }, revision: 0 };
const group = { id: "g", name: "Project", memberIds: [], threadId: "room" } as unknown as Group;
const card: ProjectCard = { id: "c", number: 12, state: "failed", title: "Long card title", position: 0, revision: 1, reason: "Engine stopped", usage: { workMs: 60000, tokens: 0, tokensReported: false } };
const board: ProjectBoardRead = { lifecycle: "open", columnsRevision: 0, columns: [{ id: "todo", title: "To do", state: "todo", position: 0 }, { id: "waiting", title: "Waiting", state: "waiting", position: 1 }], cards: [card] };
it("renders the complete card face, focus semantics, failure actions and no price words", () => {
  const html = renderToStaticMarkup(createElement(ProjectBoardCard, { card, face: cardFace(card, []), onOpen: vi.fn(), onAction: vi.fn(), readOnly: false }));
  for (const text of ["Long card title", "Unassigned", "Failed", "Engine stopped", "1 min", "Reassign", "Details", 'aria-roledescription="card"', 'board-drag-instructions']) expect(html).toContain(text);
  expect(html).not.toMatch(/cost|spend|[$£€]/i);
});
it("renders filters, column counts and a read-only closed board", () => {
  const html = renderToStaticMarkup(createElement(ProjectBoard, { group, members: [], project: { ...project, lifecycle: "closed" }, initialBoard: board }));
  expect(html).toContain("This project is closed"); expect(html).toContain("Waiting"); expect(html).toContain("Long card title");
  expect(html).not.toContain(">New card<"); expect(html).not.toContain(">Edit columns<"); expect(html).not.toContain(">Retry<");
});
it("shows the board-off sentence for either flag or part, and the ended reason", () => {
  for (const props of [{ boardEnabled: false }, { project: { ...project, settings: { ...project.settings, parts: { board: false } } } }]) {
    const html = renderToStaticMarkup(createElement(ProjectBoard, { group, members: [], project, initialBoard: board, ...props }));
    expect(html).toContain("The board is off for this project"); expect(html).not.toContain("Long card title");
  }
  expect(renderToStaticMarkup(createElement(ProjectBoard, { group, members: [], project: { ...project, lifecycle: "ended" }, initialBoard: board }))).toContain("This is a channel now");
});

it("exposes the card title and full face through labelled/described elements", () => {
 const html=renderToStaticMarkup(createElement(ProjectBoardCard,{card,face:cardFace(card,[]),onOpen:vi.fn(),onAction:vi.fn(),readOnly:false}));
 const button=html.match(/<button[^>]*data-board-card="c"[^>]*>/)![0];
 expect(button).not.toContain('aria-label=');
 const title=button.match(/aria-labelledby="([^"]+)"/)?.[1];
 expect(title).toBeTruthy();expect(html).toContain(`id="${title}"`);
 const ids=button.match(/aria-describedby="([^"]+)"/)![1].split(" ");
 expect(ids).toContain("board-drag-instructions"); expect(ids.length).toBeGreaterThan(1);
 for(const id of ids.filter(id=>id!=="board-drag-instructions")) expect(html).toContain(`id="${id}"`);
 expect(html).not.toContain(">Retry<");
});
