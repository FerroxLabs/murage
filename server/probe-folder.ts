import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let folder: string | undefined;
/** Process-local neutral working directory for catalog and version reads. */
export function probeFolder(): string {
  return folder ??= mkdtempSync(join(tmpdir(), "murage-probes-"));
}
