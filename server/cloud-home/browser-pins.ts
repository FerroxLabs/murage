// SPDX-License-Identifier: AGPL-3.0-or-later
/** Linux home assets checked against primary releases on 2026-09-30. */
export const CLOUD_BROWSER_PINS = {
  agentVersion: "0.38.1", agentBytes: 18247376,
  agentSha256: "5100149a1903211c889de4e545bf36d90803740cea4f99aa22651649f9205ea1",
  agentUrl: "https://github.com/vercel-labs/agent-browser/releases/download/v0.38.1/agent-browser-linux-x64",
  chromeVersion: "154.0.8037.92", chromeBytes: 120477194,
  chromeSha256: "636aa5c79f2693632e9921b8bbb050038ba11672e02346c06c20f991aed096f9",
  chromeExecutableSha256: "7c141b276aacc74fe51f06986345fb0dbce0e3756413746fb18541b878c17706",
  // linux-arm64 homes (build host CAX). Same agent-browser and Chrome for Testing
  // versions as x64. agent-browser sha256 equals the GitHub release asset
  // digest; the Chrome zip md5 equals the object md5Hash that Google Cloud
  // Storage publishes for it (Chrome for Testing ships no checksum file), and
  // the sha256s were computed from those verified bytes on 2026-10-09.
  arm64: {
    agentBytes: 15832320,
    agentSha256: "937b315ee0761e8a62f7950ddcfef9b3d3d8e8d5eb9c9d2bf9e23e5725664511",
    agentUrl: "https://github.com/vercel-labs/agent-browser/releases/download/v0.38.1/agent-browser-linux-arm64",
    chromeBytes: 121182296,
    chromeSha256: "0ed0e47d9e9f639197f508d62ada09e5c6b4c4c60edab3160a9312a733091df6",
    chromeExecutableSha256: "8ef1e673b0083695a65e383dedf07fca9ecc1cffebf02b92c0059eb3879d8a9e",
  },
} as const;
