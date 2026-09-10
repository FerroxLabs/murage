export interface FluxConnectionStatus {
  configured: boolean; revision: string; conflict: boolean;
  choices: { id: string; label: string; enabled: boolean }[];
}
export type FluxConnectionMutation =
  | { action: "connect" | "replace"; revision: string; key: string }
  | { action: "select"; revision: string; connectionId: string }
  | { action: "disconnect"; revision: string };
export interface FluxConnectionTestResult { modelCount: number; error?: string }
