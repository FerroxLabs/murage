// Merges the fake ACP `approver` instance into an isolated host's config.json.
// The stop-line command lives only in fixtures/approver-instance.json; it is
// read and written as data here, never put through a shell.
//   node merge-config.mjs <config.json> <fake-acp-cli path>
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [, , configPath, cli] = process.argv;
if (!configPath || !cli) {
  console.error("usage: merge-config.mjs <config.json> <fake-acp-cli path>");
  process.exit(2);
}
const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "approver-instance.json"), "utf8"));
fixture.approver.config.cli = cli;
let config = {};
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
config.instances = { ...(config.instances ?? {}), ...fixture };
writeFileSync(configPath, JSON.stringify(config));
