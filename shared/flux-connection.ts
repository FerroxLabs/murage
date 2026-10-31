export interface FluxConnectionStatus {
  configured: boolean; revision: string; conflict: boolean;
  choices: { id: string; label: string; enabled: boolean }[];
  /** A key usable before a save was replaced or removed since this launch: running engines still hold it until Murage restarts. */
  restartRequired?: boolean;
}
export type FluxConnectionMutation =
  | { action: "connect" | "replace"; revision: string; key: string }
  | { action: "select"; revision: string; connectionId: string }
  | { action: "disconnect"; revision: string };
export interface FluxConnectionTestResult { modelCount: number; error?: string }
