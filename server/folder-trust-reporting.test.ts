import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";
import { scanFolderTrustSources } from "./folder-trust.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

it.each(["table", "inline", "dotted"])("requires consent 2 for a generation-2 upstream Settings grant (%s)", shape => {
  const home = mkdtempSync(join(tmpdir(), "murage-trust-report-"));
  try {
    const folder = join(home, "repo"); mkdirSync(folder); writeFileSync(join(folder, "AGENTS.md"), "fixture");
    const key = JSON.stringify(folder);
    const body = (consent: string) => shape === "table" ? `[folders.${key}]\ntrusted = true\n${consent ? `consent = ${consent}` : ""}\n`
      : shape === "inline" ? `[folders]\n${key} = { trusted = true${consent ? `, consent = ${consent}` : ""} }\n`
      : `[folders]\n${key}.trusted = true\n${consent ? `${key}.consent = ${consent}` : ""}\n`;
    for (const consent of ["", "1", "2"]) {
      writeFileSync(join(home, "trusted_folders.toml"), body(consent));
      expect(scanFolderTrustSources(folder, { fuigoHome: home }).upstreamTrusted).toBe(true);
      const scan = scanFolderTrustSources(folder, { fuigoHome: home, trustGeneration: 2 } as never);
      expect(scan.upstreamTrusted === true, `consent=${consent || "absent"}`).toBe(consent === "2");
      expect(scan.upstreamDeclined, "a legacy grant is not a stored no").toBeUndefined();
    }
  } finally { removeTempDirSync(home); }
});
it("an unrouted Cloud home reports a launcher home without reading the owner's instance home", () => {
  const text = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const source = text.slice(text.indexOf("function fuigoHomeForTrust("), text.indexOf("/** The thread desk Murage"));
  const evaluate = (cloud: boolean) => runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '; fuigoHomeForTrust({ instanceId: "fuigo", driverKind: "fuigoAgent" }, false)', {
    process: { env: cloud ? { MURAGE_CLOUD_ROLE: "home" } : {} }, cfg: {}, instanceConfigs: () => ({}), fuigoHomeFromEnv: () => "fixture-owner-home",
  });
  expect(evaluate(false)).toBe("fixture-owner-home");
  expect(evaluate(true)).toBeNull();
});
