// The state that killed the owner's server: a socket torn down while its
// handshake is still in flight. Nothing here is mocked — it is a real `ws`
// client pointed at a port that refuses, which is the same "closed before the
// connection was established" the crash log recorded.
//
// WITHOUT the fix this file does not fail with an assertion, it takes the
// vitest worker down with it, which is precisely what it did to the server.
import { it, expect } from "vitest";
import WebSocket from "ws";

import { closeSocketQuietly } from "./browser-socket-teardown.ts";

/** Long enough for the terminate to land on a later tick, where it throws. */
const AFTER_THE_NEXT_TICK = 120;

it("tearing down a socket that never finished connecting does not end the process", async () => {
  // Port 1 is reserved and refuses immediately, so this socket can never open.
  const socket = new WebSocket("ws://127.0.0.1:1/never-opens");
  expect(socket.readyState).toBe(WebSocket.CONNECTING);

  closeSocketQuietly(socket);

  // The unhandled `'error'` the old teardown produced arrives here, not above.
  await new Promise((resolve) => setTimeout(resolve, AFTER_THE_NEXT_TICK));
  expect(socket.readyState).toBe(WebSocket.CLOSED);
});

it("is safe to call twice, and on nothing at all", async () => {
  const socket = new WebSocket("ws://127.0.0.1:1/never-opens");
  closeSocketQuietly(socket);
  closeSocketQuietly(socket);
  closeSocketQuietly(undefined);
  closeSocketQuietly(null);
  await new Promise((resolve) => setTimeout(resolve, AFTER_THE_NEXT_TICK));
  expect(socket.readyState).toBe(WebSocket.CLOSED);
});

it("leaves no listener that could keep the socket alive, except the ear for errors", async () => {
  const socket = new WebSocket("ws://127.0.0.1:1/never-opens");
  socket.on("message", () => {});
  socket.on("close", () => {});
  closeSocketQuietly(socket);
  expect(socket.listenerCount("message")).toBe(0);
  expect(socket.listenerCount("close")).toBe(0);
  // The one that must survive: without it the process dies on the next tick.
  expect(socket.listenerCount("error")).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, AFTER_THE_NEXT_TICK));
});
