import { readFileSync, writeFileSync } from "node:fs";
import { launchVerificationServer, runControlMurage, controlResultSucceeded } from "./control-murage.ts";
const fixture = await launchVerificationServer(process.env, undefined, { readyTimeoutMs: 60000 });
try {
  writeFileSync("evidence/f02/fixture.json", `${JSON.stringify(fixture.info, null, 2)}\n`);
  const result = await runControlMurage(["doctor", "--url", fixture.info.url]);
  writeFileSync("evidence/f02/doctor.json", `${JSON.stringify(result, null, 2)}\n`);
  if (!controlResultSucceeded("doctor", result)) throw new Error("Isolated fixture doctor failed");
  console.log("PASS isolated fixture launch + doctor (shared primitives tested separately; no production adoption claim)");
} finally {
  await fixture.close();
  writeFileSync("evidence/f02/fixture-server.log", readFileSync(fixture.info.logPath));
}
