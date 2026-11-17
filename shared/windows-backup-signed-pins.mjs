// Build/signing owner: win-sac-sign; runtime backup owner: MAIN.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
export function loadWindowsBackupSignedPins(directory) {
  const file = join(directory, "windows-sac-pins.json");
  let stat;
  try { stat = lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw Error("WINDOWS_BACKUP_SIGNED_PINS_INVALID");
  const data = JSON.parse(readFileSync(file, "utf8")), pins = {};
  if (data.schema !== 1 || !Array.isArray(data.files) || data.files.length !== 3) throw Error("WINDOWS_BACKUP_SIGNED_PINS_INVALID");
  for (const pin of data.files) {
    if (!["age.exe", "age-keygen.exe", "restic.exe"].includes(pin.path) || pins[pin.path]
      || !/^[a-f0-9]{64}$/.test(pin.sha256) || !/^[a-f0-9]{64}$/.test(pin.originalSha256)) throw Error("WINDOWS_BACKUP_SIGNED_PINS_INVALID");
    pins[pin.path] = pin;
  }
  return pins;
}
