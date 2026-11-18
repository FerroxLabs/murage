// Bootstrap tests owner: win-sac-sign; protected fixed-file installation and controller admission owner: MAIN.
import { expect, it, vi } from "vitest";
import { signingAuthorityFixture } from "./fixtures/windows-signing-authority.mjs";
import { signingDigest } from "./windows-signing-authority.mjs";
import { WINDOWS_SIGNING_BOOTSTRAP_CONFIG, readWindowsSigningRunContext } from "./windows-signing-bootstrap.mjs";
export function bootstrapFixture() {
  const f = signingAuthorityFixture();
  const config = { lockFile: "C:\\Program Files\\MurageSigning\\controller\\trust.json", lockSha256: signingDigest(f.bytes()),
    runAuthorizationFile: "C:\\Program Files\\MurageSigning\\controller\\run.json", launchFile: "C:\\Program Files\\MurageSigning\\launch\\contract.json",
    launchSha256: f.lock.launchSha256, admission: f.admission };
  const input = new Map([[config.lockFile, f.bytes()], [config.runAuthorizationFile, f.envelope()]]);
  const read = vi.fn(async name => name === WINDOWS_SIGNING_BOOTSTRAP_CONFIG ? Buffer.from(JSON.stringify(config)) : input.get(name));
  return { ...f, config, input, read };
}
it("reads only the fixed installed bootstrap config and authenticates its lock and run envelope", async () => {
  const f = bootstrapFixture(), result = await readWindowsSigningRunContext(f);
  expect(f.read.mock.calls.map(args => args[0])).toEqual([WINDOWS_SIGNING_BOOTSTRAP_CONFIG, f.config.lockFile, f.config.runAuthorizationFile]);
  expect(result.run).toMatchObject(f.run); expect(result.lock.sha256).toBe(f.config.lockSha256);
});
export const bootstrapViolations = [
  ["foreign config field", f => { f.config.producerModule = "uploaded.mjs"; }],
  ["writable lock", f => { f.config.lockFile = "C:\\Temp\\trust.json"; }],
  ["relative authorization", f => { f.config.runAuthorizationFile = "run.json"; }],
  ["noncanonical launch", f => { f.config.launchFile = "C:\\Program Files\\MurageSigning\\launch\\..\\other.json"; }],
  ["lock substitution", f => { f.input.set(f.config.lockFile, Buffer.from('{}')); }],
  ["envelope substitution", f => { f.input.set(f.config.runAuthorizationFile, Buffer.from('{}')); }],
  ["variable-only launch pin", f => { f.config.launchSha256 = f.hash("other launch"); }],
];
it.each(bootstrapViolations)("refuses bootstrap %s", async (_name, mutate) => {
  const f = bootstrapFixture(); mutate(f); await expect(readWindowsSigningRunContext(f)).rejects.toThrow();
});
