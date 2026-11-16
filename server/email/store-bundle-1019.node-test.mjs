// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Server build producer owner: emailstore-1019. Installer/desktop guard owner: emailstore-1019.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { resolveServerEntry } from "../../installer/bin/murage.mjs";

test("installer and packaged desktop select the bundle with no email fixture bypass", () => {
  const root = process.cwd(), bundle = join(root, "dist-server", "index.js");
  assert.equal(resolveServerEntry(join(root, "installer"), root, existsSync).entry, bundle);
  const desktop = parse(readFileSync("electron-builder.yml", "utf8")).extraResources;
  assert.ok(desktop.some(resource => resource.from === "dist-server" && resource.to === "server"));
  const emitted = readFileSync(bundle, "utf8");
  for (const fixture of ["MURAGE_TEST_EMAIL_STORE", "installMemoryEmailStore", "FixtureEmailRuntime"])
    assert.equal(emitted.includes(fixture), false, `${fixture} must not ship`);
});
