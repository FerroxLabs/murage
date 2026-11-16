// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { win32 } from 'node:path';
const refusedExtensions = new Set('.exe .com .bat .cmd .ps1 .psm1 .vbs .vbe .js .jse .wsf .wsh .msi .msc .scr .lnk .url .hta .cpl'.split(' '));
const allowedProtocols = new Set(['http:', 'https:', 'mailto:']);

/** The sole OS-association boundary. User-selected handlers may show their UI. */
export function createOsShell(shell, env = process.env) {
  return Object.freeze({
    async openExternal(url) {
      let parsed;
      try { parsed = new URL(url); } catch { /* same plain refusal as a disallowed scheme */ }
      if (!parsed || !allowedProtocols.has(parsed.protocol)) throw new Error('Only http, https and mailto links can be opened.');
      return shell.openExternal(parsed.href);
    },
    async openPath(file) {
      // Windows ignores trailing spaces/dots and permits alternate data streams.
      const leaf = win32.basename(file).split(':')[0].replace(/[ .]+$/, '');
      const dot = leaf.lastIndexOf('.');
      const extension = dot < 0 ? '' : leaf.slice(dot).toLowerCase();
      const pathExt = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATHEXT')?.[1] ?? '';
      const extra = pathExt.split(';').map(value => value.trim().toLowerCase()).filter(Boolean);
      if (refusedExtensions.has(extension) || extra.includes(extension)) return 'Murage cannot open programs or scripts. Download the file instead.';
      return shell.openPath(file);
    },
    showItemInFolder(file) { return shell.showItemInFolder(file); },
  });
}
