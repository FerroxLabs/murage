// SPDX-License-Identifier: AGPL-3.0-or-later
/** Linux home assets: the agent-browser entries are the Murage vendor build (0.38.1 plus the control-token patch, release browser-engine-v0.38.1-omb.2); the Chrome entries were checked against primary releases on 2026-09-30. */
export const CLOUD_BROWSER_PINS = {
  agentVersion: "0.38.1-omb.2", agentBytes: 18358376,
  agentSha256: "bd16b25ae464971ee61ee645bdf6e1c1b882657e8fe8d6afa93e899b1ce97207",
  agentUrl: "https://github.com/FerroxLabs/murage/releases/download/browser-engine-v0.38.1-omb.2/agent-browser-linux-x64-0.38.1-omb.2",
  chromeVersion: "154.0.8037.92", chromeBytes: 120477194,
  chromeSha256: "636aa5c79f2693632e9921b8bbb050038ba11672e02346c06c20f991aed096f9",
  chromeExecutableSha256: "7c141b276aacc74fe51f06986345fb0dbce0e3756413746fb18541b878c17706",
  // linux-arm64 homes (build host CAX). Same agent-browser and Chrome for Testing
  // versions as x64. agent-browser sha256 equals the GitHub release asset
  // digest; the Chrome zip md5 equals the object md5Hash that Google Cloud
  // Storage publishes for it (Chrome for Testing ships no checksum file), and
  // the sha256s were computed from those verified bytes on 2026-10-09.
  arm64: {
    agentBytes: 15971496,
    agentSha256: "4d774cdaf709b6e2a67b02ee169bb6cfe3858a8dabcc901132cfc4e1d2f642ae",
    agentUrl: "https://github.com/FerroxLabs/murage/releases/download/browser-engine-v0.38.1-omb.2/agent-browser-linux-arm64-0.38.1-omb.2",
    chromeBytes: 121182296,
    chromeSha256: "0ed0e47d9e9f639197f508d62ada09e5c6b4c4c60edab3160a9312a733091df6",
    chromeExecutableSha256: "8ef1e673b0083695a65e383dedf07fca9ecc1cffebf02b92c0059eb3879d8a9e",
  },
} as const;
