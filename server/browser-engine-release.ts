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
  /** Exact `--version` text when it differs from `version`. */
  reportedVersion?: string;
  /** Exact release URL for a reviewed vendor build, never a mutable latest URL. */
  url?: string;
}

/** The Murage vendor build of the pinned engine: agent-browser 0.36.0 plus the control-token patch (release browser-engine-v0.36.0-omb.2 on FerroxLabs/murage). */
const VENDOR_REVISION = `${AGENT_BROWSER_VERSION}-omb.2`;
/** Windows alone is omb.3: omb.2 plus the no-console patch (release browser-engine-v0.36.0-omb.3), so a bot's message never opens a console window. */
const WINDOWS_VENDOR_REVISION = `${AGENT_BROWSER_VERSION}-omb.3`;
function vendorAsset(target: string, bytes: number, sha256: string): AgentBrowserReleaseAsset {
  const revision = target.startsWith("win32") ? WINDOWS_VENDOR_REVISION : VENDOR_REVISION;
  const asset = `agent-browser-${target}-${revision}${target.startsWith("win32") ? ".exe" : ""}`;
  return { target, asset, version: revision, bytes, sha256,
    url: `https://github.com/FerroxLabs/murage/releases/download/browser-engine-v${revision}/${asset}` };
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
    vendorAsset("win32-x64", 13874176, "4a4306c34c392fd4c034b86cf6c1ac86d4f0d4a018c0d4557a28222639993f2a"),
  ],
]);

export function agentBrowserReleaseUrl(asset: AgentBrowserReleaseAsset): string {
  return asset.url ?? `https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/${asset.asset}`;
}

export function agentBrowserReleaseVersion(asset: AgentBrowserReleaseAsset | null): string {
  return asset?.version ?? AGENT_BROWSER_VERSION;
}

/** THE rule for what `agent-browser --version` may print for an asset: the upstream version or that asset's own
 * reviewed vendor version or explicitly declared reported version, and nothing else (an older vendor revision must not pass). The launch check and the
 * vendor smoke both call this one function, so they cannot drift apart. */
export function agentBrowserVersionOutputAccepted(output: string, asset: AgentBrowserReleaseAsset | null): boolean {
  return output === `agent-browser ${AGENT_BROWSER_VERSION}` || output === `agent-browser ${agentBrowserReleaseVersion(asset)}`
    || (asset?.reportedVersion !== undefined && output === `agent-browser ${asset.reportedVersion}`);
}

/** The asset for this machine, or null where Vercel publishes none. */
export function resolveAgentBrowserReleaseAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl = false,
): AgentBrowserReleaseAsset | null {
  if (process.env.MURAGE_CLOUD_ROLE === "home" && platform === "linux" && (arch === "x64" || arch === "arm64") && !musl) {
    return cloudHomeReleaseAsset(arch);
  }
  const key = platform === "linux" && musl ? `linux-musl-${arch}` : `${platform}-${arch}`;
  return RELEASES.get(key) ?? null;
}

/** The reviewed Cloud home asset, independent of the current process environment. */
export function cloudHomeReleaseAsset(arch: "x64" | "arm64"): AgentBrowserReleaseAsset {
  const pin = arch === "arm64" ? CLOUD_BROWSER_PINS.arm64 : CLOUD_BROWSER_PINS;
  return { target: `linux-${arch}`, asset: `agent-browser-linux-${arch}`, version: CLOUD_BROWSER_PINS.agentVersion,
    reportedVersion: CLOUD_BROWSER_PINS.agentReportedVersion,
    url: pin.agentUrl, bytes: pin.agentBytes, sha256: pin.agentSha256 };
}
