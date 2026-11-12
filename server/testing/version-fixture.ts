// Relative releases keep future-version fixtures ahead of a moving pin.
function nextVersion(version: string, part: 0 | 1 | 2): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Expected a release version, got ${version}`);
  const parts = version.split(".").map(Number);
  return parts.map((value, index) => index < part ? value : index === part ? value + 1 : 0).join(".");
}

export const nextPatch = (version: string): string => nextVersion(version, 2);
export const nextMinor = (version: string): string => nextVersion(version, 1);
export const nextMajor = (version: string): string => nextVersion(version, 0);
