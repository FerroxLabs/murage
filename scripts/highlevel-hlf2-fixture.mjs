import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, runControlMurage, controlResultSucceeded } from "./control-murage.ts";
const evidence = process.env.HLF2_EVIDENCE_DIR ?? ".test-tmp/cfix3-hlf2";
const fixture = await launchVerificationServer(process.env, undefined, { readyTimeoutMs: 60000, instrumentationSource: `
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { runFixtureEvidence } = await import(${JSON.stringify(new URL("./highlevel-hlf2-fixture-driver.ts", import.meta.url).href)});
  const result = await runFixtureEvidence(process.env.MURAGE_DATA_DIR);
  writeFileSync(join(process.env.MURAGE_DATA_DIR, 'hlf2-result.json'), JSON.stringify(result, null, 2));
` });
try {
  writeFileSync(join(evidence, "fixture.json"), `${JSON.stringify(fixture.info, null, 2)}\n`);
  const doctor = await runControlMurage(["doctor", "--url", fixture.info.url]);
  writeFileSync(join(evidence, "doctor.json"), `${JSON.stringify(doctor, null, 2)}\n`);
  if (!controlResultSucceeded("doctor", doctor)) throw new Error("Isolated Doctor failed");
  writeFileSync(join(evidence, "fixture-writes.json"), readFileSync(join(fixture.info.dataDir, "hlf2-result.json")));
  console.log("PASS isolated fixture + Doctor + opportunity dispatch/replay, existing-ID upsert applied/conflict, crash replay, early duplicate, nested alias and negative withholding (fake provider only)");
} finally {
  await fixture.close();
  writeFileSync(join(evidence, "fixture-server.log"), readFileSync(fixture.info.logPath));
}
