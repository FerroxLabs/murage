export interface VpsComputerStatus {
  configured: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  ready: boolean;
  problem: string | null;
}

/** A managed container from an older release must be explicitly replaced.
 * Provision deliberately refuses to overwrite it. */
export function vpsComputerNeedsReplacement(status: VpsComputerStatus): boolean {
  return status.managed && status.container !== "missing" && !status.imageMatches;
}
