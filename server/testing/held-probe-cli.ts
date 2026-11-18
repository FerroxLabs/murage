// Test-side only. A launcher for the fake Claude CLI whose `--version` probe
// can be held: once `hold` exists, the probe writes `held`, answers only after
// `release`, then writes `answered`. A Stop can then land while a turn is still
// in setup, before it has any engine process. A POSIX script, so not on Windows.
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type HeldProbe = { hold: string; held: string; release: string; answered: string; cli: string };

export function heldProbeLauncher(dir: string, fakeCli: string): HeldProbe {
  const probe = { hold: join(dir, "probe-hold"), held: join(dir, "probe-held"), release: join(dir, "probe-release"), answered: join(dir, "probe-answered"), cli: join(dir, "held-probe-cli.mjs") };
  writeFileSync(probe.cli, `#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
if (process.argv[2] === "--version" && existsSync(${JSON.stringify(probe.hold)})) {
  appendFileSync(${JSON.stringify(probe.held)}, "held");
  while (!existsSync(${JSON.stringify(probe.release)})) await new Promise(resolve => setTimeout(resolve, 10));
  appendFileSync(${JSON.stringify(probe.answered)}, "answered");
}
await import(${JSON.stringify(pathToFileURL(fakeCli).href)});
`);
  chmodSync(probe.cli, 0o755);
  return probe;
}
