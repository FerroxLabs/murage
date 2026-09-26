// Verified upstream v1.3.2 assets. Metadata selection is not runtime authority.
export const BACKUP_AGE_LICENSE_SHA256 = "afbdb4e07a359499db587ae632815809b1fc1670a92d5449af112ce9a67833a2";
export const BACKUP_AGE_PINS = Object.freeze({
  "darwin-arm64": Object.freeze({
    version: "v1.3.2", platform: "darwin", arch: "arm64", license: "BSD-3-Clause",
    url: "https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-darwin-arm64.tar.gz",
    archiveSha256: "e2020b073c44f692685a24d6abc378817eb81ffaaf49fd0531ef8565f767f2f5",
    executableSha256: "4012dfc2725883beafb710894af4f599b7a94f8c8e0f51f02cc96ab8df33915e",
    keygenSha256: "c16e229245123d0ad27442317461d63915416cad0294395cd19ca93feb3211ea",
    payloadSha256: "2dfd0580ed271820d1efb369fdff2d700df863493d41662da9b1b0780589118b",
    stagingDirectory: "backup-age",
  }),
  // Sigsum proof age-v1.3.2-darwin-amd64.tar.gz.proof verified with the key
  // and policy in the age repository's SIGSUM.md (sigsum-generic-2025-1).
  // Upstream darwin/amd64 is unsigned, so payloadSha256 was taken from a signed
  // copy; it is identical under ad-hoc and hardened-runtime signing.
  "darwin-x64": Object.freeze({
    version: "v1.3.2", platform: "darwin", arch: "x64", license: "BSD-3-Clause",
    url: "https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-darwin-amd64.tar.gz",
    archiveSha256: "1d1e4bc66e1427edad7739ae7616157de0e79db8b6d2a1497d7d9925fb06a539",
    executableSha256: "0c2fbcffab91d0af398162a8ed792e096916c8c47c3c400e303904431103f492",
    keygenSha256: "33c25cc60fdfbb27438f885e0e9f6e2e2c29c0a64449738bff57b6aebe42f67f",
    payloadSha256: "f7f71262af84e090a0bf0403a1e60d12df0ad44abf39c990004e5ac2bb4649cc",
    stagingDirectory: "backup-age",
  }),
  "linux-x64": Object.freeze({
    version: "v1.3.2", platform: "linux", arch: "x64", license: "BSD-3-Clause",
    url: "https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-amd64.tar.gz",
    archiveSha256: "cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10",
    executableSha256: "eb7dd1b518f0a307c99cd97782623c5321da049154b04acd2d98d21aa7bc9b2c",
    keygenSha256: "0a0009db842259d6717f7eeb30acb6b90d2a2eb924c6acd0a0db0ca1f1537899",
    stagingDirectory: "backup-age-linux",
  }),
});
export function backupAgePinForTarget(platform, arch) {
  return Object.values(BACKUP_AGE_PINS).find(pin => pin.platform === platform && pin.arch === arch) ?? null;
}
