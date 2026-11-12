// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { json, TARGETS, PIN_PATH, digest } from "./signal-inventory.mjs";
import { SIGNAL_CLI_COMMIT } from "../server/channels/signal/evidence.mjs";
const [mode, directory, pinPath = PIN_PATH] = process.argv.slice(2);
if (!["--write", "--check"].includes(mode) || !directory) throw Error("usage: --write|--check <fragments> [pin]");
const pin = json(pinPath);
const builder = json(new URL("./signal-builder.json", import.meta.url));
// --check binds the exact independently reproduced inputs, including fragment
// metadata that is deliberately not copied into the runtime pin (e.g. builder).
// Keep evidence beside the pin so checking a candidate never borrows production evidence.
const evidence = mode === "--check"
  ? json(join(dirname(pinPath), basename(pinPath, ".json") + ".evidence.json")) : null;
if (mode === "--check" && (evidence?.contract !== "murage-signal-runtime-input-evidence/1.0"
    || !evidence.builders?.S3 || !evidence.builders?.W2 || evidence.builders.S3 === evidence.builders.W2)) {
  throw Error("Independent runtime builder evidence required");
}
if (evidence && digest(readFileSync(join(directory, "SHA256SUMS"))) !== evidence.sha256sumsSha256) {
  throw Error("W2 SHA256SUMS hash mismatch");
}
let network, jars;
for (const target of Object.keys(TARGETS)) {
  const name = `pin-fragment-${target}.json`, bytes = readFileSync(join(directory, name));
  if (evidence && digest(bytes) !== evidence.fragments?.[name]) throw Error(`${target}: Input fragment hash mismatch`);
  const f = JSON.parse(bytes);
  if (JSON.stringify(f.builder) !== JSON.stringify(builder)) throw Error("Input builder toolchain mismatch");
  if (f.target !== target || f.signalCliCommit !== SIGNAL_CLI_COMMIT) throw Error("Input source/target mismatch");
  const archive = join(directory, new URL(f.releaseInput.url).pathname.split("/").at(-1));
  if (digest(readFileSync(archive)) !== f.releaseInput.sha256) throw Error("Input archive hash mismatch");
  if (network && network !== f.signalNetworkSha256) throw Error("signal-network differs across targets");
  if (jars && jars !== JSON.stringify(f.record.jars)) throw Error("Jars differ across targets");
  network = f.signalNetworkSha256; jars = JSON.stringify(f.record.jars);
  const record = { ...f.record, integrity: { ...f.record.integrity, resigned: pin.targets[target]?.integrity?.resigned ?? null } };
  if (mode === "--check" && (JSON.stringify(pin.targets[target]) !== JSON.stringify(record) || JSON.stringify(pin.releaseInputs[target]) !== JSON.stringify(f.releaseInput))) throw Error(`${target}: rebuilt archive differs from committed pin`);
  pin.targets[target] = record; pin.releaseInputs[target] = f.releaseInput;
}
if (mode === "--check" && pin.signalNetwork.sha256 !== network) throw Error("signal-network differs from pin");
pin.signalNetwork.sha256 = network;
if (mode === "--write") writeFileSync(pinPath, JSON.stringify(pin, null, 2) + "\n");
// g0 and syncProof are never synthesized or changed by the input builder.
console.log(`Signal runtime fragments ${mode === "--write" ? "recorded" : "verified"}`);
