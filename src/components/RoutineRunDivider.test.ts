// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The line between two runs in a routine's conversation: saved by the server
// at each run, it used to be folded behind Tool calls and never shown, so the
// runs read as one long thread of the same request (0.1.60 Mac pass).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RoutineRunDivider } from "./RoutineRunDivider";
import { groupTranscript } from "@/lib/activity-runs";
import type { Message } from "@/state/store";

describe("the divider between routine runs", () => {
  it("says which kind of run started, for which routine, and when", () => {
    const at = new Date(2026, 8, 25, 13, 25).getTime();
    const markup = renderToStaticMarkup(createElement(RoutineRunDivider, { trigger: "schedule", routineName: "Log tick", at }));
    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-label="Scheduled run of Log tick');
    expect(markup).toContain("Scheduled run");
    expect(markup).toContain("Log tick");
    expect(renderToStaticMarkup(createElement(RoutineRunDivider, { trigger: "manual", routineName: "Log tick", at }))).toContain("Run now");
  });

  it("is never folded into a run of tool steps, so Tool calls off still shows it", () => {
    const step = (id: string, name: string): Message => ({ id, at: 1, role: "bot", kind: "activity", tool: { name, ok: true }, turnId: "t" });
    const marker: Message = { id: "mk", at: 2, role: "bot", kind: "activity", tool: { name: "Run now: Log tick", ok: true } };
    const items = groupTranscript([step("a", "Bash"), step("b", "Edit"), marker, step("c", "Bash"), step("d", "Edit")]);
    expect(items.map((item) => item.kind)).toEqual(["run", "message", "run"]);
    expect(items[1]).toMatchObject({ kind: "message", message: { id: "mk" } });
  });
});
