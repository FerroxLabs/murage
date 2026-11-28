// Move the bundled Fuigo pin to a published release in one command:
//   node scripts/fuigo-pin-move.mjs <x.y.z> <linux> <win> <darwin>
// The three values are the independently reviewed executable SHA-256 digests for linux-x64, win32-x64 and
// darwin-arm64 (the GitHub release SHA256SUMS rows fuigo-<x.y.z>-linux-x86_64, -windows-x86_64, -macos-aarch64).
// Every version site is rewritten to the new release with FILL-AT-NPM pins, then scripts/fill-fuigo-pin.mjs fills and
// re-verifies them from npm. Any site that is missing, or a failed fill, restores every file. Never runs Fuigo.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reviewedHashes } from "./fill-fuigo-pin.mjs";
import { FUIGO_VERSION } from "./prepare-fuigo.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PENDING = "FILL\x2dAT-NPM";
const esc = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const newer = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

/** Each rewrite must change its file, so a site that drifted stops the move instead of leaving an old version behind. */
export function moveSites(from, to) {
  const v = esc(from), hex = /((?:tarballSha256|binarySha256): ")[a-f0-9]{64}/g;
  return {
    "scripts/prepare-fuigo.mjs": text => text.replace(`FUIGO_VERSION = "${from}"`, `FUIGO_VERSION = "${to}"`)
      .replace(/report gitHead [a-f0-9]{40}/, `report gitHead ${PENDING}`)
      .replace(`See fuigo-${from}-provenance.json`, `See fuigo-${to}-provenance.json`).replace(hex, `$1${PENDING}`),
    "scripts/prepare-fuigo.test.mjs": text => text.replace(new RegExp(v, "g"), to).replace(hex, `$1${PENDING}`),
    "server/fuigo-native-update.ts": text => text.replace(`QUALIFIED_FUIGO_VERSION = "${from}"`, `QUALIFIED_FUIGO_VERSION = "${to}"`),
    "server/drivers/acp/fuigo-bundled-real.test.ts": text => text.replace(`fuigo-${from}-provenance.json`, `fuigo-${to}-provenance.json`),
    "shared/capabilities/engines.yaml": text => text.replace(new RegExp(`Fuigo ${v};`, "g"), `Fuigo ${to};`)
      .replace(`FUIGO_VERSION = "${from}"`, `FUIGO_VERSION = "${to}"`),
    // Generated file: only its text moves here (rerun scripts/build-capability-db.mjs once its inventory builds again).
    "shared/capability-db.ts": text => text.replace(new RegExp(`Desktop Murage bundles Fuigo ${v};`, "g"), `Desktop Murage bundles Fuigo ${to};`),
    "scripts/engine-versions.json": text => text.replace(`"fuigo": { "version": "${from}"`, `"fuigo": { "version": "${to}"`)
      .replace(`"fuigo-qualified": { "version": "${from}"`, `"fuigo-qualified": { "version": "${to}"`),
    "shared/capability-db.test.ts": text => text.replace(`"Fuigo ${from}"`, `"Fuigo ${to}"`),
    "third_party/fuigo/README.md": text => text.replace(`**${from}**`, `**${to}**`).replace(`fuigo-${from}-provenance.json`, `fuigo-${to}-provenance.json`),
    "deploy/cloud-home/LICENSES.md": text => text
      .replace(new RegExp(`\\| Fuigo \\| ${v}, (tarball and executable digests in scripts/prepare-fuigo\\.mjs;) release source [a-f0-9]{40}; receipts in scripts/fuigo-${v}-provenance\\.json`),
        `| Fuigo | ${to}, $1 source and receipts pending in scripts/fuigo-${to}-provenance.json (${PENDING})`)
      .replace(new RegExp(`\\| Fuigo ${v} \\| @fuigo/linux-arm64 tarball [a-f0-9]{64}; executable [a-f0-9]{64}`),
        `| Fuigo ${to} | @fuigo/linux-arm64 tarball ${PENDING}; executable ${PENDING}`),
  };
}

/** The new release's receipt, pending: same shape as the current one, every digest and the source reset. */
export function pendingReceipt(current, from, to) {
  const swap = value => typeof value === "string" ? value.split(from).join(to) : value;
  const proof = { ...current, version: to, status: PENDING, source: PENDING };
  proof.packages = current.packages.map(row => {
    const next = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, swap(value)]));
    for (const key of ["tarballSha256", "binarySha256", "integrity", "shasum"]) if (key in next) next[key] = PENDING;
    if (row.optionalDependencies) next.optionalDependencies = Object.fromEntries(Object.keys(row.optionalDependencies).map(name => [name, to]));
    return next;
  });
  return proof;
}

export function movePin(to, hashes, { root = ROOT, from = FUIGO_VERSION, fill = () => execFileSync(process.execPath, [join(root, "scripts/fill-fuigo-pin.mjs"), ...hashes], { cwd: root, stdio: "inherit" }) } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(to) || !newer(to, from)) throw new Error(`Usage: fuigo-pin-move.mjs <x.y.z newer than ${from}> <linux> <win> <darwin>`);
  reviewedHashes(hashes);
  // The bundled release's real initialize answer gates warm reuse (fuigo-1048-pscope.test.ts W-PIN): capture it first.
  const capture = `server/drivers/acp/__fixtures__/fuigo-init/initialize-${to}.json`;
  const captured = existsSync(join(root, capture)) ? JSON.parse(readFileSync(join(root, capture), "utf8")) : null;
  if (captured?.result?._meta?.agentVersion !== to) throw new Error(`${capture}: capture fuigo ${to}'s initialize answer first (q1024-fuigobump follow-1049.sh)`);
  const receipt = `scripts/fuigo-${to}-provenance.json`;
  if (existsSync(join(root, receipt))) throw new Error(`${receipt} already exists`);
  const writes = new Map();
  for (const [file, rewrite] of Object.entries(moveSites(from, to))) {
    const before = readFileSync(join(root, file), "utf8"), after = rewrite(before);
    if (after === before || after.includes(from) && file !== "scripts/prepare-fuigo.mjs" && file !== "scripts/prepare-fuigo.test.mjs") {
      throw new Error(`${file}: Fuigo ${from} site not found or not fully moved`);
    }
    writes.set(file, after);
  }
  const current = JSON.parse(readFileSync(join(root, `scripts/fuigo-${from}-provenance.json`), "utf8"));
  writes.set(receipt, `${JSON.stringify(pendingReceipt(current, from, to), null, 2)}\n`);
  const originals = new Map([...writes.keys()].filter(file => file !== receipt).map(file => [file, readFileSync(join(root, file))]));
  try {
    for (const [file, text] of writes) writeFileSync(join(root, file), text);
    fill();
  } catch (error) {
    for (const [file, bytes] of originals) writeFileSync(join(root, file), bytes);
    if (existsSync(join(root, receipt))) unlinkSync(join(root, receipt));
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [to, ...hashes] = process.argv.slice(2);
  movePin(to, hashes);
  console.log(`Fuigo pin moved ${FUIGO_VERSION} -> ${to}. Run node scripts/build-capabilities.mjs, then the prepare-fuigo, fill-fuigo-pin and acp suites; the trust release gate (scripts/fuigo-bump.mjs --merge-check) and the real-turn canary still apply.`);
}
