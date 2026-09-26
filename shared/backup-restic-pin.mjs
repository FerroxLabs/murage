// Pinned restic 0.19.1 release assets, one per shipped desktop target.
// Every archiveSha256 is the line for that asset in the release's SHA256SUMS,
// whose signature (SHA256SUMS.asc) verifies against the restic maintainer key
// CF8F 18F2 8445 7597 3F79  D4E1 91A6 868B D3F7 A907. originalSha256 is the
// executable inside that archive. payloadSha256 (macOS only) is the Mach-O
// payload with its code signature normalised away (normalizedAgePayloadHash),
// which is what survives the release job's own Developer ID signature.
// Metadata selection is not runtime authority: the attestation reads the pin
// for the running platform and arch only.
export const RESTIC_VERSION="0.19.1";
export const RESTIC_LICENSE_SHA256="da4cf58a2e9300d114c67b463096312368e689b9a07f0278042851b92efc6d40";
export const RESTIC_PINS=Object.freeze({
  "darwin-arm64":Object.freeze({platform:"darwin",arch:"arm64",format:"bz2",executable:"restic",stagingDirectory:"backup-restic",
    url:"https://github.com/restic/restic/releases/download/v0.19.1/restic_0.19.1_darwin_arm64.bz2",
    archiveSha256:"7be0a144ccc377880f294204aa271d76e4b79554b42a751151d425ce6ebac143",
    originalSha256:"06582569ff2f10e1935a6f12187c76db02f0bae99e6e54098f2cdc374766d768",
    payloadSha256:"ad39fc4888081e6258acd5bba3934ba4b33b241825778993de3b927bd44948f3"}),
  "darwin-x64":Object.freeze({platform:"darwin",arch:"x64",format:"bz2",executable:"restic",stagingDirectory:"backup-restic",
    url:"https://github.com/restic/restic/releases/download/v0.19.1/restic_0.19.1_darwin_amd64.bz2",
    archiveSha256:"c38d579622cf602f665234c5a8c315030b6cf70656028fe6dc29a786b60e5f35",
    originalSha256:"b2b553b402b9971b0c3f673d880397a421526f55a08f21fe5b82b5dd9e049a08",
    payloadSha256:"9ff494052a82576bf573d7fd48e7dd4fe8ebd24f94a81c3ca976bc8e8ec4714a"}),
  "linux-x64":Object.freeze({platform:"linux",arch:"x64",format:"bz2",executable:"restic",stagingDirectory:"backup-restic-linux",
    url:"https://github.com/restic/restic/releases/download/v0.19.1/restic_0.19.1_linux_amd64.bz2",
    archiveSha256:"f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c",
    originalSha256:"20d4142678d0d95ec11a4759def1b73fd9190abc9ca19e4b62d067c0b387e639"}),
  // Raw upstream bytes: copied as a single file so Windows signing never
  // touches them, like age.exe; the release gate verifies this exact hash.
  "win32-x64":Object.freeze({platform:"win32",arch:"x64",format:"zip",executable:"restic.exe",member:"restic_0.19.1_windows_amd64.exe",stagingDirectory:"backup-tools/win32-x64",
    url:"https://github.com/restic/restic/releases/download/v0.19.1/restic_0.19.1_windows_amd64.zip",
    archiveSha256:"da948ad707ed690426473aaba2046cd61f8f90f6f0e7dab6be0d5796531de67d",
    originalSha256:"b0dd1fd21eea5d8fe1325f55f7118213c21f36de8a261e04c0624a5ab9fd7830"}),
});
export function resticPinForTarget(platform,arch){return Object.values(RESTIC_PINS).find(pin=>pin.platform===platform&&pin.arch===arch)??null;}
// Kept for existing callers: the darwin-arm64 values.
export const RESTIC_ORIGINAL_SHA256=RESTIC_PINS["darwin-arm64"].originalSha256;
export const RESTIC_PAYLOAD_SHA256=RESTIC_PINS["darwin-arm64"].payloadSha256;
export const RESTIC_ARCHIVE_SHA256=RESTIC_PINS["darwin-arm64"].archiveSha256;
export const RESTIC_ARCHIVE_URL=RESTIC_PINS["darwin-arm64"].url;
