// Owners: wg-proof owns this read-only classifier consumer; wg-shim owns wg_device.
// No disk tool is executed and no device path is opened. These lexical witnesses
// isolate the producer's device predicate; fake-root argv witnesses cover dispatch.
import { execute } from '../process.mjs';
import { shQuote as q } from '../adapter.mjs';
export async function proveDevices(library, shell = '/bin/sh') {
  const results = [];
  for (const [name, target, expected] of [
    ['linux-sata', '/dev/sda', 0], ['linux-nvme', '/dev/nvme0n1', 0],
    ['macos-raw-disk', '/dev/rdisk0', 0], ['character-sink', '/dev/null', 1],
    ['ordinary-file', '/tmp/fixture-file', 1],
  ]) {
    const outcome = await execute(shell, ['-c', `. ${q(library)}; wg_path=${q(target)}; wg_device`], process.env, process.cwd());
    results.push({ name: 'device-classifier/' + name, ok: outcome.code === expected && !outcome.error && !outcome.timedOut && !outcome.stdout && !outcome.stderr });
  }
  return results;
}
