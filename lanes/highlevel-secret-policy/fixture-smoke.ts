// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { writeFileSync, copyFileSync } from "node:fs";
import { launchVerificationServer, runControlMurage } from "../../scripts/control-murage.ts";
const fixture = await launchVerificationServer(process.env);
try {
  writeFileSync("lanes/highlevel-secret-policy/fixture-launch.json", JSON.stringify(fixture.info, null, 2));
  const doctor = await runControlMurage(["doctor", "--url", fixture.info.url], { env: { ...process.env, MURAGE_DATA_DIR: fixture.info.dataDir } });
  writeFileSync("lanes/highlevel-secret-policy/fixture-doctor.json", JSON.stringify(doctor, null, 2));
  copyFileSync(fixture.info.logPath, "lanes/highlevel-secret-policy/fixture-server.log");
} finally { await fixture.stop(); }
