// Primary source: https://github.com/FiloSottile/age/releases/tag/v1.3.2
// BSD-3-Clause. Archive digest from the release API; executable digest after
// verifying and extracting only the named archive entries. No global install.
import { BACKUP_AGE_PINS } from "./backup-age-pins.mjs";
export { backupAgePinForTarget } from "./backup-age-pins.mjs";
export const BACKUP_AGE_PIN = BACKUP_AGE_PINS["darwin-arm64"];
