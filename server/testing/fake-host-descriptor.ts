// A fake "this computer" driver descriptor for harness fixtures, written the
// way the real app publishes it on each platform, so the harness's own
// readCuaConnection (server/local-computer.ts) mounts it through the real
// path rather than a test-only one.
//
//   darwin: the legacy descriptor (mcpCommand/mcpArgs/mcpEnv), as Electron's
//           macOS cua-driver connection writes it.
//   linux:  the supervised descriptor Electron's electron/cua-linux.cjs
//           publishes, passing the full runtime validation: a private
//           descriptor, an executable driver with its recorded file identity,
//           a live private daemon socket and live owner/daemon processes. That
//           descriptor's MCP env is an exact key set, so the fixture's own
//           variables are baked into the driver script instead.
//   win32:  never mounts this computer; the legacy descriptor is written and
//           ignored, as it would be for a real Windows owner.
//
// The returned source runs inside the harness child's instrumentation, before
// server/index.ts loads. It needs `fs`, `path` and `dataDir` (the realpath of
// the fixture's throwaway data dir) in scope, and top-level await. Everything
// it writes stays under that data dir.
export function fakeHostDescriptorSource({ driverSource, driverEnv }: {
  /** ESM source of the fake MCP driver; it reads its settings from process.env. */
  driverSource: string;
  /** Settings the driver reads. Values may be JS expressions over `dataDir`/`path`. */
  driverEnv: Record<string, string>;
}): string {
  const envObject = `{ ${Object.entries(driverEnv).map(([key, expression]) => `${JSON.stringify(key)}: ${expression}`).join(", ")} }`;
  return `
{
  const net = await import('node:net');
  const { randomUUID } = await import('node:crypto');
  const driverEnv = ${envObject};
  const driverSource = ${JSON.stringify(driverSource)};
  if (process.platform === 'linux') {
    const driverDir = path.join(dataDir, 'fake-cua-driver');
    // The fixture re-runs this on every restart, so it must find its own
    // earlier files and replace them, as Electron republishes on relaunch.
    fs.mkdirSync(driverDir, { recursive: true, mode: 0o700 });
    const driver = path.join(driverDir, 'fake-host-driver.mjs');
    fs.writeFileSync(driver, '#!' + process.execPath + String.fromCharCode(10)
      + 'Object.assign(process.env, ' + JSON.stringify(driverEnv) + ');' + String.fromCharCode(10) + driverSource);
    fs.chmodSync(driver, 0o755);
    const socketDir = path.join(dataDir, 'cua');
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(socketDir, 0o700);
    const socketPath = path.join(socketDir, 'd.sock');
    // The previous process's socket file outlives it.
    fs.rmSync(socketPath, { force: true });
    const daemon = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => { daemon.once('error', reject); daemon.listen(socketPath, resolve); });
    daemon.unref();
    fs.chmodSync(socketPath, 0o600);
    const stat = fs.statSync(driver, { bigint: true });
    const fileIdentity = Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(stat[key])]));
    fs.writeFileSync(path.join(dataDir, 'cua-connection.json'), JSON.stringify({
      schemaVersion: 1, mode: 'linux-x11-supervised', platform: 'linux', session: 'x11', enabled: true, status: 'ready',
      ownerPid: process.pid, generation: randomUUID(),
      driver: { path: driver, version: '0.19.3', source: 'path', manifestSchema: '1', fileIdentity },
      daemon: { socketPath, pid: process.pid, contractVersion: '0.6.0', toolsListSchemaVersion: '1', capabilityVersion: '1', mcpProtocolVersion: '2025-06-18' },
      mcp: { command: driver, args: ['mcp', '--embedded', '--socket', socketPath], env: { CUA_DRIVER_EMBEDDED: '1', CUA_DRIVER_HOST_BUNDLE_ID: 'com.murage.app', CUA_DRIVER_RS_UPDATE_CHECK: 'false', CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false' } },
      toolNames: ['click', 'get_window_state', 'list_apps', 'type_text'], doctorWarnings: [],
    }), { mode: 0o600 });
  } else {
    const driver = path.join(dataDir, 'fake-host-driver.mjs');
    fs.writeFileSync(driver, driverSource);
    fs.writeFileSync(path.join(dataDir, 'cua-connection.json'), JSON.stringify({ mcpCommand: process.execPath, mcpArgs: [driver], mcpEnv: driverEnv }));
  }
}
`;
}
