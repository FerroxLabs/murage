// The pinned agent-browser release the harness downloads for the bots'
// browser (docs/plans/browser-engine.md). Digests were computed from the
// official GitHub assets on 2026-09-06; the pins below are now all the Murage
// vendor build (omb.2) with the control-token patch, hashed from its release assets. Update pins through a reviewed native end-to-end run.
// The Dockerfile retains the official Linux version.
import { CLOUD_BROWSER_PINS } from "./cloud-home/browser-pins.ts";
export const AGENT_BROWSER_VERSION = "0.36.0";

export interface AgentBrowserReleaseAsset {
  /** `<platform>-<arch>`; Linux adds `-musl` on Alpine-style systems. */
  target: string;
  /** File name on the GitHub release. */
  asset: string;
  sha256: string;
  bytes: number;
  /** A reviewed platform-specific vendor revision; other assets use the upstream version. */
  version?: string;
  /** Exact release URL for a reviewed vendor build, never a mutable latest URL. */
  url?: string;
}

/** The Murage vendor build of the pinned engine: agent-browser 0.36.0 plus the control-token patch (release browser-engine-v0.36.0-omb.2 on FerroxLabs/murage). */
const VENDOR_REVISION = `${AGENT_BROWSER_VERSION}-omb.2`;
function vendorAsset(target: string, bytes: number, sha256: string): AgentBrowserReleaseAsset {
  const asset = `agent-browser-${target}-${VENDOR_REVISION}${target.startsWith("win32") ? ".exe" : ""}`;
  return { target, asset, version: VENDOR_REVISION, bytes, sha256,
    url: `https://github.com/FerroxLabs/murage/releases/download/browser-engine-v${VENDOR_REVISION}/${asset}` };
}

const RELEASES = new Map<string, AgentBrowserReleaseAsset>([
  [
    "darwin-arm64",
    vendorAsset("darwin-arm64", 12462368, "0807f4251c7488d6cf3eb00e60d18e9aac5f5024442d6985af84be2b67a39f08"),
  ],
  [
    "darwin-x64",
    vendorAsset("darwin-x64", 13578480, "9e222c1dc7dc5ab8f939430e3d4fbb103bb85571cf6774ec249341af6f8a8f75"),
  ],
  [
    "linux-arm64",
    vendorAsset("linux-arm64", 12510368, "641db91fd1ce133962bd3aba9ab2e19d347a4e73da7bed7fc43c6c525ae24267"),
  ],
  [
    "linux-musl-arm64",
    vendorAsset("linux-musl-arm64", 12411528, "b0094f4149da76cbc79a3270933ec196c8dd6b4dbc5993455ab5c098a8cf7ed8"),
  ],
  [
    "linux-musl-x64",
    vendorAsset("linux-musl-x64", 14415056, "c00fd67eb2d08500835f9c64db743949eee0151bd0817ac00121bc2aaa2bcc7e"),
  ],
  [
    "linux-x64",
    vendorAsset("linux-x64", 14276928, "bdf134261a5310c008f763871ddc01f0110018f94a5af9a689f152fde3b53d0f"),
  ],
  [
    "win32-x64",
    vendorAsset("win32-x64", 13874176, "85512d1c06068910d6fe5ab59d59bc2320ad786fc07861fb1036ee32ad25d21c"),
  ],
]);

export function agentBrowserReleaseUrl(asset: AgentBrowserReleaseAsset): string {
  return asset.url ?? `https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/${asset.asset}`;
}

export function agentBrowserReleaseVersion(asset: AgentBrowserReleaseAsset | null): string {
  return asset?.version ?? AGENT_BROWSER_VERSION;
}

/** THE rule for what `agent-browser --version` may print for an asset: the upstream version or that asset's own
 * reviewed vendor version, and nothing else (an older vendor revision must not pass). The launch check and the
 * vendor smoke both call this one function, so they cannot drift apart. */
export function agentBrowserVersionOutputAccepted(output: string, asset: AgentBrowserReleaseAsset | null): boolean {
  return output === `agent-browser ${AGENT_BROWSER_VERSION}` || output === `agent-browser ${agentBrowserReleaseVersion(asset)}`;
}

/** The asset for this machine, or null where Vercel publishes none. */
export function resolveAgentBrowserReleaseAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl = false,
): AgentBrowserReleaseAsset | null {
  if (process.env.MURAGE_CLOUD_ROLE === "home" && platform === "linux" && arch === "x64" && !musl) {
    return { target: "linux-x64", asset: "agent-browser-linux-x64", version: CLOUD_BROWSER_PINS.agentVersion,
      url: CLOUD_BROWSER_PINS.agentUrl, bytes: CLOUD_BROWSER_PINS.agentBytes, sha256: CLOUD_BROWSER_PINS.agentSha256 };
  }
  if (process.env.MURAGE_CLOUD_ROLE === "home" && platform === "linux" && arch === "arm64" && !musl) {
    const arm = CLOUD_BROWSER_PINS.arm64;
    return { target: "linux-arm64", asset: "agent-browser-linux-arm64", version: CLOUD_BROWSER_PINS.agentVersion,
      url: arm.agentUrl, bytes: arm.agentBytes, sha256: arm.agentSha256 };
  }
  const key = platform === "linux" && musl ? `linux-musl-${arch}` : `${platform}-${arch}`;
  return RELEASES.get(key) ?? null;
}
