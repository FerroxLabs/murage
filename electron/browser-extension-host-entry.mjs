// SPDX-License-Identifier: AGPL-3.0-or-later
// Executable entry only. Libraries must import browser-extension-host.mjs.
import { runNativeHost, readHostConfig, encodeFrame } from './browser-extension-host.mjs';
try { runNativeHost({ config: readHostConfig(process.argv[2]) }); }
catch { process.stdout.end(encodeFrame({ type: 'host.error', version: 1, error: { code: 'host_unavailable', message: 'Browser helper configuration or app connection is unavailable.' } })); }
