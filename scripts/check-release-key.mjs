import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseReleaseKey } from "../electron/update-signature.mjs";

// Fingerprints of keys whose private half lives in test code. Matching by
// fingerprint means stripping the labels cannot get a test key past this check.
export const TEST_KEY_FINGERPRINTS = Object.freeze(["7fdc7f1b0cfc0a77022ba8fc9414a2c62cd0da75"]);

export async function checkReleaseKey(file = new URL("../electron/release-key.asc", import.meta.url)) {
  const key = parseReleaseKey(await readFile(file));
  if ([...key.comments, ...key.userIds].some(value => /TEST KEY/i.test(value))) {
    throw new Error("The shipped release key contains TEST KEY. Replace it with the Murage publisher public key before packaging.");
  }
  if (TEST_KEY_FINGERPRINTS.includes(key.fingerprint)) {
    throw new Error("The shipped release key is the Murage test key. Replace it with the Murage publisher public key before packaging.");
  }
  return key;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  checkReleaseKey(process.argv[2]).then(key => {
    console.log(`Murage release key: ${key.fingerprint}`);
  }).catch(error => {
    console.error(`Release key check: ${error.message}`);
    process.exitCode = 1;
  });
}
