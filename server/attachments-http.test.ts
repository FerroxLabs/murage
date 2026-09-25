import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";
import { dataDirLeasePaths } from "../electron/data-dir-lease.mjs";

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
    // saved under the harness's canonical data dir: the lease's spelling
    // (on Windows long and case-folded, whatever mkdtemp returned)
    expect(saved.path).toBe(join(dataDirLeasePaths(session.info.dataDir).canonicalDataDir, "attachments", `${id}.txt`));
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

/** An RGB PNG of the given size, written by hand so the test needs no image library. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) { row[1 + x * 3] = x % 256; row[2 + x * 3] = (x * 7) % 256; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

it("answers ?w= with a smaller WebP, the original when it is already small, and 400 for other widths", async () => {
  const session = await launchVerificationServer();
  try {
    const upload = async (bytes: Buffer) => {
      const saved = await (await fetch(`${session.info.url}/api/attachments`, { method: "POST", headers: { "content-type": "image/png" }, body: bytes })).json() as { path: string };
      return saved.path.split(/[\\/]/).at(-1)!;
    };
    const wide = png(2000, 40);
    const wideName = await upload(wide);
    const thumb = await fetch(`${session.info.url}/api/attachments/${wideName}?w=320`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toBe("image/webp");
    expect(thumb.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(thumb.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = Buffer.from(await thumb.arrayBuffer());
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("ascii")).toBe("WEBP");
    expect(bytes.byteLength).toBeLessThan(wide.byteLength);
    // no w: the original, byte for byte, exactly as before
    const original = await fetch(`${session.info.url}/api/attachments/${wideName}`);
    expect(original.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await original.arrayBuffer())).toEqual(wide);
    // already narrower than asked: the original
    const small = png(200, 20);
    const smallName = await upload(small);
    const same = await fetch(`${session.info.url}/api/attachments/${smallName}?w=640`);
    expect(same.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await same.arrayBuffer())).toEqual(small);
    // a width outside the set
    const refused = await fetch(`${session.info.url}/api/attachments/${wideName}?w=321`);
    expect(refused.status).toBe(400);
    await refused.text();
  } finally { await session.close(); }
}, 30000);
