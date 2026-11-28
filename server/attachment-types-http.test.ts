// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ZipFile } from "yazl";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";

let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;

beforeAll(async () => {
  fixture = await launchVerificationServer();
  await expect(runControlMurage(["doctor", "--url", fixture.info.url])).resolves.toMatchObject({ ok: true });
}, 60_000);

afterAll(async () => { await fixture?.close(); });

const upload = (name: string, mime: string, body: Buffer) =>
  fetch(`${fixture.info.url}/api/files?name=${encodeURIComponent(name)}`, {
    method: "POST", headers: { "content-type": mime }, body,
  });

it.each([
  ["bundle.zip", "application/zip"],
  ["bundle.tar.gz", "application/gzip"],
  ["bundle.7z", "application/x-7z-compressed"],
])("stores opaque %s with its saved name and exact bytes", async (name, mime) => {
  const bytes = Buffer.from("opaque archive fixture");
  const response = await upload(name, mime, bytes);
  expect(response.status).toBe(201);
  const saved = await response.json() as { path: string; mime: string; name: string };
  expect(saved).toMatchObject({ name, mime });
  expect(saved.path.endsWith(name.slice(name.indexOf(".")))).toBe(true);
  expect(readFileSync(saved.path)).toEqual(bytes);
});

async function xmindFixture(content: string): Promise<Buffer> {
  const map = new ZipFile();
  map.addBuffer(Buffer.from(content), "content.json");
  map.end();
  const parts: Buffer[] = [];
  for await (const part of map.outputStream) {
    parts.push(typeof part === "string" ? Buffer.from(part) : part);
  }
  return Buffer.concat(parts);
}

it("converts an XMind document to an attachable Markdown outline", async () => {
  const map = await xmindFixture(JSON.stringify([{ title: "Plan", rootTopic: {
    title: "Launch", children: { attached: [{ title: "Review" }], detached: [{ title: "Notes" }] },
  } }]));
  const response = await upload("plan.xmind", "application/x-xmind", map);
  expect(response.status).toBe(201);
  const saved = await response.json() as { path: string; mime: string; name: string };
  expect(saved).toMatchObject({ name: "plan.md", mime: "text/markdown" });
  expect(readFileSync(saved.path, "utf8")).toBe("# Plan\n\n- Launch\n  - Review\n  - Notes\n");
});

it("leaves the attachment directory unchanged after a rejected mind map", async () => {
  const dir = join(fixture.info.dataDir, "attachments");
  const contents = () => existsSync(dir) ? readdirSync(dir).sort() : [];
  const before = contents();
  const invalid = await xmindFixture(JSON.stringify([{ title: "Draft" }]));
  const response = await upload("draft.xmind", "application/x-xmind", invalid);
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain("Draft");
  expect(contents()).toEqual(before);
});
