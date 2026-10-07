import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NOTICE_TEXT, detail, notice } from "./push-outcome";

const f = JSON.parse(readFileSync(new URL("../contract/push-outcomes.json", import.meta.url), "utf8")) as {
  noticeText: Record<string, { title: string; body: string }>;
  detail: { status: number | null; body: unknown; category: never; expect: unknown }[];
  notice: { status: number | null; body: unknown; decision: "allow" | "deny"; expect: string }[];
};

describe("PushOutcome", () => {
  it.each(f.detail)("detail $status for $category", (c: { status: number | null; body: unknown; category: never; expect: unknown }) => {
    expect(detail(c.status, c.body, c.category)).toEqual(c.expect);
  });
  it.each(f.notice)("respond $status ($decision) is $expect", (c: { status: number | null; body: unknown; decision: "allow" | "deny"; expect: string }) => {
    expect(notice(c.status, c.body, c.decision)).toBe(c.expect);
  });
  it("words match the fixture and the copy rules", () => {
    expect(NOTICE_TEXT).toEqual(f.noticeText);
    for (const t of Object.values(NOTICE_TEXT)) expect(`${t.title} ${t.body}`).not.toMatch(/—|\bsafe(ty)?\b/i);
  });
});
