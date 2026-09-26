// The key renewal successors are derived from (see `successorValue` in
// devices.ts). Three properties: it survives a restart, nobody else on the
// machine can read it, and an unreadable file is never quietly replaced,
// because replacing it would orphan every successor already handed out.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { loadSessionSecret, SESSION_SECRET_FILE } from "../src/session-secret.ts";
import { DATA_DIR } from "../src/state.ts";

describe("the session secret", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("is created once, owner-only, and read back unchanged", () => {
    const first = loadSessionSecret();
    expect(first).toHaveLength(32);
    expect(statSync(SESSION_SECRET_FILE).mode & 0o777).toBe(0o600);
    expect(loadSessionSecret().equals(first)).toBe(true);
    expect(readFileSync(SESSION_SECRET_FILE, "utf8").trim()).toBe(first.toString("hex"));
  });

  it("replaces a damaged file rather than deriving from garbage", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(SESSION_SECRET_FILE, "not hex at all");
    const secret = loadSessionSecret();
    expect(secret).toHaveLength(32);
    expect(readFileSync(SESSION_SECRET_FILE, "utf8").trim()).toBe(secret.toString("hex"));
  });

  it("refuses, and leaves the path alone, when the file exists but cannot be read", () => {
    mkdirSync(SESSION_SECRET_FILE, { recursive: true });
    expect(() => loadSessionSecret()).toThrow();
    expect(statSync(SESSION_SECRET_FILE).isDirectory()).toBe(true);
  });
});
