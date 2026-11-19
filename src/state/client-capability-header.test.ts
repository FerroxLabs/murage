// SPDX-License-Identifier: AGPL-3.0-or-later
// AGY-ON-CLOUD design test 4: both clients that carry the Connect entry and the code box say so, once, on every home request.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const HEADER = '"x-murage-client-capabilities": "antigravity-signin"';
describe("the Antigravity sign-in capability flag", () => {
  it("the renderer's api() sends it (the browser home page and the Cloud window renderer)", () => {
    const source = readFileSync(new URL("./store.tsx", import.meta.url), "utf8");
    const call = source.slice(source.indexOf("export async function api("), source.indexOf("const body = await res.json()", source.indexOf("export async function api(")));
    expect(call).toContain(HEADER);
  });
  it("the desktop's Cloud window proxy to the home sends it", () => {
    const source = readFileSync(new URL("../../electron/cloud-home-client.mjs", import.meta.url), "utf8");
    const fetchHome = source.slice(source.indexOf("async function fetchHome("), source.indexOf("let response = await attempt();"));
    expect(fetchHome).toContain(HEADER);
  });
});
