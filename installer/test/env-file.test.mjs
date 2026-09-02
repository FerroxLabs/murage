/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  envFilePermissions,
  isSecretKey,
  parseEnv,
  readEnvFile,
  redact,
  serializeEnv,
  writeEnvFile,
} from "../lib/env-file.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "murage-env-test-"));

test("round-trips through a 0600 file in a 0700 directory", () => {
  const dir = join(scratch(), "nested");
  const path = join(dir, "murage.env");
  writeEnvFile(path, { MURAGE_PORT: "8799", ANTHROPIC_API_KEY: "sk-ant-secret" });
  assert.deepEqual(readEnvFile(path), { MURAGE_PORT: "8799", ANTHROPIC_API_KEY: "sk-ant-secret" });
  assert.equal(statSync(path).mode & 0o777, 0o600, "must be 0600 even under a permissive umask");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("the written file never contains a wildcard-bind switch", () => {
  const text = serializeEnv({ MURAGE_BIND_MODE: "loopback", MURAGE_PORT: "8799" });
  // Wayland's equivalent writes ALLOW_REMOTE=true here, which is what puts its
  // admin UI on a public IP. Assert the shape of ours can never say that.
  assert.ok(!/ALLOW_REMOTE/i.test(text));
  assert.ok(!/0\.0\.0\.0/.test(text));
  assert.match(text, /^MURAGE_BIND_MODE=loopback$/m);
});

test("a newline in a value is refused, so one setting cannot inject another", () => {
  assert.throws(() => serializeEnv({ A: "one\nMURAGE_BIND_MODE=public" }), /contains a newline/);
  assert.throws(() => serializeEnv({ A: "one\rtwo" }), /contains a newline/);
});

test("a malformed key is refused", () => {
  for (const key of ["has space", "1leading", "has=equals", ""]) {
    assert.throws(() => serializeEnv({ [key]: "v" }), /malformed env key/, key);
  }
});

test("parseEnv ignores comments and blanks, and keeps '=' inside values", () => {
  const parsed = parseEnv("# c\n\nA=1\nB=x=y\n  C=3  \n=novalue\n");
  assert.deepEqual(parsed, { A: "1", B: "x=y", C: "3" });
});

test("a missing file reads as empty rather than throwing", () => {
  assert.deepEqual(readEnvFile(join(scratch(), "absent.env")), {});
});

test("secret keys are recognised and redacted for display", () => {
  for (const k of ["ANTHROPIC_API_KEY", "MURAGE_TS_AUTHKEY", "X_TOKEN", "Y_SECRET", "ADMIN_PASSWORD"]) {
    assert.equal(isSecretKey(k), true, k);
  }
  assert.equal(isSecretKey("MURAGE_PORT"), false);
  assert.deepEqual(redact({ MURAGE_PORT: "8799", OPENAI_API_KEY: "sk-live" }), {
    MURAGE_PORT: "8799",
    OPENAI_API_KEY: "<redacted>",
  });
});

test("envFilePermissions reports a world-readable key file as NOT private", () => {
  const dir = scratch();
  const path = join(dir, "leaky.env");
  writeFileSync(path, "OPENAI_API_KEY=sk-live\n", { mode: 0o644 });
  const perms = envFilePermissions(path);
  assert.equal(perms.exists, true);
  assert.equal(perms.private, false, "0644 holds an API key readable by every user on the box");

  writeEnvFile(path, { OPENAI_API_KEY: "sk-live" });
  assert.equal(envFilePermissions(path).private, true);
  assert.deepEqual(envFilePermissions(join(dir, "nope.env")), { exists: false, mode: null, private: false });
});
