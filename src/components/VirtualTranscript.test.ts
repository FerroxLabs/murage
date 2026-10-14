// The transcript mounts what is on screen, not the conversation. Rendered to
// markup in node (the renderer suite has no DOM): the first paint of a thread
// is the live end, before any measuring, so this is exactly what a switch
// commits. Scroll behaviour is in lib/virtual-transcript.test.ts.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { VirtualTranscript } from "./VirtualTranscript";
import { MAX_MOUNTED_ITEMS } from "@/lib/virtual-transcript";

type Row = { id: string; text: string };
const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, text: `message ${i}` }));
const scrollRef = { current: null };
const followRef = { current: true };

function markup(items: Row[], extra: Record<string, unknown> = {}, render?: (row: Row, index: number) => unknown) {
  return renderToStaticMarkup(createElement(VirtualTranscript<Row>, {
    items,
    keyOf: (row: Row) => row.id,
    render: (render ?? ((row: Row) => createElement("div", { "data-row": row.id, className: "transcript-row" }, row.text))) as never,
    scrollRef,
    followRef,
    follow: true,
    resetKey: "thread-1",
    ...extra,
  }));
}
const mounted = (html: string) => html.match(/data-vkey="/g)?.length ?? 0;

describe("VirtualTranscript", () => {
  it("mounts a bounded number of rows for a 200,000-message thread", () => {
    const html = markup(rows(200_000));
    const count = mounted(html);
    expect(count).toBeGreaterThan(5);
    expect(count).toBeLessThanOrEqual(MAX_MOUNTED_ITEMS);
    expect(count).toBeLessThan(40);
    // the live end: the newest row is on screen, the oldest is not
    expect(html).toContain('data-vkey="m199999"');
    expect(html).not.toContain('data-vkey="m0"');
  });

  it("mounts the same handful for a 100-row page as for 200,000", () => {
    expect(mounted(markup(rows(100)))).toBe(mounted(markup(rows(200_000))));
  });

  it("stands in for the unmounted rows with padding, so the scrollbar is the whole thread", () => {
    const html = markup(rows(1_000));
    const top = Number(/padding-top:(\d+(?:\.\d+)?)px/.exec(html)?.[1]);
    expect(top).toBeGreaterThan(100_000);
  });

  it("brings a jumped-to row into the mounted range", () => {
    const html = markup(rows(5_000), { focusKey: "m1200" });
    expect(html).toContain('data-vkey="m1200"');
    expect(html).not.toContain('data-vkey="m4999"');
    expect(mounted(html)).toBeLessThan(40);
  });

  it("keeps rows in their order inside one list, and a row that renders nothing takes no wrapper", () => {
    const html = markup(rows(30), {}, (row, index) => (index % 2 ? null : createElement("p", null, row.text)));
    const order = [...html.matchAll(/data-vkey="m(\d+)"/g)].map((match) => Number(match[1]));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((index) => index % 2 === 0)).toBe(true);
  });

  it("renders nothing for an empty conversation", () => {
    expect(markup([])).toBe("");
  });
});

describe("both transcripts mount through VirtualTranscript", () => {
  const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
  it.each([["ChatView", read("./ChatView.tsx")], ["GroupView", read("./GroupView.tsx")]])("%s", (_name, source) => {
    expect(source).toContain("<VirtualTranscript");
    expect(source).toContain("focusKey={itemKeyHolding(items, focusedId)}");
    expect(source).toMatch(/scrollRef=\{scrollRef\}\s+followRef=\{followRef\}\s+follow=\{follow\}/);
    // the old full map over every held row is gone
    expect(source).not.toMatch(/\{items\.map\(\(item(?:, i)?\) => \{/);
  });
});
