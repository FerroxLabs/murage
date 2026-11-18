import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Task Scheduler launches the installed Murage.exe directly. A CUI image would
 * allocate a console before JS can hide children; Task.Settings.Hidden only
 * hides the task in the scheduler UI. Both PE32 and PE32+ put Subsystem at +68.
 */
export function assertWindowsGui(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const refuse = () => { throw new Error("WINDOWS_GUI_SUBSYSTEM_REQUIRED: Sentinel must start a GUI-subsystem Murage.exe"); };
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) refuse();
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 64 || pe + 24 + 70 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550) refuse();
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const optional = pe + 24;
  if (optionalSize < 70 || optional + optionalSize > bytes.length || ![0x10b, 0x20b].includes(bytes.readUInt16LE(optional))) refuse();
  if (bytes.readUInt16LE(optional + 68) !== 2) refuse();
  return { subsystem: 2, name: "WINDOWS_GUI" };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/check-windows-gui.mjs <packaged Murage.exe>");
  console.log(JSON.stringify(assertWindowsGui(readFileSync(process.argv[2]))));
}
