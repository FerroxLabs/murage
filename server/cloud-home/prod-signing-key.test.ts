// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey } from "node:crypto";
import { describe, expect, it } from "vitest";

const script = new URL("../../cloudflare/control-plane/scripts/gen-prod-signing-key.mjs", import.meta.url).pathname;

/** A stand-in for wrangler: lists a canned secret set and records the stdin of `secret put` to a file in its own temp dir. */
function stub(existing: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "wr-"));
  const bin = join(dir, "wrangler");
  writeFileSync(bin, `#!/bin/sh
if [ "$1" = "secret" ] && [ "$2" = "list" ]; then echo '${JSON.stringify(existing.map((name) => ({ name, type: "secret_text" })))}'; exit 0; fi
if [ "$1" = "secret" ] && [ "$2" = "put" ]; then echo "$@" > "${dir}/argv"; cat > "${dir}/stdin"; exit 0; fi
exit 1
`);
  chmodSync(bin, 0o755);
  return { dir, bin };
}
const run = (bin: string, args: string[] = []) => spawnSync("node", [script, ...args], { env: { PATH: process.env.PATH, WRANGLER_BIN: bin }, encoding: "utf8" });

describe("production signing key script", () => {
  it("pipes the private JWK to wrangler stdin and prints only the public half", () => {
    const { dir, bin } = stub([]);
    const r = run(bin);
    expect(r.stderr + r.stdout.slice(0, 200)).toContain("stored");
    expect(r.status).toBe(0);
    const stored = JSON.parse(readFileSync(join(dir, "stdin"), "utf8"));
    expect(stored).toMatchObject({ kty: "EC", crv: "P-256" });
    expect(typeof stored.d).toBe("string");
    createPrivateKey({ key: stored, format: "jwk" }); // a real, loadable private key
    expect(readFileSync(join(dir, "argv"), "utf8")).not.toContain(stored.d);
    expect(r.stdout + r.stderr).not.toContain(stored.d);
    const printed = JSON.parse(r.stdout.split("\n").find((l) => l.startsWith("{"))!);
    expect(printed).toEqual({ kty: "EC", crv: "P-256", x: stored.x, y: stored.y });
  });
  it("refuses to replace an existing production key without --rotate, and does not touch it", () => {
    const { dir, bin } = stub(["CLOUD_B3_SIGNING_JWK"]);
    const r = run(bin);
    expect(r.status).toBe(2);
    expect(() => readFileSync(join(dir, "stdin"))).toThrow();
    expect(run(bin, ["--rotate"]).status).toBe(0);
  });
});
