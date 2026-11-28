// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A legacy content.xml of many unterminated comment, declaration or CDATA openers must be refused in about one pass, not rescanned
// once per fragment. Entered through saveFile (the upload path: POST /api/files -> saveFile -> xmindToMarkdown) with a real zip.
import { expect, it } from "vitest";
import { ZipFile } from "yazl";
import { saveFile } from "./attachments.ts";

function mindMapZip(entries: Record<string, string>): Promise<Buffer> {
  const zip = new ZipFile();
  const parts: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on("data", (chunk: Buffer) => parts.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(parts)));
    zip.outputStream.on("error", reject);
  });
  for (const [name, text] of Object.entries(entries)) zip.addBuffer(Buffer.from(text), name);
  zip.end();
  return done;
}

async function* chunks(bytes: Buffer) { yield bytes; }
const wrap = (body: string) => `<xmap-content>${body}</xmap-content>`;
const FRAGMENTS: Array<[string, string, number]> = [
  ["comment opener closed only by a bare >", "<!-- >", 240_000],
  ["CDATA opener closed only by a bare >", "<![CDATA[>", 400_000],
];

it.each(FRAGMENTS)("refuses %s in one pass", async (_name, fragment, size) => {
  const content = wrap(fragment.repeat(Math.ceil(size / fragment.length)));
  const zip = await mindMapZip({ "content.xml": content });
  const started = performance.now();
  await expect(saveFile(chunks(zip), "plan.xmind", "application/vnd.xmind.workbook")).rejects.toMatchObject({ status: 400 });
  expect(performance.now() - started).toBeLessThan(1000);
}, 60_000);

it("refuses a declaration opener without ?> inside an otherwise valid map", async () => {
  const content = wrap(`<?xml a><sheet><title>Plan</title><topic><title>Launch</title></topic></sheet>`);
  await expect(saveFile(chunks(await mindMapZip({ "content.xml": content })), "plan.xmind", "application/vnd.xmind.workbook")).rejects.toMatchObject({ status: 400 });
});

it("still reads a legacy map whose comment, declaration and CDATA are closed", async () => {
  const content = `<?xml version="1.0"?><!-- note --><xmap-content><sheet><title>Plan</title><topic><title><![CDATA[Launch & go]]></title></topic></sheet></xmap-content>`;
  const saved = await saveFile(chunks(await mindMapZip({ "content.xml": content })), "plan.xmind", "application/vnd.xmind.workbook");
  expect(saved.name).toMatch(/\.md$/);
});
