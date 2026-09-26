import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { portAvailable } from "./port-availability.mjs";

test("a port another program holds reads as unavailable, a free one as available", async () => {
  const holder = net.createServer();
  await new Promise(resolve => holder.listen(0, "127.0.0.1", resolve));
  const { port } = holder.address();
  try { assert.equal(await portAvailable(port), false); }
  finally { await new Promise(resolve => holder.close(resolve)); }
  assert.equal(await portAvailable(port), true);
});
