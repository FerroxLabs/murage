// SPDX-License-Identifier: AGPL-3.0-or-later
// L6: the Windows helper is built and run only by CI's Windows job, so this is a source-shape check. A client that
// exits right after connecting makes GetNamedPipeClientProcessId or OpenProcess fail; that must drop only that
// client (close its pipe instance, open a fresh one) and keep the acceptor running, never reach the acceptor's
// outer catch that stops the broker.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const source = readFileSync(new URL("../native/browser-extension/transport.cpp", import.meta.url), "utf8");
const acceptor = source.slice(source.indexOf("std::thread acceptor("), source.indexOf("try {for(;;){DWORD length=0;"));
describe("L6: the Windows acceptor survives a client that vanishes right after connecting", () => {
  it("checks the peer inside its own try block", () => {
    const peer = acceptor.indexOf("GetNamedPipeClientProcessId"), open = acceptor.indexOf("OpenProcess("), check = acceptor.indexOf("currentSid(process.value)==sid");
    expect(peer).toBeGreaterThan(0); expect(open).toBeGreaterThan(peer); expect(check).toBeGreaterThan(open);
    const tryAt = acceptor.lastIndexOf("try{", peer);
    const outer = acceptor.indexOf("try{DWORD next=1;");
    expect(tryAt).toBeGreaterThan(outer);
    const catchAt = acceptor.indexOf("catch(...)", check);
    expect(catchAt).toBeGreaterThan(check);
    // the per-client catch comes before the connection table is touched
    expect(catchAt).toBeLessThan(acceptor.indexOf("connections[c->id]=c"));
  });
  it("closes that pipe instance and keeps accepting on a failed peer check", () => {
    const check = acceptor.indexOf("currentSid(process.value)==sid");
    const catchAt = acceptor.indexOf("catch(...)", check);
    const handler = acceptor.slice(catchAt, acceptor.indexOf("auto c=std::make_shared<Connection>()"));
    expect(handler).toContain("DisconnectNamedPipe(pipe->value)");
    expect(handler).toContain("CreateNamedPipeW(");
    expect(handler).toContain("continue;");
    expect(handler).not.toContain("stopping=true");
  });
});
