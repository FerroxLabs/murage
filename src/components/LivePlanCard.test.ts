// The agent's live to-do list. Markup through `renderToStaticMarkup`.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AgentPlanEntry } from "../../shared/agent-plan";
import { LivePlanCard, planProgressLabel } from "./LivePlanCard";

const PLAN: AgentPlanEntry[] = [
  { content: "Read the folder", status: "completed" },
  { content: "Fix the bug", status: "in_progress" },
  { content: "Report back", status: "pending" },
];

const render = (entries: AgentPlanEntry[]) => renderToStaticMarkup(createElement(LivePlanCard, { entries }));

/** One entry's <li>, cut out so an assertion cannot pass on a neighbour. */
const row = (html: string, content: string) => {
  const end = html.indexOf(content);
  expect(end).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<li", end);
  return html.slice(start, html.indexOf("</li>", end));
};

describe("LivePlanCard", () => {
  it("renders every entry in order, open, with how many are done", () => {
    const html = render(PLAN);
    expect(html).toContain('aria-label="Plan"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("1 of 3 done");
    const order = PLAN.map((entry) => html.indexOf(entry.content));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((index) => index > -1)).toBe(true);
  });

  it("marks each entry with its own state, in words for a screen reader", () => {
    const html = render(PLAN);
    const done = row(html, "Read the folder");
    expect(done).toContain('data-status="completed"');
    expect(done).toContain("Done: ");
    expect(done).toContain("line-through");
    expect(done).toContain("text-success");

    const running = row(html, "Fix the bug");
    expect(running).toContain('data-status="in_progress"');
    expect(running).toContain("In progress: ");
    expect(running).toContain("animate-spin");
    expect(running).not.toContain("line-through");

    const pending = row(html, "Report back");
    expect(pending).toContain('data-status="pending"');
    expect(pending).toContain("Not started: ");
    expect(pending).not.toContain("line-through");
    expect(pending).not.toContain("animate-spin");
  });

  it("shows the newer list when the plan updates, not a merge", () => {
    const next: AgentPlanEntry[] = [
      { content: "Read the folder", status: "completed" },
      { content: "Fix the bug", status: "completed" },
    ];
    const html = render(next);
    expect(html).toContain("2 of 2 done");
    expect(html).not.toContain("Report back");
    expect(row(html, "Fix the bug")).toContain('data-status="completed"');
  });

  it("renders nothing for an empty plan", () => {
    expect(render([])).toBe("");
  });

  it("counts only completed entries as done", () => {
    expect(planProgressLabel(PLAN)).toBe("1 of 3 done");
    expect(planProgressLabel([{ content: "a", status: "in_progress" }])).toBe("0 of 1 done");
  });
});
