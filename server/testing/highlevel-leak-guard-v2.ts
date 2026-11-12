// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Test-only leak scanner. A clean scan proves only the declared artifacts and
// intercepted sinks, not OS swap, external capture, or uninstrumented transports.
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { fromBuffer } from "yauzl";
const incomplete = () => new Error("Leak evidence is incomplete.");
const MAX_BYTES = 64 * 1024 * 1024;
const SINKS = ["telemetry", "model_context", "tool_context", "event_stream", "ipc_diagnostics", "logging"] as const;
export type HighLevelLeakSink = typeof SINKS[number];
export class HighLevelLeakGuardV2 {
  readonly #needles: Buffer[] = [];
  readonly #counts = Object.fromEntries(SINKS.map(sink => [sink, 0])) as Record<HighLevelLeakSink, number>;
  constructor(secrets: readonly string[]) {
    if (!secrets.length || secrets.some(value => !value)) throw incomplete();
    for (const secret of secrets) {
      const unicode = [...secret].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
      const variants = new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret),
        encodeURIComponent(encodeURIComponent(secret)), Buffer.from(secret).toString("base64"),
        Buffer.from(secret).toString("base64url"), Buffer.from(secret).toString("hex"), unicode,
        JSON.stringify(unicode).slice(1, -1)]);
      for (const value of variants) this.#needles.push(Buffer.from(value));
      const wide = Buffer.from(secret, "utf16le");
      this.#needles.push(wide, Buffer.from(wide).swap16());
    }
  }
  #leaks(bytes: Buffer): number { return this.#needles.some(needle => bytes.includes(needle)) ? 1 : 0; }
  wrapSink<T extends unknown[]>(sink: HighLevelLeakSink, write: (...args: T) => unknown): (...args: T) => unknown {
    if (!SINKS.includes(sink)) throw incomplete();
    return (...args: T) => {
      let bytes: Buffer;
      try { bytes = Buffer.from(JSON.stringify(args)); } catch { throw incomplete(); }
      if (this.#leaks(bytes)) { this.#counts[sink]++; throw new Error("A secret reached a protected sink."); }
      return write(...args);
    };
  }
  sinkCounts(): Record<HighLevelLeakSink, number> { return { ...this.#counts }; }
  /** Every declared artifact must exist and be readable. Binary SQLite/WAL,
   * logs, journals, cache files and gzip/zip archives all use the same scanner.
   * Paths and matching contents are deliberately absent from the result. */
  async scanFiles(paths: readonly string[]): Promise<{ files: number; decoded: number; leaks: number }> {
    if (!paths.length) throw incomplete();
    const result = { files: 0, decoded: 0, leaks: 0 };
    let budget = MAX_BYTES;
    const scan = async (bytes: Buffer, depth: number): Promise<void> => {
      budget -= bytes.length;
      if (budget < 0 || depth > 8) throw incomplete();
      result.leaks += this.#leaks(bytes);
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        result.decoded++; await scan(gunzipSync(bytes, { maxOutputLength: MAX_BYTES }), depth + 1);
      } else if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) {
        await new Promise<void>((resolve, reject) => {
          fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
            if (error || !zip) { reject(incomplete()); return; }
            const fail = () => { zip.close(); reject(incomplete()); };
            zip.on("error", fail);
            zip.on("end", resolve);
            zip.on("entry", entry => {
              if (entry.generalPurposeBitFlag & 1 || entry.uncompressedSize > MAX_BYTES) { fail(); return; }
              if (entry.fileName.endsWith("/")) { zip.readEntry(); return; }
              zip.openReadStream(entry, (readError, stream) => {
                if (readError || !stream) { fail(); return; }
                const chunks: Buffer[] = []; let length = 0;
                stream.on("error", fail);
                stream.on("data", (chunk: Buffer) => { length += chunk.length; if (length > MAX_BYTES) { stream.destroy(); fail(); } else chunks.push(chunk); });
                stream.on("end", () => {
                  result.decoded++;
                  scan(Buffer.concat(chunks), depth + 1).then(() => zip.readEntry(), fail);
                });
              });
            });
            zip.readEntry();
          });
        });
      }
    };
    const visit = async (path: string): Promise<void> => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw incomplete();
      if (stat.isDirectory()) {
        const children = readdirSync(path);
        if (!children.length) throw incomplete();
        for (const child of children) await visit(join(path, child));
      } else {
        if (!stat.isFile() || stat.size > MAX_BYTES || stat.size > budget) throw incomplete();
        result.files++; await scan(readFileSync(path), 0);
      }
    };
    try { for (const path of paths) await visit(path); }
    catch { throw incomplete(); }
    if (!result.files) throw incomplete();
    return result;
  }
}
