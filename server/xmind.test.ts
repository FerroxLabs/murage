// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { ZipFile } from "yazl";

export async function mindMapZip(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on("data", chunk => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
  for (const [name, text] of Object.entries(entries)) zip.addBuffer(Buffer.from(text), name);
  zip.end();
  return done;
}

it("turns every XMind sheet, attached and detached topic into a Markdown outline", async () => {
  const { xmindToMarkdown } = await import("./xmind.ts");
  const bytes = await mindMapZip({ "content.json": JSON.stringify([
    { title: "Plan", rootTopic: { title: "Launch", children: { attached: [{ title: "Build\nnext", notes: { plain: { content: "Private note" } } }], detached: [{ title: "Review" }] } } },
    { title: "People", rootTopic: { title: "Team" } },
  ]) });
  expect(await xmindToMarkdown(bytes)).toBe("# Plan\n\n- Launch\n  - Build next\n  - Review\n\n# People\n\n- Team\n");
});

it("limits the outline's topic count and final byte count", async () => {
  const { xmindToMarkdown } = await import("./xmind.ts");
  const wide = [{ rootTopic: { title: "root", children: { attached: Array.from({ length: 10_001 }, () => ({ title: "child" })) } } }];
  await expect(xmindToMarkdown(await mindMapZip({ "content.json": JSON.stringify(wide) }))).rejects.toThrow();
  const long = [{ rootTopic: { title: "x".repeat(2 * 1024 * 1024 + 1) } }];
  await expect(xmindToMarkdown(await mindMapZip({ "content.json": JSON.stringify(long) }))).rejects.toThrow();
});

it("accepts the entry limit and refuses an otherwise valid map with one extra entry", async () => {
  const { xmindToMarkdown } = await import("./xmind.ts");
  const entries = Object.fromEntries(Array.from({ length: 255 }, (_, index) => [`notes/note-${index}.txt`, "notes"]));
  entries["content.json"] = JSON.stringify([{ title: "Plan", rootTopic: { title: "Launch" } }]);
  await expect(xmindToMarkdown(await mindMapZip(entries))).resolves.toBe("# Plan\n\n- Launch\n");
  await expect(xmindToMarkdown(await mindMapZip({ ...entries, "notes/extra.txt": "notes" }))).rejects.toMatchObject({ status: 400 });
});

it("saves a readable outline for standard, ZIP and generic browser XMind types", async () => {
  const { saveFile } = await import("./attachments.ts");
  const { readFileSync } = await import("node:fs");
  const bytes = await mindMapZip({ "content.json": JSON.stringify([{ title: "Plan", rootTopic: { title: "Launch" } }]) });
  async function* chunks() { yield bytes; }
  for (const mime of ["application/vnd.xmind.workbook", "application/zip", "application/octet-stream"]) {
    const saved = await saveFile(chunks(), "plan.xmind", mime);
    expect(saved).toMatchObject({ name: "plan.md", mime: "text/markdown" });
    expect(saved.path).toMatch(/\.md$/);
    expect(readFileSync(saved.path, "utf8")).toBe("# Plan\n\n- Launch\n");
  }
});

it("bounds simultaneous mind map reads and releases every failed conversion", async () => {
  const { saveFile } = await import("./attachments.ts");
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  async function* chunks() { await hold; yield Buffer.from("not a mind map"); }
  const first = saveFile(chunks(), "first.xmind", "application/x-xmind").catch(error => error);
  const second = saveFile(chunks(), "second.xmind", "application/x-xmind").catch(error => error);
  await expect(saveFile(chunks(), "third.xmind", "application/x-xmind")).rejects.toMatchObject({ status: 503 });
  release();
  expect(await first).toMatchObject({ status: 400 });
  expect(await second).toMatchObject({ status: 400 });
  await expect(saveFile(chunks(), "last.xmind", "application/x-xmind")).rejects.toMatchObject({ status: 400 });
});

it("reads a legacy XML sheet as an outline", async () => {
  const { xmindToMarkdown } = await import("./xmind.ts");
  const bytes = await mindMapZip({ "content.xml": '<xmap-content><sheet><title>Plan &amp; notes</title><topic><title>Launch</title><children><topics type="attached"><topic><title>Build</title></topic></topics></children></topic></sheet></xmap-content>' });
  expect(await xmindToMarkdown(bytes)).toBe("# Plan &amp; notes\n\n- Launch\n  - Build\n");
});
