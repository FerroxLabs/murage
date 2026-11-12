// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { BUILD_INPUTS, buildInputUrls, fetchBuildInput } from "./fetch-build-input.mjs";

const body = Buffer.from("reviewed bytes");
const pin = { sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length,
  urls: ["https://primary.example/input", "https://mirror.example/input"] };
const pins = { fixture: pin };

it.each(["HTTP", "hash", "oversized", "truncated", "transport"])("tries the second URL after a %s failure and accepts only pinned bytes", async failure => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url === pin.urls[1]) return new Response(body);
    if (failure === "HTTP") return new Response("missing", { status: 404 });
    if (failure === "transport") throw Error("connection reset");
    return new Response(failure === "hash" ? Buffer.alloc(body.length) : failure === "oversized" ? Buffer.alloc(body.length + 1) : body.subarray(1));
  };
  const response = await fetchBuildInput(pin.urls[0], { ...pin, pins, fetchImpl });
  expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
  expect(calls).toEqual(pin.urls);
});

it("refuses corruption at both endpoints and a caller trying to override a reviewed hash", async () => {
  await expect(fetchBuildInput(pin.urls[0], { ...pin, pins, fetchImpl: async () => new Response(Buffer.alloc(body.length)) })).rejects.toThrow("SHA-256");
  let called = false;
  await expect(fetchBuildInput(pin.urls[0], { ...pin, pins, sha256: "0".repeat(64), fetchImpl: async () => { called = true; } })).rejects.toThrow("disagrees");
  expect(called).toBe(false);
  expect(() => buildInputUrls(pin.urls[1], pin.sha256, pins)).not.toThrow();
  expect(buildInputUrls(pin.urls[1], pin.sha256, pins)).toEqual([...pin.urls].reverse());
});

it("rejects a body whose stream fails midway, and never returns its partial bytes", async () => {
  const response = await fetchBuildInput(pin.urls[0], { ...pin, pins, fetchImpl: async url => url === pin.urls[1]
    ? new Response(body)
    : new Response(new ReadableStream({ start(controller) { controller.enqueue(body.subarray(0, 3)); controller.error(Error("truncated stream")); } })) });
  expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
});

it("keeps every reviewed entry bound to two distinct HTTPS URLs, an exact size, and sha256", () => {
  const seen = new Set();
  for (const pin of Object.values(BUILD_INPUTS)) {
    expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.bytes).toBeGreaterThan(0);
    expect(new Set(pin.urls).size).toBeGreaterThanOrEqual(2);
    for (const url of pin.urls) {
      expect(new URL(url).protocol).toBe("https:");
      expect(seen.has(url), url).toBe(false); seen.add(url);
    }
  }
});

it("keeps the vendored signing key pinned; fingerprint verification remains required", () => {
  const key = readFileSync(new URL("./adoptium-signing-key.asc", import.meta.url));
  expect(createHash("sha256").update(key).digest("hex")).toBe("52542b963fb4c1ee5607e3da4a794727e9ba3d3266988d7dff3a9d3425e88c67");
});

it.skipIf(process.platform !== "linux")("Python callers reject poisoned sources and preserve an existing destination on total failure", () => {
  const result = spawnSync("python3", ["scripts/fetch-build-input.test.py"], { encoding: "utf8", windowsHide: true });
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
