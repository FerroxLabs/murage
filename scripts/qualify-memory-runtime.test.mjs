// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const body = "reviewed fixture model";
const sha256 = createHash("sha256").update(body).digest("hex");
const sources = ["https://huggingface.co/fixture/model/resolve/revision/config.json", "https://hf-mirror.com/fixture/model/resolve/revision/config.json"];

// Run the actual CLI against a tiny task-owned manifest and injected transport.
// No model, live application data, or external endpoint is touched.
function qualify(primary, mirror = "good", partial, tempRoot = tmpdir()) {
  const root = realpathSync(mkdtempSync(join(tempRoot, "memory-download-test-")));
  try {
    for (const dir of ["scripts", "shared", "model"]) mkdirSync(join(root, dir));
    symlinkSync(resolve("server"), join(root, "server"), "dir");
    for (const file of ["qualify-memory-runtime.ts", "fetch-build-input.mjs"]) copyFileSync(resolve("scripts", file), join(root, "scripts", file));
    writeFileSync(join(root, "shared/memory-model-manifest.json"), JSON.stringify({ model: "fixture/model", revision: "revision", files: [{ path: "config.json", bytes: Buffer.byteLength(body), sha256 }] }));
    writeFileSync(join(root, "scripts/build-inputs.json"), JSON.stringify({ fixture: { sha256, urls: sources } }));
    writeFileSync(join(root, "model/.murage-memory-qualification"), "revision");
    if (partial !== undefined) writeFileSync(join(root, "model/config.json.part"), partial);
    const preload = join(root, "fetch.mjs"), callsFile = join(root, "calls.jsonl");
    writeFileSync(preload, `import { appendFileSync } from 'node:fs';
const sources = ${JSON.stringify(sources)}, modes = ${JSON.stringify([primary, mirror])}, body = ${JSON.stringify(body)};
globalThis.fetch = async (url, options) => {
  const index = sources.indexOf(url);
  if (index < 0) throw Error('Unexpected fixture URL');
  appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({url, headers: options.headers}) + '\\n');
  const mode = modes[index];
  if (typeof mode === 'number') return new Response('unavailable', {status: mode});
  if (mode === 'transport') throw Error('fixture connection reset');
  const bytes = mode === 'corrupt' ? 'x'.repeat(body.length) : mode === 'short' ? body.slice(1) : mode === 'long' ? body + 'x' : body;
  const offset = Number(options.headers.Range?.match(/bytes=(\\d+)-/)?.[1] ?? 0);
  if (mode === 'bad-range') return new Response(bytes, {status: 206, headers: {'content-range': 'bytes 99-100/101'}});
  return offset ? new Response(bytes.slice(offset), {status: 206, headers: {'content-range': 'bytes ' + offset + '-' + (body.length - 1) + '/' + body.length}}) : new Response(bytes);
};`);
    const args = ["--import", pathToFileURL(preload).href, "--experimental-strip-types", join(root, "scripts/qualify-memory-runtime.ts"), "--prepare-model", "--allow-download", "--destination", join(root, "model")];
    const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 30_000 });
    const calls = existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    return { ...result, args, calls, installed: existsSync(join(root, "model/config.json")) ? readFileSync(join(root, "model/config.json"), "utf8") : undefined,
      partialExists: existsSync(join(root, "model/config.json.part")) };
  } finally { removeTempDirSync(root); }
}

it("resolves a symlinked temporary root before qualifying the fixture", () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "memory-symlink-test-")));
  try {
    const actual = join(parent, "actual"), alias = join(parent, "alias");
    mkdirSync(actual);
    symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");
    const result = qualify("good", "good", undefined, alias);
    expect(result.status, result.stderr).toBe(0);
    expect(result.installed).toBe(body);
    expect(dirname(dirname(result.args.at(-1)))).toBe(actual);
  } finally { removeTempDirSync(parent); }
});

it("passes the preload to --import as a file URL", () => {
  const result = qualify("good");
  expect(result.args[0]).toBe("--import");
  expect(result.args[1]).toMatch(/^file:\/\//);
  expect(result.status, result.stderr).toBe(0);
  expect(result.installed).toBe(body);
});

it.each([403, 404, "corrupt", "short", "long", "bad-range"])("uses a clean mirror after primary %s and installs only verified bytes", failure => {
  const result = qualify(failure);
  expect(result.status, result.stderr).toBe(0);
  expect(result.installed).toBe(body);
  expect(result.calls.map(call => call.url)).toEqual(sources);
  expect(result.calls[1].headers).toEqual({});
  expect(result.partialExists).toBe(false);
});

it("retries transient primary failures a bounded number of times, then uses the mirror", () => {
  const result = qualify(503);
  expect(result.status, result.stderr).toBe(0);
  expect(result.calls.map(call => call.url)).toEqual([sources[0], sources[0], sources[0], sources[1]]);
  expect(result.installed).toBe(body);
});

it("rejects corrupt bytes from both sources and removes the failed partial", () => {
  const result = qualify("corrupt", "corrupt");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("asset integrity mismatch config.json");
  expect(result.calls.map(call => call.url)).toEqual(sources);
  expect(result.installed).toBeUndefined();
  expect(result.partialExists).toBe(false);
});

it("resumes a partial with an exact range and verifies the complete file", () => {
  const result = qualify("good", "good", body.slice(0, 4));
  expect(result.status, result.stderr).toBe(0);
  expect(result.calls).toEqual([{ url: sources[0], headers: { Range: "bytes=4-" } }]);
  expect(result.installed).toBe(body);
});

it("discards a corrupt completed partial before fetching pinned bytes", () => {
  const result = qualify("good", "good", "x".repeat(body.length));
  expect(result.status, result.stderr).toBe(0);
  expect(result.calls).toEqual([{ url: sources[0], headers: {} }]);
  expect(result.installed).toBe(body);
});
