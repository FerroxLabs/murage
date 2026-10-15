// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The plain words load after the first paint. Before they arrive a card keeps
// the wording it had before them, with the whole request on show; once they
// arrive the same card says what will happen in plain words.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PendingApprovalPanel, type Pending } from "@/components/PendingApproval";
import type { Message } from "@/state/store";
import { loadPlainApproval, plainApproval } from "./plain-approval";

const message: Message = { id: "m1", role: "bot", kind: "options", at: 1,
  card: { title: "Approval needed", subtitle: "rm -rf /home/ana/build", options: ["Allow", "Deny"], tool: "shell", requestId: "r1" } };
const pending: Pending = { message, requestId: "r1", tool: "shell", detail: "rm -rf /home/ana/build" };
const panel = () => renderToStaticMarkup(createElement(PendingApprovalPanel, { pending, count: 1, index: 0 }));

describe("plain words after the first paint", () => {
  it("before they load: the earlier wording and the whole request, nothing softer", () => {
    expect(plainApproval("shell", "rm -rf /home/ana/build")).toBeUndefined();
    const markup = panel();
    expect(markup).toContain("Command approval requested");
    expect(markup).toContain("rm -rf /home/ana/build");
    expect(markup).not.toContain("<details");
  });

  it("once loaded: the same card in plain words, the request folded under the details", async () => {
    await loadPlainApproval();
    expect(plainApproval("shell", "rm -rf /home/ana/build")?.action).toBe("delete build");
    const markup = panel();
    expect(markup).toContain("Wants to delete build");
    expect(markup).toContain("<details");
  });
});
