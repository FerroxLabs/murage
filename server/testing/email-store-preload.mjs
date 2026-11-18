// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Runner injection owner: emailstore-1019. Email workflow consumer owner: emailstore-1019.
import { registerHooks } from "node:module";

/** Called explicitly by isolated test runners, never by the shipped server. */
export function installMemoryEmailStore() {
  registerHooks({ load(url, context, next) {
    const loaded = next(url, context);
    if (!url.endsWith("/server/index.ts")) return loaded;
    const source = String(loaded.source), anchor = "const emailRuntime = new EmailRuntime({";
    if (!source.includes(anchor)) throw new Error("Fixture email runtime anchor moved");
    return { ...loaded, source: `
import { createMemoryEmailRuntime as fixtureEmailRuntime } from ${JSON.stringify(new URL("./email-store-fixture.ts", import.meta.url).href)};
function FixtureEmailRuntime(options) {
  return fixtureEmailRuntime({ ...options, secretsUnavailable: undefined, persistSecrets: undefined });
}
${source.replace(anchor, "const emailRuntime = new FixtureEmailRuntime({")}` };
  } });
}
