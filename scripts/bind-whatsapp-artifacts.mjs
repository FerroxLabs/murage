// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Run only after signing, stapling and final archive creation. */
export async function bindWhatsAppArtifacts(reportFile, files) {
  if (!files.length) throw Error("Pass a qualification report and final artifacts");
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  if (report.socketFree !== true || !report.platform || !report.arch) throw Error("WhatsApp qualification report is incomplete");
  const artifacts = [];
  for (const file of files) {
    const name = basename(file);
    if (artifacts.some(item => item.name === name)) throw Error("Duplicate artifact name");
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    artifacts.push({ name, sha256: hash.digest("hex") });
  }
  const temporary = `${reportFile}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...report, artifacts }, null, 2) + "\n");
  renameSync(temporary, reportFile);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [report, ...files] = process.argv.slice(2);
  await bindWhatsAppArtifacts(report, files);
}
