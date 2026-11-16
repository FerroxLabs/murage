import type { WindowsUnsignedPePin } from "./windows-signed-pe.mjs";
export interface WindowsBackupSignedPin { path:string; sha256:string; originalSha256:string; unsigned?:WindowsUnsignedPePin }
export function loadWindowsBackupSignedPins(directory:string):Record<string,WindowsBackupSignedPin>|null;
