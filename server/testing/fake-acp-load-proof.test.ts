import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["release", "timeout"])("runs the real ACP load-proof stdio fixture with bounded %s", async scenario => {
  const root = mkdtempSync(join(tmpdir(), "murage-load-proof-fixture-"));
  const gate = join(root, "gate"), image = join(root, "fixture.png");
  const pixels = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  writeFileSync(image, pixels);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fake-acp-cli.ts", import.meta.url))], {
    env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), FAKE_ACP_MODE: "load-proof", FAKE_LOAD_GATE: gate, FAKE_LOAD_IMAGE: image, FAKE_LOAD_TIMEOUT_MS: scenario === "timeout" ? "150" : "3000" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const frames: any[] = [];
  let pending = "", stderr = "";
  child.stdout.on("data", chunk => {
    pending += chunk;
    for (;;) { const end = pending.indexOf("\n"); if (end < 0) break; frames.push(JSON.parse(pending.slice(0, end))); pending = pending.slice(end + 1); }
  });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const send = (id: number, method: string, params: unknown) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  try {
    send(1, "initialize", { protocolVersion: 1 });
    await expect.poll(() => frames.find(frame => frame.id === 1), { timeout: 2000 }).toBeTruthy();
    send(2, "session/new", { cwd: root, mcpServers: [] });
    await expect.poll(() => frames.find(frame => frame.id === 2), { timeout: 2000 }).toBeTruthy();
    const sessionId = frames.find(frame => frame.id === 2).result.sessionId;
    send(3, "session/prompt", { sessionId, prompt: [{ type: "text", text: "fixture only" }] });
    await expect.poll(() => frames.some(frame => frame.params?.update?.content?.text === "LOAD_PROOF_READY"), { timeout: 2000 }).toBe(true);
    expect(frames.some(frame => frame.id === 3)).toBe(false);
    if (scenario === "release") writeFileSync(gate, "release");
    await expect.poll(() => frames.find(frame => frame.id === 3), { timeout: 4000 }).toBeTruthy();
    const result = frames.find(frame => frame.id === 3);
    if (scenario === "timeout") expect(result.error.message).toBe("fake acp load-proof failed (GATE_TIMEOUT)");
    else {
      expect(result.result.stopReason).toBe("end_turn");
      const updates = frames.filter(frame => frame.method === "session/update");
      expect(updates.every(frame => frame.params.sessionId === sessionId)).toBe(true);
      const text = updates.filter(frame => frame.params.update.content.type === "text");
      expect(text).toHaveLength(65);
      expect(text.slice(1).every(frame => frame.params.update.content.text === "L".repeat(1024))).toBe(true);
      const images = updates.filter(frame => frame.params.update.content.type === "image");
      expect(images).toHaveLength(3);
      expect(images.every(frame => frame.params.update.content.mimeType === "image/png" && Buffer.from(frame.params.update.content.data, "base64").equals(pixels))).toBe(true);
    }
    expect(stderr).toBe("");
  } finally {
    const exited = once(child, "exit"); child.kill(); await exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
