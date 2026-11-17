// RPC tests owner: win-sac-sign; Windows pipe/token and patched-worker witness owner: MAIN.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { windowsSigningBoundary } from "./windows-signing-boundary.mjs";
import { signingDigest } from "./windows-signing-authority.mjs";
const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
export async function boundaryFixture(change = value => value) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boundary-rpc-")), address = path.join(root, "pipe");
  const messages = [], sockets = new Set();
  const result = { exitCode: 0, receiptSha256: signingDigest("receipt") };
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", data => {
      input += data;
      let end;
      while ((end = input.indexOf("\n")) !== -1) {
        const message = JSON.parse(input.slice(0, end)); input = input.slice(end + 1); messages.push(message);
        const response = change({ id: message.id, ok: true,
          result: message.operation === "seal" ? { measurementId: signingDigest("measurement") } : result }, socket);
        if (response !== undefined) socket.write(typeof response === "string" ? response : `${JSON.stringify(response)}\n`);
      }
    });
  });
  await new Promise(resolve => server.listen(address, resolve));
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
  });
  const open = vi.fn(requested => { expect(requested).toBe("\\\\.\\pipe\\MurageSigningBoundary"); return net.connect(address); });
  const args = { lease: signingDigest("lease"), launchSha256: signingDigest("launch"), runAuthorizationSha256: signingDigest("run") };
  const boundary = windowsSigningBoundary({ ...args, platform: "win32", open }); cleanup.push(() => boundary.close());
  return { boundary, args, messages, result, open };
}
it("uses the fixed pipe, seals once, and gets only completion metadata from service-owned launch", async () => {
  const f = await boundaryFixture(); await f.boundary.assertIsolatedAndSealed();
  await expect(f.boundary.release()).resolves.toEqual(f.result);
  expect(f.messages).toEqual([
    { id: expect.stringMatching(/^[a-f0-9]{32}$/), operation: "seal", ...f.args },
    { id: expect.stringMatching(/^[a-f0-9]{32}$/), operation: "release", lease: f.args.lease, measurementId: signingDigest("measurement") },
  ]);
  expect(f.open).toHaveBeenCalledOnce();
  await expect(f.boundary.release()).rejects.toThrow();
  await expect(f.boundary.assertIsolatedAndSealed()).rejects.toThrow(); expect(f.messages).toHaveLength(2);
});
it("refuses release before seal, duplicate seal and simultaneous seal without sending an unauthorized request", async () => {
  const f = await boundaryFixture(); await expect(f.boundary.release()).rejects.toThrow();
  const sealing = f.boundary.assertIsolatedAndSealed();
  await expect(f.boundary.assertIsolatedAndSealed()).rejects.toThrow(); await sealing;
  await expect(f.boundary.assertIsolatedAndSealed()).rejects.toThrow(); expect(f.messages).toHaveLength(1);
});
export const boundaryViolations = [
  ["id", value => ({ ...value, id: "wrong" })],
  ["failed", value => ({ ...value, ok: false })],
  ["unknown field", value => ({ ...value, credentials: "fixture" })],
  ["malformed", () => "not json\n"],
  ["oversize", () => "x".repeat(4097)],
  ["multiple frames", value => `${JSON.stringify(value)}\n${JSON.stringify(value)}\n`],
  ["no measurement", value => ({ ...value, result: {} })],
  ["secret in seal", value => ({ ...value, result: { measurementId: signingDigest("measurement"), AZURE_CLIENT_SECRET: "fixture" } })],
  ["disconnect", (_value, socket) => { socket.destroy(); }],
];
it.each(boundaryViolations)("refuses pipe %s and revokes the connection", async (_name, mutate) => {
  const f = await boundaryFixture(mutate);
  await expect(f.boundary.assertIsolatedAndSealed()).rejects.toThrow("WINDOWS_SIGNING_BOUNDARY_REJECTED");
  await expect(f.boundary.release()).rejects.toThrow(); expect(f.messages).toHaveLength(1);
});
it.each([
  { exitCode: 0, receiptSha256: signingDigest("receipt"), AZURE_CLIENT_SECRET: "fixture" },
  { exitCode: 1, receiptSha256: signingDigest("receipt") },
  { exitCode: 0, receiptSha256: "missing" },
])("rejects invalid or secret-bearing release reply %j", async result => {
  const f = await boundaryFixture(value => value.result.measurementId ? value : { ...value, result });
  await f.boundary.assertIsolatedAndSealed();
  await expect(f.boundary.release()).rejects.toThrow("WINDOWS_SIGNING_BOUNDARY_REJECTED");
  await expect(f.boundary.release()).rejects.toThrow(); expect(f.messages).toHaveLength(2);
});
it("refuses missing lease and unsupported platform before connecting", () => {
  const open = vi.fn(); expect(() => windowsSigningBoundary({ platform: "win32", open })).toThrow();
  expect(() => windowsSigningBoundary({ platform: "linux", open, lease: signingDigest("lease"), launchSha256: signingDigest("launch"), runAuthorizationSha256: signingDigest("run") })).toThrow();
  expect(open).not.toHaveBeenCalled();
});
