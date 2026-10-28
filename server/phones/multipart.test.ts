// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readShareParts, ShareBodyError } from "./multipart.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(HERE, "..", "..", "apps", "mobile", "contract", "phone-ask.json"), "utf8")).share;
const SAMPLE: string = fixture.multipart.body;
const CT: string = fixture.multipart.contentType;
const B = "murage-share-boundary-0001";
const LIMITS = { maxBytes: 60 * 1024 * 1024, maxParts: 11 };

async function* chunks(buf: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, Math.min(buf.length, i + size));
}
const whole = (s: string) => chunks(Buffer.from(s, "latin1"), Number.MAX_SAFE_INTEGER);

async function drain(data: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const c of data) out.push(c);
  return Buffer.concat(out);
}
type Seen = Array<{ name: string; json?: unknown; filename?: string; mime?: string; data?: Buffer }>;
async function read(body: AsyncIterable<Buffer>, contentType = CT, o = LIMITS): Promise<Seen> {
  const seen: Seen = [];
  for await (const part of readShareParts(body, contentType, o)) {
    if (part.name === "manifest") seen.push({ name: "manifest", json: part.json });
    else seen.push({ name: part.name, filename: part.filename, mime: part.mime, data: await drain(part.data) });
  }
  return seen;
}
async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { if (e instanceof ShareBodyError) return e.code; throw e; }
  return "no error";
}

const part = (name: string, extra: string, type: string, data: string) =>
  `--${B}\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n${type}\r\n${data}\r\n`;
const MAN = part("manifest", "", "Content-Type: application/json\r\n", '{"items":[]}');
const item = (n: number, filename = "a.txt", data = "x", mime = "text/plain") => part(`item-${n}`, `; filename="${filename}"`, `Content-Type: ${mime}\r\n`, data);
const END = `--${B}--\r\n`;

describe("readShareParts (S35)", () => {
  it("parses the fixture sample to the manifest and both items, byte for byte", async () => {
    const seen = await read(whole(SAMPLE));
    expect(seen.map((p) => p.name)).toEqual(["manifest", "item-1", "item-2"]);
    expect(seen[0]!.json).toEqual(fixture.manifest.valid);
    expect(seen[1]).toMatchObject({ filename: "note.txt", mime: "text/plain" });
    expect(seen[1]!.data!.toString("latin1")).toBe("hello\n");
    expect(seen[2]).toMatchObject({ filename: "data.csv", mime: "text/csv" });
    expect(seen[2]!.data!.toString("latin1")).toBe("a,b\n1,2\n");
  });

  it("parses the same at every chunk size from 1 to 64 (the boundary splits at every offset)", async () => {
    for (let size = 1; size <= 64; size++) {
      const seen = await read(chunks(Buffer.from(SAMPLE, "latin1"), size));
      expect(seen.map((p) => p.name), `size ${size}`).toEqual(["manifest", "item-1", "item-2"]);
      expect(seen[1]!.data!.toString("latin1"), `size ${size}`).toBe("hello\n");
      expect(seen[2]!.data!.toString("latin1"), `size ${size}`).toBe("a,b\n1,2\n");
    }
  });

  it("keeps binary item bytes, including CR LF dashes that are not the boundary, and an empty item", async () => {
    const bin = Buffer.from([0, 255, 13, 10, 45, 45, 1, 2, 13, 10, 45]);
    const withBin = Buffer.concat([Buffer.from(MAN + `--${B}\r\nContent-Disposition: form-data; name="item-1"; filename="a.bin"\r\nContent-Type: application/pdf\r\n\r\n`, "latin1"), bin, Buffer.from(`\r\n${item(2, "e.txt", "")}${END}`, "latin1")]);
    for (const size of [1, 3, 7, 1000]) {
      const seen = await read(chunks(withBin, size));
      expect(seen[1]!.data!.equals(bin)).toBe(true);
      expect(seen[2]!.data!.length).toBe(0);
    }
  });

  it("accepts a manifest alone, a quoted boundary and a body with no trailing CRLF", async () => {
    expect((await read(whole(MAN + END))).map((p) => p.name)).toEqual(["manifest"]);
    expect((await read(whole(MAN + END), `multipart/form-data; boundary="${B}"`)).length).toBe(1);
    expect((await read(whole(MAN + END.trimEnd()))).length).toBe(1);
  });

  describe("refuses, as invalid", () => {
    const bad: Array<[string, string, string?]> = [
      ["a content type that is not multipart/form-data", MAN + END, "application/json"],
      ["multipart/mixed", MAN + END, `multipart/mixed; boundary=${B}`],
      ["no boundary", MAN + END, "multipart/form-data"],
      ["an empty boundary", MAN + END, "multipart/form-data; boundary="],
      ["a boundary over 70 characters", MAN + END, `multipart/form-data; boundary=${"b".repeat(71)}`],
      ["a boundary with a space or CRLF", MAN + END, "multipart/form-data; boundary=a b"],
      ["an extra content type parameter", MAN + END, `multipart/form-data; boundary=${B}; charset=utf-8`],
      ["a preamble before the first boundary", "junk\r\n" + MAN + END],
      ["a first part that is not the manifest", item(1) + END],
      ["a manifest that is not application/json", part("manifest", "", "Content-Type: text/plain\r\n", "{}") + END],
      ["a manifest that is not JSON", part("manifest", "", "Content-Type: application/json\r\n", "{nope") + END],
      ["a repeated manifest", MAN + MAN + END],
      ["an unknown part name", MAN + part("other", '; filename="a"', "Content-Type: text/plain\r\n", "x") + END],
      ["an item out of order", MAN + item(2) + END],
      ["a repeated item name", MAN + item(1) + item(1) + END],
      ["item-0", MAN + item(0) + END],
      ["an item with no filename", MAN + part("item-1", "", "Content-Type: text/plain\r\n", "x") + END],
      ["an empty filename", MAN + item(1, "") + END],
      ["a filename with a slash", MAN + item(1, "a/b.txt") + END],
      ["a filename with a backslash", MAN + item(1, "a\\b.txt") + END],
      ["a filename that is ..", MAN + item(1, "..") + END],
      ["a filename with a NUL", MAN + item(1, "a\u0000b") + END],
      ["a filename over 255 characters", MAN + item(1, "a".repeat(256)) + END],
      ["a nested multipart item", MAN + item(1, "a.txt", "x", `multipart/mixed; boundary=zz`) + END],
      ["an item mime with a parameter", MAN + item(1, "a.txt", "x", "text/plain; format=flowed") + END],
      ["a text mime with charset and another parameter", MAN + item(1, "a.txt", "x", "text/plain; charset=utf-8; format=flowed") + END],
      ["a text mime with an empty charset", MAN + item(1, "a.txt", "x", "text/plain; charset=") + END],
      ["a non-text mime with a charset", MAN + item(1, "a.png", "x", "image/png; charset=utf-8") + END],
      ["a json item with a charset", MAN + item(1, "a.json", "x", "application/json; charset=utf-8") + END],
      ["an item with no content type", MAN + part("item-1", '; filename="a.txt"', "", "x") + END],
      ["a header that is not allowed", MAN + part("item-1", '; filename="a.txt"', "Content-Type: text/plain\r\nX-Evil: 1\r\n", "x") + END],
      ["a repeated header", MAN + part("item-1", '; filename="a.txt"', "Content-Type: text/plain\r\nContent-Type: text/plain\r\n", "x") + END],
      ["a folded header line", MAN + part("item-1", '; filename="a.txt"', "Content-Type: text/plain\r\n  folded\r\n", "x") + END],
      ["a bare LF in a header", MAN + part("item-1", '; filename="a.txt"', "Content-Type: text/plain\nX-Evil: 1\r\n", "x") + END],
      ["a bare CR in a header", MAN + part("item-1", '; filename="a\rb.txt"', "Content-Type: text/plain\r\n", "x") + END],
      ["a header line over 1 KB", MAN + part("item-1", `; filename="${"a".repeat(1100)}"`, "Content-Type: text/plain\r\n", "x") + END],
      ["a header line over 1 KB with no CRLF at all", MAN + `--${B}\r\nContent-Disposition: ${"a".repeat(5000)}`],
      ["bytes after a boundary", MAN + `--${B}xx\r\n`],
      ["bytes after the final boundary", MAN + END + "tail"],
      ["a missing final boundary", MAN + item(1)],
      ["a body that ends inside a header", MAN + `--${B}\r\nContent-Disp`],
      ["an empty body", ""],
    ];
    for (const [label, body, ct] of bad) {
      it(label, async () => {
        for (const size of [Number.MAX_SAFE_INTEGER, 5]) {
          expect(await codeOf(read(chunks(Buffer.from(body, "latin1"), size), ct ?? CT)), `${label} @${size}`).toBe("invalid");
        }
      });
    }

    it("a filename that is not valid UTF-8", async () => {
      const raw = Buffer.concat([Buffer.from(MAN + `--${B}\r\nContent-Disposition: form-data; name="item-1"; filename="a`, "latin1"), Buffer.from([0xff]), Buffer.from(`.txt"\r\nContent-Type: text/plain\r\n\r\nx\r\n${END}`, "latin1")]);
      expect(await codeOf(read(chunks(raw, 4)))).toBe("invalid");
    });

    it("an item whose data was not consumed before the next part is asked for", async () => {
      const gen = readShareParts(whole(MAN + item(1) + item(2) + END), CT, LIMITS);
      await gen.next();
      const first = await gen.next();
      expect(first.done).toBe(false);
      await expect(gen.next()).rejects.toMatchObject({ code: "invalid" });
    });

    it("an item whose data is read twice", async () => {
      const gen = readShareParts(whole(MAN + item(1) + END), CT, LIMITS);
      await gen.next();
      const first = await gen.next();
      const data = (first.value as { data: AsyncIterable<Buffer> }).data;
      await drain(data);
      expect(() => data[Symbol.asyncIterator]()).toThrow(ShareBodyError);
    });
  });

  describe("caps", () => {
    it("more than maxParts parts is invalid", async () => {
      const body = MAN + item(1) + item(2) + item(3) + END;
      expect(await codeOf(read(whole(body), CT, { maxBytes: 1 << 20, maxParts: 3 }))).toBe("invalid");
      expect((await read(whole(body), CT, { maxBytes: 1 << 20, maxParts: 4 })).length).toBe(4);
    });

    it("a manifest over 64 KB is too_large", async () => {
      const big = part("manifest", "", "Content-Type: application/json\r\n", JSON.stringify({ pad: "x".repeat(70000) }));
      expect(await codeOf(read(chunks(Buffer.from(big + END, "latin1"), 4096)))).toBe("too_large");
    });

    it("a total over maxBytes is too_large", async () => {
      expect(await codeOf(read(whole(MAN + item(1, "a.txt", "y".repeat(500)) + END), CT, { maxBytes: 400, maxParts: 11 }))).toBe("too_large");
    });

    it("a 61 MiB stream throws too_large without buffering it (a counting source)", async () => {
      const MiB = 1024 * 1024;
      const slice = Buffer.alloc(64 * 1024, 0x61);
      let produced = 0;
      let returned = false;
      const head = Buffer.from(MAN + `--${B}\r\nContent-Disposition: form-data; name="item-1"; filename="big.bin"\r\nContent-Type: application/pdf\r\n\r\n`, "latin1");
      const source: AsyncIterable<Buffer> = {
        [Symbol.asyncIterator]() {
          let sent = false;
          return {
            async next() {
              if (!sent) { sent = true; produced += head.length; return { done: false, value: head }; }
              if (produced >= 61 * MiB) return { done: true, value: undefined };
              produced += slice.length;
              return { done: false, value: slice };
            },
            async return() { returned = true; return { done: true, value: undefined }; },
          };
        },
      };
      let held = 0;
      let peak = 0;
      const code = await codeOf((async () => {
        for await (const p of readShareParts(source, CT, { maxBytes: 60 * MiB, maxParts: 11 })) {
          if (p.name === "manifest") continue;
          for await (const c of p.data) { held = c.length; peak = Math.max(peak, held); }
        }
      })());
      expect(code).toBe("too_large");
      expect(produced).toBeLessThanOrEqual(60 * MiB + 2 * slice.length);
      expect(peak).toBeLessThanOrEqual(2 * slice.length);
      expect(returned).toBe(true);
    });
  });

  it("releases the source when the consumer stops early", async () => {
    let returned = false;
    const source: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]() {
        const inner = whole(MAN + item(1) + END)[Symbol.asyncIterator]();
        return { next: () => inner.next(), async return() { returned = true; return { done: true, value: undefined }; } };
      },
    };
    for await (const p of readShareParts(source, CT, LIMITS)) { void p; break; }
    expect(returned).toBe(true);
  });

  it("has no TypeScript-only runtime syntax (the server runs under strip-types)", () => {
    const src = readFileSync(join(HERE, "multipart.ts"), "utf8");
    expect(src).not.toMatch(/constructor\s*\(\s*(private|public|protected|readonly)\b/);
    expect(src).not.toMatch(/^\s*(export\s+)?(const\s+)?enum\s/m);
    expect(src).not.toMatch(/^\s*(export\s+)?namespace\s/m);
  });
});

describe("readShareParts text charset (S36)", () => {
  it.each([
    ["text/plain; charset=utf-8", "text/plain"],
    ["text/plain;charset=UTF-8", "text/plain"],
    ['text/csv; charset="utf-8"', "text/csv"],
    ["TEXT/Markdown; CharSet=\"ISO-8859-1\"", "text/markdown"],
  ])("accepts %s as %s", async (sent, mime) => {
    const seen = await read(whole(MAN + item(1, "a.txt", "x", sent) + END));
    expect(seen[1]).toMatchObject({ name: "item-1", mime });
  });
});
