// Verified upstream v1.3.2 assets. Metadata selection is not runtime authority.
export const BACKUP_AGE_LICENSE_SHA256 = "afbdb4e07a359499db587ae632815809b1fc1670a92d5449af112ce9a67833a2";
export const BACKUP_AGE_PINS = Object.freeze({
  "darwin-arm64": Object.freeze({
    version: "v1.3.2", platform: "darwin", arch: "arm64", license: "BSD-3-Clause",
    url: "https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-darwin-arm64.tar.gz",
    archiveSha256: "e2020b073c44f692685a24d6abc378817eb81ffaaf49fd0531ef8565f767f2f5",
    executableSha256: "4012dfc2725883beafb710894af4f599b7a94f8c8e0f51f02cc96ab8df33915e",
    keygenSha256: "c16e229245123d0ad27442317461d63915416cad0294395cd19ca93feb3211ea",
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
