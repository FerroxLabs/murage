export interface BackupAgePin {
  readonly version: string; readonly platform: string; readonly arch: string;
  readonly license: string; readonly url: string; readonly archiveSha256: string;
  readonly executableSha256: string; readonly keygenSha256: string; readonly stagingDirectory: string;
}
export const BACKUP_AGE_LICENSE_SHA256: string;
export const BACKUP_AGE_PINS: Readonly<Record<"darwin-arm64" | "linux-x64", BackupAgePin>>;
export function backupAgePinForTarget(platform: string, arch: string): BackupAgePin | null;
