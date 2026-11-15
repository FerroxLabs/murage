// T-A12: run with the TARGET packaged Electron, outside the repository, against the copied resource.
import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
export const ANCHORED_RESOURCE_PROBE = String.raw`
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const addon = require(process.argv[1]);
assert.equal(addon.version(), 1);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'murage-anchored-package-'));
try {
  fs.mkdirSync(path.join(root, 'dir'));
  fs.writeFileSync(path.join(root, 'dir', 'fixture'), 'anchored-package-fixture');
  const steps = [];
  const result = addon.read(fs.realpathSync(root), ['dir', 'fixture'], 64, step => steps.push(step.kind));
  assert.equal(Buffer.from(result.bytes).toString(), 'anchored-package-fixture');
  assert.equal(result.size, 24);
  assert.match(result.volume, /^\d+$/); assert.ok(result.fileId);
  assert.deepEqual(steps, ['root', 'dir', 'file', 'read']);
  assert.throws(() => addon.read(fs.realpathSync(root), ['..', 'fixture'], 64), {code:'invalid_name'});
  fs.linkSync(path.join(root, 'dir', 'fixture'), path.join(root, 'hardlink'));
  assert.throws(() => addon.read(fs.realpathSync(root), ['hardlink'], 64), {code:'hard_link'});
  console.log('PASS T-A12 packaged.anchoredAddonLoads ' + process.platform + '-' + process.arch);
} finally { fs.rmSync(root, {recursive: true, force: true}); }
`;
export function proveAnchoredReadResource(file, executable = process.execPath, run = execFileSync) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1024 || stat.size > 4 * 1024 * 1024) throw Error("ANCHORED_RESOURCE_INVALID");
  const output = String(run(executable, ["-e", ANCHORED_RESOURCE_PROBE, resolve(file)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30000, encoding: "utf8",
  })).trim();
  if (!/^PASS T-A12 packaged\.anchoredAddonLoads (darwin|win32)-(arm64|x64)$/.test(output)) throw Error("ANCHORED_RESOURCE_PROOF_FAILED: " + output);
  return output;
}
