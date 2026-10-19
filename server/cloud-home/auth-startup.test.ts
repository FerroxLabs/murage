// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { launchVerificationServer } from "../../scripts/control-murage.ts";
import { constructCloudAuth } from "./auth-startup.ts";
import { cloudHomeCopy } from "./copy.ts";

it("is inert off-home and refuses a failed or missing auth constructor on a home", () => {
  const build = vi.fn(() => { throw new Error("fixture-private-construction-failure"); });
  expect(constructCloudAuth(undefined, build)).toBeUndefined(); expect(build).not.toHaveBeenCalled();
  expect(() => constructCloudAuth("home", build)).toThrow(cloudHomeCopy.bootAuthFailed);
  expect(() => constructCloudAuth("home", () => undefined)).toThrow(cloudHomeCopy.bootAuthFailed);
});
it("the actual home server exits nonzero before listening on an injected auth construction failure", async () => {
  const instrumentationSource = `import { DatabaseSync } from "node:sqlite";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
 if (typeof sql === "string" && sql.includes("CREATE TABLE IF NOT EXISTS cloud_meta")) {
  console.error("FIXTURE_AUTH_CONSTRUCTOR_REACHED"); throw new Error("fixture-private-construction-failure");
 }
 return exec.call(this,sql);
};
process.once("exit",code => console.error("FIXTURE_EXIT="+code));`;
  let failed: Error | undefined;
  try {
    const unexpected = await launchVerificationServer({}, undefined, { cloud: { publicOrigin: "https://home.example.test", bootstrapSecret: "fixture-bootstrap-secret-32-characters" }, instrumentationSource, readyTimeoutMs: 60_000 });
    await unexpected.close();
  } catch (error) { failed = error as Error; }
  expect(failed?.message).toMatch(/exited before it was ready; see /);
  const path = failed!.message.split("; see ")[1]!;
  const log = readFileSync(path, "utf8");
  expect(log).toContain("FIXTURE_AUTH_CONSTRUCTOR_REACHED"); expect(log).toContain("FIXTURE_EXIT=1");
  expect(log).toContain(cloudHomeCopy.bootAuthFailed);
  expect(log).not.toContain("fixture-private-construction-failure");
}, 90_000);
