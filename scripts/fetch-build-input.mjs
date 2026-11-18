// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Reviewed build inputs. Both endpoints must yield the same pinned bytes.
// Alternate endpoints can share an upstream service; they are not an outage SLA.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BUILD_INPUTS = JSON.parse(readFileSync(new URL("./build-inputs.json", import.meta.url), "utf8"));

export function buildInputUrls(url, sha256, pins = BUILD_INPUTS) {
  const pin = Object.values(pins).find(pin => pin.urls.includes(url));
  if (pin && pin.sha256 !== sha256) throw Error("Build input sha256 disagrees with reviewed pin");
  return pin ? [url, ...pin.urls.filter(source => source !== url)] : [url];
}

/** Never return or write partial, oversized, or unverified input, from either source. */
export async function fetchBuildInput(url, { sha256, bytes, maxBytes = bytes ?? 256 * 1024 ** 2,
  fetchImpl = globalThis.fetch, timeoutMs = 180_000, pins = BUILD_INPUTS } = {}) {
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? "")) throw Error("Build input requires a pinned sha256");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw Error("Invalid build input bytes limit");
  let last;
  for (const source of buildInputUrls(url, sha256, pins)) {
    try {
      if (new URL(source).protocol !== "https:") throw Error("Build inputs require HTTPS");
      const headers = new URL(source).hostname === "api.github.com" ? { Accept: "application/octet-stream" } : {};
      const response = await fetchImpl(source, { headers, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) { await response.body?.cancel?.(); throw Error(`HTTP ${response.status}`); }
      if (response.url && new URL(response.url).protocol !== "https:") throw Error("Build input redirect requires HTTPS");
      const chunks = []; let size = 0;
      if (response.body) {
        for await (const part of response.body) {
          size += part.length;
          if (size > maxBytes) { throw Error("Build input bytes limit exceeded"); }
          chunks.push(Buffer.from(part));
        }
      } else {
        const part = Buffer.from(await response.arrayBuffer()); size = part.length;
        if (size > maxBytes) throw Error("Build input bytes limit exceeded");
        chunks.push(part);
      }
      if (bytes !== undefined && size !== bytes) throw Error("Build input verification failed: bytes mismatch");
      const body = Buffer.concat(chunks);
      if (createHash("sha256").update(body).digest("hex") !== sha256) throw Error("Build input verification failed: sha256 (SHA-256) mismatch");
      return new Response(body);
    } catch (error) { last = error; }
  }
  throw Error(`Build input download failed: ${last?.message ?? "no sources"}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [id, output, ...extra] = process.argv.slice(2);
    const pin = BUILD_INPUTS[id];
    if (!pin || !output || extra.length) throw Error("usage: node scripts/fetch-build-input.mjs INPUT_ID OUTPUT");
    const response = await fetchBuildInput(pin.urls[0], pin);
    writeFileSync(output, Buffer.from(await response.arrayBuffer()), { flag: "wx" });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
