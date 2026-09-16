import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryHealth, type MemoryHealthStatus } from "./MemoryLearningControls";
const health: MemoryHealthStatus = { captured: { sources: 3, lastAt: 1000 }, processed: { sources: 1, lastAt: 2000 }, retrieved: { queries: 2, hits: 1, lastAt: 3000 }, supplied: { turns: 0, references: 0, lastAt: null }, synthesis: { state: "configured", reason: null } };
const status = { health, workerError: null, backlog: { pending: 2, leased: 0, deferred: 0, failed: 0 } };
describe("workspace memory activity", () => {
  it("separates processing, retrieval and supplied references without claiming configured learning works", () => {
    const html = renderToStaticMarkup(createElement(MemoryHealth, { status }));
    expect(html).toContain("3 sources stored"); expect(html).toContain("1 sources processed");
    expect(html).toContain("Supplied to turns"); expect(html).toContain("No activity recorded");
    expect(html).toContain("successful learning is not confirmed by configuration alone");
    expect(html).toContain("whole workspace"); expect(html).toContain("Last activity:");
  });
  it("reports missing metrics instead of interpreting them as no activity", () => {
    const html = renderToStaticMarkup(createElement(MemoryHealth, { status: { ...status, health: undefined } }));
    expect(html).toContain("Activity details are unavailable"); expect(html).not.toContain("No activity recorded");
  });
  it("explains worker, index and budget degradation", () => {
    const html = renderToStaticMarkup(createElement(MemoryHealth, { status: { ...status, workerError: "Connection unavailable", runtime: { indexing: true }, health: { ...health, synthesis: { state: "budget-limited", reason: "Daily token limit reached" } } } }));
    expect(html).toContain("waiting for available budget"); expect(html).toContain("Daily token limit reached");
    expect(html).toContain("Connection unavailable"); expect(html).toContain("Search index is updating");
  });
});
