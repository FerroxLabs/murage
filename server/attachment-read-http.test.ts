// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Attachment reads through the real server (attachment read hardening r3):
// links, FIFOs and hard links in the attachment folder answer the same 404 a
// missing name gets, a FIFO never hangs a request, both avatar routes await
// the bounded check, and upload retries compare through the bounded reader.
import { execFileSync } from "node:child_process";
import { linkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const posixOnly = describe.skipIf(process.platform === "win32");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64");
let fixture: VerificationServer, headers: Record<string, string>, folder: string;

const uuid = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const within = async <T>(ms: number, work: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms); })]); }
  finally { clearTimeout(timer); }
};

posixOnly("attachment reads through the server", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env);
    const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
    const first = await fetch(`${fixture.info.url}/api/attachments`, { method: "POST", headers: { ...headers, "content-type": "image/png" }, body: PNG });
    expect(first.status).toBe(201);
    const saved = await first.json() as { path: string };
    folder = saved.path.slice(0, saved.path.lastIndexOf("/"));
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("a link, a FIFO and a hard link answer the missing-name 404, and a FIFO does not hang", async () => {
    const outside = join(fixture.info.dataDir, "outside.png");
    writeFileSync(outside, PNG);
    symlinkSync(outside, join(folder, `${uuid(1)}.png`));
    execFileSync("mkfifo", [join(folder, `${uuid(2)}.png`)]);
    writeFileSync(join(folder, `${uuid(3)}.png`), PNG);
    linkSync(join(folder, `${uuid(3)}.png`), join(fixture.info.dataDir, "second-link.png"));
    for (const n of [1, 2, 3, 4]) {
      const answer = await within(3000, fetch(`${fixture.info.url}/api/attachments/${uuid(n)}.png`, { headers }));
      expect(answer.status).toBe(404);
      expect(await answer.json()).toEqual({ error: "no such attachment" });
    }
  });

  it("both avatar routes await the bounded check: a link or FIFO is refused, a stored image is accepted", async () => {
    const made = await fetch(`${fixture.info.url}/api/bots`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "Avatar Check" }) });
    expect(made.status).toBeLessThan(300);
    const bot = (await made.json() as { bot?: { id: string }; id?: string });
    const id = bot.bot?.id ?? bot.id!;
    const upload = await fetch(`${fixture.info.url}/api/attachments`, { method: "POST", headers: { ...headers, "content-type": "image/png" }, body: PNG });
    const stored = (await upload.json() as { path: string }).path.split("/").at(-1)!;
    for (const route of [`/api/bots/${id}/profile`, `/api/bots/${id}`]) {
      for (const name of [`${uuid(1)}.png`, `${uuid(2)}.png`, `${uuid(3)}.png`]) {
        const refused = await within(3000, fetch(`${fixture.info.url}${route}`, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ avatarUrl: `/api/attachments/${name}` }) }));
        expect(refused.status).toBe(400);
        expect(await refused.json()).toEqual({ error: "avatarUrl must reference an existing stored image" });
      }
      const accepted = await fetch(`${fixture.info.url}${route}`, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ avatarUrl: `/api/attachments/${stored}` }) });
      expect(accepted.status).toBe(200);
    }
  });

  it("an upload retry onto a FIFO answers 409 at once, four in parallel, and a normal upload still completes", async () => {
    const id = uuid(5);
    execFileSync("mkfifo", [join(folder, `${id}.png`)]);
    const retries = await within(5000, Promise.all(Array.from({ length: 4 }, () =>
      fetch(`${fixture.info.url}/api/attachments?uploadId=${id}`, { method: "POST", headers: { ...headers, "content-type": "image/png" }, body: PNG }))));
    for (const retry of retries) { expect(retry.status).toBe(409); await retry.text(); }
    const fileId = uuid(6);
    execFileSync("mkfifo", [join(folder, `${fileId}.txt`)]);
    const file = await within(5000, fetch(`${fixture.info.url}/api/files?name=a.txt&uploadId=${fileId}`, { method: "POST", headers: { ...headers, "content-type": "text/plain" }, body: "hello" }));
    expect(file.status).toBe(409); await file.text();
    const normal = await fetch(`${fixture.info.url}/api/attachments?uploadId=${uuid(7)}`, { method: "POST", headers: { ...headers, "content-type": "image/png" }, body: PNG });
    expect(normal.status).toBe(201);
    const again = await fetch(`${fixture.info.url}/api/attachments?uploadId=${uuid(7)}`, { method: "POST", headers: { ...headers, "content-type": "image/png" }, body: PNG });
    expect(again.status).toBe(201);
    expect(await again.json()).toMatchObject({ path: join(folder, `${uuid(7)}.png`) });
  });
});
