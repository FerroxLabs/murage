// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("the native verification server can import home sign-in source with Node strip-types", () => {
  const file = fileURLToPath(new URL("./model-signin.ts", import.meta.url));
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", "await import(process.argv[1])", file], {
    env: { ...process.env, MURAGE_CLOUD_ROLE: "" }, encoding: "utf8", timeout: 10_000,
  });
  expect(child.status, child.stderr).toBe(0);
});
