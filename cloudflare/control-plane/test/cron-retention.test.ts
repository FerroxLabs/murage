// SPDX-License-Identifier: AGPL-3.0-or-later
// Audit FPS-6: staging must run the scheduled retention sweep like production.
import { expect, it } from "vitest";
import raw from "../wrangler.jsonc?raw";

const config = JSON.parse(raw.split("\n").filter((line: string) => !/^\s*\/\//.test(line)).join("\n"));

it("staging cron is non-empty and equals production", () => {
  const prod = config.triggers.crons as string[];
  const staging = config.env.staging.triggers.crons as string[];
  expect(prod.length).toBeGreaterThan(0);
  expect(staging.length).toBeGreaterThan(0);
  expect(staging).toEqual(prod);
});
