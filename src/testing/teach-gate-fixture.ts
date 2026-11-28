// TEACH-ENTRY 1.0.23 witnesses: the four inputs of the real skillRecorderAvailable gate
// (desktop app, Cloud, host platform, the Teach a skill switch), one fixture per test file.
export interface TeachGate { desktop: boolean | undefined; cloud: boolean; platform: string; switchOn: boolean }
export const teachGateOn = (): TeachGate => ({ desktop: true, cloud: false, platform: "darwin", switchOn: true });
export const TEACH_GATE_OFF: Array<[string, Partial<TeachGate>]> = [
  ["Cloud", { cloud: true }],
  ["Windows", { platform: "win32" }],
  ["not the desktop app", { desktop: false }],
  ["switch off", { switchOn: false }],
];
export const teachConfig = (gate: TeachGate) => ({ features: { skillRecorder: gate.switchOn } });
