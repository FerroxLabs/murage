// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Astra a13 r2 #6, class C5 (lanes/release103/A13-FIX-DESIGN.md): a call
// reads the same operations and recipients the card shows, from one place.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import type { ApprovalActionRow } from "../../shared/approval-grant-request";
import { loadPlainApproval } from "@/lib/plain-approval";
import { grantRowWords, spokenGrantRows } from "@/lib/routine-grant-words";
import type { Message } from "@/state/store";
import { spokenApprovalPrompt, spokenQueueItem, type Pending } from "./PendingApproval";

beforeAll(() => loadPlainApproval());

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const rows: ApprovalActionRow[] = [
  { index: 0, kind: "action", operation: "GMAIL_FETCH_EMAILS", app: "Gmail", action: "fetch emails", destinations: [], findings: [], arguments: {} },
  { index: 1, kind: "action", operation: "GMAIL_SEND_EMAIL", app: "Gmail", action: "send email", destinations: ["bob@example.com", "eve@example.com"], findings: [], arguments: {} },
];
function pending(withRows: readonly ApprovalActionRow[]): Pending {
  const tool = "mcp__murage_connectors__APPS_MULTI_EXECUTE_TOOL";
  const message = { id: "m-1", role: "bot", kind: "options", at: 1, card: { title: "Approval", subtitle: "Run app tools", options: [], tool, requestId: "r-1", grantRequest: { rows: withRows } } } as unknown as Message;
  return { message, requestId: "r-1", tool, detail: "Run app tools" };
}

describe("C5: voice reads every operation and recipient the card shows", () => {
  it("the one-to-one and group prompts name each operation in order and every recipient", () => {
    for (const said of [spokenApprovalPrompt(pending(rows), "Ada", true), spokenApprovalPrompt(pending(rows), "Ada")]) {
      const first = said.indexOf(grantRowWords(rows[0]!).title);
      const second = said.indexOf(grantRowWords(rows[1]!).title);
      expect(first, said).toBeGreaterThan(-1);
      expect(second, said).toBeGreaterThan(first);
      expect(said).toContain("bob@example.com");
      expect(said).toContain("eve@example.com");
      expect(said).not.toContain("use your connected apps");
    }
  });

  it("C5a: the voice reads the account the card shows, from the same row words", () => {
    const withAccount: ApprovalActionRow[] = [{ ...rows[1]!, account: "sean@example.com" }];
    const words = grantRowWords(withAccount[0]!);
    expect(words.place).toBe("Gmail, account sean@example.com");
    expect(words.spoken).toBe("Send messages with Gmail, Gmail, account sean@example.com, to bob@example.com and eve@example.com");
    for (const said of [spokenApprovalPrompt(pending(withAccount), "Ada", true), spokenApprovalPrompt(pending(withAccount), "Ada"), spokenQueueItem(pending(withAccount), "Ada")]) {
      expect(said).toContain(words.place);
      expect(said).toContain(words.spoken);
    }
    // no account: the title already names the app, so the place line is not repeated
    expect(grantRowWords(rows[0]!).spoken).toBe("Read Gmail");
    expect(spokenGrantRows(withAccount)).toBe(`1 action: 1, ${words.spoken}.`);
  });

  it("the queue reads the same rows", () => {
    const item = spokenQueueItem(pending(rows), "Ada", "Training");
    expect(item).toContain(spokenGrantRows(rows).replace(/[.]$/, ""));
    expect(item).toContain("for the routine Training");
  });

  it("a card with no rows keeps its earlier wording", () => {
    expect(spokenApprovalPrompt(pending([]), "Ada", true)).toMatch(/^Can I .+\? Yes or no\.$/);
  });

  it("class: the card's rows and the voice take their words from one function", () => {
    const card = read("./RoutineGrantParts.tsx");
    expect(card).toContain("grantRowWords(row)");
    expect(card).not.toContain("{rowTitle(row)}");
    const words = read("../lib/routine-grant-words.ts");
    const spoken = words.slice(words.indexOf("export function spokenGrantRows("));
    expect(spoken.slice(0, spoken.indexOf("\n}\n"))).toContain("grantRowWords(row)");
    for (const call of ["./CallView.tsx", "./GroupCallView.tsx"]) {
      const source = read(call);
      expect(source, call).toContain("spokenApprovalPrompt(");
      expect(source, call).toContain("spokenQueueList(");
    }
  });
});
