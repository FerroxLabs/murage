import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";

it("streams a bounded upload through the isolated app, preserves retry bytes and serves its image", async () => {
  const session = await launchVerificationServer();
  try {
    await expect(runControlMurage(["doctor", "--url", session.info.url])).resolves.toMatchObject({ ok: true });
    const id = "11111111-1111-4111-8111-111111111111";
    const body = () => new ReadableStream<Uint8Array>({ start(controller) {
      for (let i = 0; i < 25; i++) controller.enqueue(new Uint8Array(1024 * 1024).fill(7));
      controller.close();
    } });
    const upload = () => fetch(`${session.info.url}/api/files?name=fixture.txt&uploadId=${id}`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: body(), duplex: "half",
    } as RequestInit & { duplex: "half" });
    const first = await upload(); expect(first.status).toBe(201);
    const saved = await first.json() as { path: string; bytes: number };
    expect(saved.path).toBe(join(realpathSync(session.info.dataDir), "attachments", `${id}.txt`));
    expect(saved.bytes).toBe(25 * 1024 * 1024);
    expect(createHash("sha256").update(readFileSync(saved.path)).digest("hex"))
      .toBe(createHash("sha256").update(Buffer.alloc(saved.bytes, 7)).digest("hex"));
    const retry = await upload(); expect(retry.status).toBe(201);
    expect(await retry.json()).toMatchObject({ path: saved.path, bytes: saved.bytes });
    const changed = await fetch(`${session.info.url}/api/files?name=fixture.txt&uploadId=${id}`, { method: "POST", headers: { "content-type": "text/plain" }, body: "different" });
    expect(changed.status).toBe(409); await changed.text();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64");
    const image = await fetch(`${session.info.url}/api/attachments`, { method: "POST", headers: { "content-type": "image/png" }, body: png });
    expect(image.status).toBe(201);
    const imageSaved = await image.json() as { path: string };
    const imageName = imageSaved.path.split(/[\\/]/).at(-1)!;
    const read = await fetch(`${session.info.url}/api/attachments/${imageName}`);
    expect(read.status).toBe(200); expect(Buffer.from(await read.arrayBuffer())).toEqual(png);
    expect(readdirSync(join(session.info.dataDir, "attachments"))).toHaveLength(2);
    expect(readdirSync(join(session.info.dataDir, "attachments")).some(name => name.endsWith(".partial"))).toBe(false);
  } finally { await session.close(); }
  expect(existsSync(session.info.dataDir)).toBe(false);
}, 30000);
