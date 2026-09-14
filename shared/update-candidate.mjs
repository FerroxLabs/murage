// Public, path-free update identity. Safe to import from browser and Node.
const keys = (value, expected) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === [...expected].sort().join(",");
export function parseUpdateCandidate(value) {
  if (!keys(value, ["schemaVersion", "candidateId", "version", "platform", "arch", "artifacts", "manifestDigests"])
    || value.schemaVersion !== 1 || typeof value.candidateId !== "string" || !/^update-[a-f0-9]{64}$/.test(value.candidateId)
    || typeof value.version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/.test(value.version)
    || !["darwin", "win32", "linux"].includes(value.platform)
    || !["x64", "arm64", "ia32", "arm"].includes(value.arch)
    || !Array.isArray(value.artifacts) || value.artifacts.length < 1 || value.artifacts.length > 2
    || !Array.isArray(value.manifestDigests) || value.manifestDigests.length < 1 || value.manifestDigests.length > 64) {
    throw new Error("Update candidate metadata is invalid.");
  }
  const digest = (item) => typeof item === "string" && /^[A-Za-z0-9+/]{85}[AQgw]==$/.test(item);
  if (value.manifestDigests.some((item) => !digest(item))
    || value.manifestDigests.join(",") !== [...new Set(value.manifestDigests)].sort().join(",")
    || value.artifacts.some((item, index) => !keys(item, ["kind", "sha512"])
      || item.kind !== (index === 0 ? "primary" : "package") || !digest(item.sha512)
      || !value.manifestDigests.includes(item.sha512))) throw new Error("Update candidate digests are invalid.");
  return Object.freeze({ schemaVersion: 1, candidateId: value.candidateId, version: value.version,
    platform: value.platform, arch: value.arch,
    artifacts: Object.freeze(value.artifacts.map((item) => Object.freeze({ kind: item.kind, sha512: item.sha512 }))),
    manifestDigests: Object.freeze([...value.manifestDigests]) });
}

export function canonicalUpdateDescriptor(value) {
  const candidate = parseUpdateCandidate(value);
  return JSON.stringify({ schemaVersion: candidate.schemaVersion, version: candidate.version,
    platform: candidate.platform, arch: candidate.arch, artifacts: candidate.artifacts,
    manifestDigests: candidate.manifestDigests });
}
