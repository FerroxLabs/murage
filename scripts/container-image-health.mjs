// SPDX-License-Identifier: AGPL-3.0-or-later
// No response body is printed: the server's health details stay on loopback.
try {
  const port = process.env.MURAGE_PORT || "8799";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw Error();
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000), redirect: "error" });
  const body = response.ok ? await response.json() : null;
  if (body?.app !== "murage" || !Number.isSafeInteger(body.pid) || body.pid <= 0 || body.static !== true) throw Error();
} catch { process.exitCode = 1; }
