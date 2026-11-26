// C8 · owner: core L0 (producer) → every page lane, find L1 (consumers).
// A refusal names the setting that fixes it, beside its message. Survives the proxy, the API and the client decode.
export interface SettingRef {
  /** Manifest id of the control or page (settings-controls manifest). */
  id: string;
  bot?: string;
  account?: string;
  device?: string;
  item?: string;
  /** The refusal code the handler emitted. */
  code: string;
}
export const SETTING_REF_KEY = "settingRef" as const;
