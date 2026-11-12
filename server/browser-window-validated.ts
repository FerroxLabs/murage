/** Release qualification is exact-version and per OS. Populate only after the
 * S2 real-machine rows pass; CfT requires the same qualification as installed Chrome. */
export type WindowChromePlatform = 'darwin' | 'win32' | 'linux';
export type WindowChromeValidation = Record<WindowChromePlatform, {
  installedVersions: string[];
  cft: { version: string; sha256: Record<string, string> } | null;
}>;
export const WINDOW_CHROME_VALIDATED: WindowChromeValidation = {
  darwin: { installedVersions: [], cft: null },
  win32: { installedVersions: [], cft: null },
  linux: { installedVersions: [], cft: null },
};
export const CHROME_FOR_TESTING_PINS = {
  darwin: WINDOW_CHROME_VALIDATED.darwin.cft,
  win32: WINDOW_CHROME_VALIDATED.win32.cft,
  linux: null,
};
export const isChromeVersion = (value: unknown): value is string => typeof value === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value);
export function validateWindowChromeList(value: unknown): WindowChromeValidation {
  if (!value || typeof value !== 'object') throw new Error('Expected a complete Chrome qualification list');
  const result = {} as WindowChromeValidation;
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const row = (value as WindowChromeValidation)[platform];
    if (!row || !Array.isArray(row.installedVersions) || !row.installedVersions.every(isChromeVersion)) throw new Error('Expected exact four-part Chrome versions for every platform');
    if (row.cft !== null) {
      if (platform === 'linux' || !row.cft || !isChromeVersion(row.cft.version) || !row.cft.sha256 || typeof row.cft.sha256 !== 'object' || !Object.keys(row.cft.sha256).length) throw new Error('Expected a qualified CfT pin');
      for (const [target, hash] of Object.entries(row.cft.sha256)) {
        if (!(platform === 'darwin' ? ['mac-arm64', 'mac-x64'] : ['win64', 'win32']).includes(target) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Expected a platform zip SHA-256');
      }
    }
    result[platform] = { installedVersions: [...row.installedVersions], cft: row.cft && { version: row.cft.version, sha256: { ...row.cft.sha256 } } };
  }
  return result;
}
