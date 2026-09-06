export declare const RESTORED_CONNECTIONS_FILE: "restored-connections.json";
export interface RestoredConnectionProfile {
  readonly id: string;
  readonly directory: string;
  readonly credentialsFile: string;
  readonly companionSettings: string;
  readonly companionState: string;
  readonly tunnelRuntime: string;
}
export declare function restoredConnectionProfile(dataDir: string): RestoredConnectionProfile | null;
export declare function restoredHarnessEnvironment<T extends Record<string, string | undefined>>(environment: T, profile: RestoredConnectionProfile | null): T;
export declare function restoredBrowserPartition(partition: string, profile: RestoredConnectionProfile | null): string;
