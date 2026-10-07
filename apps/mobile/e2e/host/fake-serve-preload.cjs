// E2E only: the door recognises only a :443 Serve front (Phase 0 surprise 6).
// The isolated door sits behind `tailscale serve --https=8444`, so this makes
// the door's read-only `serve status --json` report a :443 front pointing at
// our loopback door. Only that one argv is faked; nothing else is touched.
const cp = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const original = cp.execFile;
const HOST = process.env.E2E_TS_HOST;
const PORT = process.env.MURAGE_BROWSER_PORT;
cp.execFile = function (file, args, options, callback) {
  if (Array.isArray(args) && args.join(" ") === "serve status --json") {
    const out = JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${PORT}` } } } } });
    const done = typeof options === "function" ? options : callback;
    setImmediate(() => done(null, out, ""));
    return { pid: 0, kill() {} };
  }
  return original.apply(this, arguments);
};
syncBuiltinESMExports();
