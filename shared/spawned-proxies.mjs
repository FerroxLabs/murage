// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every file the server spawns as its own process (or worker), relative to the server root and without its extension
// (.ts in dev, .js once packaged). server/proxy-paths.ts resolves them (SPAWNED_PROXIES); the desktop main process
// reads the same list to refuse to start as the app when it was launched as one of them without ELECTRON_RUN_AS_NODE.
export const SPAWNED_PROXY_FILES = Object.freeze({
  memory: "drivers/memory-proxy",
  memoryWorker: "memory/worker",
  // The WhatsApp bridge child (Baileys socket). Built by its own esbuild call in scripts/bundle-server.mjs, not
  // listed in ENTRY_POINTS, because that build would inline Baileys; `baileys` and `jimp` stay external.
  whatsappBridge: "channels/whatsapp/bridge",
  // A worker thread, not a process: reads a large import off the main thread.
  importGuardWorker: "bot-package-guard-worker",
  // A worker thread: removes a deleted conversation's history from the engines' own files off the main thread.
  engineHistoryWorker: "engine-history-worker",
  transcriptReadWorker: "transcript-read-worker",
  inboxFillWorker: "inbox-fill-worker",
  // Windows only: the per-engine launcher that is in the engine's job before it starts the CLI (procs.ts, U24).
  jobLauncher: "job-launcher",
  computer: "computer-proxy",
  permission: "permission-proxy",
  containerMcp: "container-mcp",
  vpsContainerMcp: "vps-container-mcp",
  vpsRelayMcp: "cloud-home/vps-relay-mcp",
  agents: "drivers/agents-proxy",
  dweb: "drivers/dweb-proxy",
  connectors: "connector-proxy",
  remoteMcp: "drivers/remote-mcp-proxy",
  phone: "drivers/phone-proxy",
  browser: "drivers/browser-proxy",
  headlessBrowser: "drivers/headless-browser-proxy",
  unifiedBrowser: "drivers/unified-browser-proxy",
  hostComputer: "drivers/host-computer-proxy",
  // Loaded by the external `pi` process via `-e`, not by this server — but
  // resolved through the same single source of truth so the packaged layout
  // check can assert it ships.
  piMcpExtension: "drivers/pi-mcp-extension",
  piPermissionGate: "drivers/pi-permission-gate",
});
