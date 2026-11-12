import { expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { removeTempDir } from "../testing/cleanup.ts";
const path = "./users-create-identity.ts";
const mod = existsSync(new URL(path, import.meta.url)) ? await import(path) : {};
const required = (): any => { expect(typeof mod.UserCreateIdentityClaims).toBe("function"); return mod; };
it("R8 serializes two action IDs and connections for one normalized company/email across real processes", async () => {
  const m = required(), directory = mkdtempSync(join(tmpdir(), "hlpw-claim-")), file = join(directory, "claims.sqlite");
  const store = new m.UserCreateIdentityClaims(file);
  try {
    const source = `import { UserCreateIdentityClaims } from ${JSON.stringify(new URL(path, import.meta.url).href)};
      const store = new UserCreateIdentityClaims(process.argv[1]);
      const claim = store.acquire("co_fixture", process.argv[2], process.argv[3]);
      process.stdout.write(claim ? "won" : "blocked"); store.close();`;
    const run = promisify(execFile);
    const results = await Promise.all(["Fixture@Example.test", "fixture@example.test"].map(email => run(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source, file, email, randomUUID()])));
    expect(results.map(r => r.stdout).sort()).toEqual(["blocked", "won"]);
    expect(store.acquire("co_fixture", "fixture@example.test", randomUUID())).toBeUndefined();
    expect(store.acquire("other_company", "fixture@example.test", randomUUID())).toBeDefined();
  } finally { store.close(); removeTempDir(directory); }
});
it("R8 dispatch barrier survives restart, rejects a second sender and cannot release on a generic failure", () => {
  const m = required(), directory = mkdtempSync(join(tmpdir(), "hlpw-barrier-")), file = join(directory, "claims.sqlite");
  let store = new m.UserCreateIdentityClaims(file);
  try {
    const claim = store.acquire("co_fixture", "fixture@example.test", "action1");
    expect(JSON.stringify(claim)).toBe("{}"); claim.barrier();
    expect(() => claim.barrier()).toThrow(); expect(() => claim.releaseUnsent()).toThrow();
    store.close(); store = new m.UserCreateIdentityClaims(file);
    expect(store.status("co_fixture", "fixture@example.test")).toBe("outcome_unknown");
    expect(store.acquire("co_fixture", "fixture@example.test", "action2")).toBeUndefined();
  } finally { store.close(); removeTempDir(directory); }
});
it("R9 only the unique unsent owner can release; malformed, duplicate and incomplete inventories never permit dispatch", async () => {
  const m = required(), directory = mkdtempSync(join(tmpdir(), "hlpw-inventory-")), file = join(directory, "claims.sqlite");
  const store = new m.UserCreateIdentityClaims(file);
  try {
    let claim = store.acquire("co_fixture", "fixture@example.test", "action1"); claim.releaseUnsent();
    claim = store.acquire("co_fixture", "fixture@example.test", "action2"); expect(claim).toBeDefined();
    for (const raw of [{}, { users: [], hasMore: true }, { users: [], total: 1 }, { users: [{ email: "Fixture@Example.test" }] }, { users: [{ id: "u1", email: "fixture@example.test" }, { id: "u2", email: "fixture@example.test" }] }])
      expect(m.userCreateInventoryClear(raw, "fixture@example.test", "loc_fixture")).toBe(false);
    expect(m.userCreateInventoryClear({ users: [] }, "fixture@example.test", "loc_fixture")).toBe(true);
    expect(m.userCreateInventoryClear({ users: [{ id: "other", email: "other@example.test", roles: { type: "account", locationIds: ["foreign"] } }] }, "fixture@example.test", "loc_fixture")).toBe(false);
    claim.releaseUnsent();
  } finally { store.close(); removeTempDir(directory); }
});
