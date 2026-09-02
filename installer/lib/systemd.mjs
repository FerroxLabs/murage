/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * The systemd unit `murage setup` stages.
 *
 * Two lessons taken from Wayland's version, which learned them the hard way:
 *  - systemd starts with a minimal PATH, so the runtime's own bin directory has
 *    to be named explicitly or the service dies with runtime-not-found;
 *  - the unit is STAGED to /tmp and the operator runs the `sudo mv` themselves,
 *    rather than the installer silently writing to /etc as root.
 *
 * Added here and absent there: `After=tailscaled.service`. Murage's cloud
 * deployment is only reachable through the tailnet, so starting the app before
 * the tailnet daemon means the first boot after a reboot comes up unreachable
 * and, in tailnet bind mode, fails its own bind check.
 */

import { writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * @param {object} opts
 * @param {string} opts.execPath the node binary
 * @param {string} opts.cliPath absolute path to bin/murage.mjs
 * @param {string} opts.dataDir
 * @param {string} opts.envFile
 * @param {string} [opts.user]
 * @param {boolean} [opts.tailscale] whether Tailscale enrolment was configured
 * @returns {string}
 */
export function unitText(opts) {
  const wants = opts.tailscale ? "\nWants=tailscaled.service\nAfter=tailscaled.service" : "";
  const nodeDir = dirname(opts.execPath);
  return `[Unit]
Description=Murage headless server (tailnet-only)
After=network-online.target${wants}

[Service]
Type=simple
ExecStart=${opts.execPath} ${opts.cliPath} start
Restart=always
RestartSec=3
${opts.user ? `User=${opts.user}\n` : ""}Environment=MURAGE_DATA_DIR=${opts.dataDir}
Environment=MURAGE_ENV_FILE=${opts.envFile}
# systemd starts with a minimal PATH that excludes the directory the node
# runtime actually lives in, so name it explicitly or ExecStart dies at boot.
Environment=PATH=${nodeDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# The listener is loopback-only or tailnet-only by policy (see lib/bind.mjs);
# these make that structural rather than merely intended.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=${opts.dataDir}

[Install]
WantedBy=multi-user.target
`;
}

export const STAGED_PATH = "/tmp/murage.service";
export const UNIT_PATH = "/etc/systemd/system/murage.service";

/**
 * Write the unit somewhere the operator can inspect it, and return the three
 * commands they run. Never installs it itself.
 * @param {Parameters<typeof unitText>[0]} opts
 * @param {string} [stagedPath]
 * @returns {{ stagedPath: string, commands: string[] }}
 */
export function stageUnit(opts, stagedPath = STAGED_PATH) {
  writeFileSync(stagedPath, unitText(opts), { mode: 0o644 });
  return {
    stagedPath,
    commands: [
      `sudo mv ${stagedPath} ${UNIT_PATH}`,
      "sudo systemctl daemon-reload && sudo systemctl enable --now murage",
      "sudo journalctl -u murage -f",
    ],
  };
}
