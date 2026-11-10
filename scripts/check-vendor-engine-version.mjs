// check-vendor-engine-version.mjs <engine-binary> <set> <target>
// The vendor smoke's version gate. It executes the built engine on its native runner and applies the SAME rule the
// Murage launch check uses (agentBrowserVersionOutputAccepted, server/browser-engine-release.ts) against the pinned
// asset version, so a binary Murage would refuse at launch can never pass the smoke. Nothing here is a hard-coded
// version string: the expected text comes from the vendor set and the pin tables.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { VENDOR_SETS, reportedEngineVersion, vendorVersion } from "./build-browser-vendor.mjs";
import { agentBrowserVersionOutputAccepted, resolveAgentBrowserReleaseAsset } from "../server/browser-engine-release.ts";
import { CLOUD_BROWSER_PINS } from "../server/cloud-home/browser-pins.ts";

/** The pinned desktop asset for a vendor target ("linux-musl-x64" is linux/x64 with musl). */
export function pinnedDesktopAsset(target) {
  const [platform, ...rest] = target.split("-");
  const arch = rest[rest.length - 1], musl = rest.includes("musl");
  const asset = resolveAgentBrowserReleaseAsset(platform, arch, musl);
  assert(asset, `No pinned engine asset for ${target}`);
  assert.equal(asset.target, target, `Pin table resolved ${asset.target} for ${target}`);
  return asset;
}

/** Throws unless `output` (the engine's `--version` line) is what Murage requires for this set and target. */
export function checkVendorEngineOutput({ set, target, output }) {
  const plan = VENDOR_SETS[set];
  assert(plan, `Unknown engine set ${set}`);
  const printed = `agent-browser ${reportedEngineVersion(set, target)}`;
  if (set === "0.36.0") {
    const asset = pinnedDesktopAsset(target);
    assert.equal(asset.version, vendorVersion(set, target), `The pinned ${target} asset is ${asset.version}; this build is ${vendorVersion(set, target)}`);
    assert(agentBrowserVersionOutputAccepted(output, asset), `Murage's launch check would refuse this engine: it printed "${output}" for pinned asset ${asset.version}`);
  } else {
    assert.equal(CLOUD_BROWSER_PINS.agentVersion, plan.version, `The pinned Cloud home engine is ${CLOUD_BROWSER_PINS.agentVersion}; this build is ${plan.version}`);
  }
  // Stricter than the launch check on purpose: the build must print exactly what it is declared to print
  // (Windows: the vendor revision; elsewhere: the upstream version).
  assert.equal(output, printed, `Engine printed "${output}", expected "${printed}"`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [binary, set, target] = process.argv.slice(2);
  assert(binary && set && target, "Usage: node scripts/check-vendor-engine-version.mjs ENGINE_BINARY SET TARGET");
  const output = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 20_000, env: { ...process.env, CI: "" } }).trim();
  checkVendorEngineOutput({ set, target, output });
  console.log(`ok   version ${output}`);
}
