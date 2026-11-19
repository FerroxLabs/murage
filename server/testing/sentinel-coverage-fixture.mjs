// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture owner: P2; production launcher and receipt consumer owner: P2.
import { mkdirSync, rmSync, chmodSync, writeFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { sentinelInstallationId } from "../../shared/sentinel-installation.mjs";
import { defaultOutputRoot, sourcePaths, writeDescriptor } from "../sentinel/paths.ts";

export async function coverageFixture(kind) {
  if(kind === "later-sealed"){
    const {sealedCoverageFixture}=await import("./sentinel-sealed-coverage.ts");
    const {writeDescriptor}=await import("../sentinel/paths.ts");
    const f=sealedCoverageFixture();
    try{
      const meter=await import("../io-meter.ts"),child=await import("../io-child-meter.ts");
      meter.installCopyMeter();child.installChildProcessMeter();
      const before=meter.ioMeterCoverageKnown();
      f.descriptor.scheduleRevision++;
      if(!writeDescriptor(f.descriptor).ok)throw Error("FIXTURE_LATER_DESCRIPTOR");
      const appeared=meter.ioMeterCoverageKnown();
      rmSync(join(f.descriptor.outputRoot,"descriptor.json"));const deleted=meter.ioMeterCoverageKnown();
      if(!writeDescriptor(f.descriptor).ok)throw Error("FIXTURE_RESTORE_DESCRIPTOR");
      f.cycle();meter.ioMeterCoverageKnown();f.cycle();
      return [before,appeared,deleted,meter.ioMeterCoverageKnown()];
    }finally{f.close();}
  }
  const attachedDiagnostic=kind.endsWith("-diagnostic");
  if(attachedDiagnostic)kind=kind.slice(0,-"-diagnostic".length);
  const dataDir = process.env.MURAGE_DATA_DIR;
  mkdirSync(dataDir, { recursive: true });
  const installationId = sentinelInstallationId(dataDir);
  const outputRoot = defaultOutputRoot(installationId);
  const descriptorPath = join(outputRoot, "descriptor.json");
  const descriptor = {
    version: 1, installationId, installationRoot: dataDir, inputRoot: join(dataDir, "health"), outputRoot,
    sources: sourcePaths(join(dataDir, "health")),
    executable: { path: process.execPath, entry: resolve("server/sentinel/cli.ts"), sha256: null }, scheduleRevision: 1,
  };
  const write = () => {
    mkdirSync(outputRoot, { recursive: true });
    const result = writeDescriptor(descriptor);
    if (!result.ok) throw new Error(`fixture descriptor: ${result.reason}`);
  };
  if (kind !== "later" && !kind.startsWith("root-")) write();
  if (kind === "root-file") { mkdirSync(join(outputRoot, ".."), { recursive: true }); writeFileSync(outputRoot, "fixture"); }
  if (kind === "root-denied") { write(); chmodSync(outputRoot, 0); }
  if (kind === "root-link") {
    mkdirSync(join(outputRoot, ".."), { recursive: true });
    const target = join(process.env.HOME, "empty-target"); mkdirSync(target); symlinkSync(target, outputRoot, "dir");
  }
  if (kind === "root-unresolved") {
    process.env.MURAGE_SENTINEL_STATE_DIR="relative-state-is-invalid";
    if(defaultOutputRoot(installationId)!==null)throw new Error("fixture root must be deterministically unresolved");
  }
  if (kind === "root-data-unresolved") process.env.MURAGE_DATA_DIR = join(dataDir, "missing");
  const meter = await import("../io-meter.ts");
  const child = await import("../io-child-meter.ts");
  meter.installCopyMeter(); child.installChildProcessMeter();
  const read = attachedDiagnostic ? (await import("../sentinel-io-coverage.ts")).sentinelAttachedIoCovered : () => meter.ioMeterCoverageKnown();
  try {
    if (kind === "later") {
      const before = read(); write(); const present = read(); rmSync(descriptorPath); return [before, present, read()];
    }
    if (kind === "attach" || kind === "scheduled" || kind.startsWith("invalid-")) {
      const { desktopIoReceiver } = await import("../io-desktop-receipts.ts");
      const receiver = desktopIoReceiver(() => {});
      const generation = "fixture-generation";
      const sample = (sequence = 1) => ({ type: "sample", generation, message: {
        type: "io", ioProtocol: 1, generation, sequence, fsWriteBlocks: 0, ioBytes: 0, known: true, final: true,
      } });
      if (kind === "scheduled") { receiver.accept({ type: "uncovered" }); return read(); }
      receiver.accept({ type: "launch", generation }); const pending = read();
      receiver.accept(sample()); const known = read();
      if (kind.startsWith("invalid-")) {
        const frames = {
          "invalid-frame": null,
          "invalid-generation": { ...sample(2), generation: "different-generation" },
          "invalid-inner-generation": { ...sample(2), message: { ...sample(2).message, generation: "different-generation" } },
          "invalid-sequence": sample(0),
          "invalid-protocol": { ...sample(2), message: { ...sample(2).message, ioProtocol: 2 } },
          "invalid-unknown": { ...sample(2), message: { ...sample(2).message, known: false } },
        };
        receiver.accept(frames[kind]); const lost = read(); receiver.accept(sample(3));
        return [pending, known, lost, read()];
      }
      receiver.accept({ type: "exit", generation, code: 0, signal: null }); const exited = read();
      receiver.accept(sample(2)); return [pending, known, exited, read()];
    }
    if (kind === "cloud") {
      const { readProcess } = await import("../io-budget.ts");
      if(meter.ioMeterTotal()===null)throw new Error("fixture Windows consumer requires a valid native-meter control");
      return { covered: read(), osKnown: readProcess("win32").osKnown !== false };
    }
    return read();
  } finally { if (kind === "root-denied") chmodSync(outputRoot, 0o700); }
}
