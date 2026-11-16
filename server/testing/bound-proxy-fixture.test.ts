// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { once } from "node:events";
import { expect, it } from "vitest";
import { terminalProxyRefusal } from "../proxy-turn-release.ts";
import { boundProxyState, boundProxyTerminal, spawnBoundProxy } from "./bound-proxy-fixture.ts";
import { fixtureStdioRpc } from "./stdio-rpc.ts";

it.each(["instance", "code"] as const)("rejects a supervisor terminal with the wrong %s", async fault => {
  const frame = terminalProxyRefusal(null);
  const source = `const frame = ${JSON.stringify(frame)};
    if (${JSON.stringify(fault)} === "code") frame.error.code = -32000;
    process.send({ type: "turn-release-terminal", instanceId: ${JSON.stringify(fault)} === "instance" ? "unrelated-fixture" : process.env.MURAGE_RELEASE_INSTANCE, frame });
    setInterval(() => {}, 1000);`;
  const child = await spawnBoundProxy("computer", process.execPath, ["-e", source]);
  await once(child, "close");
  expect(boundProxyState(child)).toEqual({ sealed: true, refusals: 1 });
  expect(boundProxyTerminal(child)).toBeUndefined();
});

it("ends a pending fixture RPC when its real child exits without a reply", async () => {
  const child = await spawnBoundProxy("connectors", process.execPath,
    ["-e", "process.stdin.once('data', () => process.exit(0));"]);
  const exited = once(child, "exit");
  const rpc = fixtureStdioRpc(child);
  try {
    await expect(rpc.request(1, "initialize", {}, 5000)).rejects.toThrow("fixture RPC transport ended");
    await exited;
    expect(child.exitCode).toBe(0);
  } finally { rpc.close(); child.kill(); }
});
