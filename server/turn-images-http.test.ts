import { expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";

it("binds an authenticated upload to the exact thread and persists its server metadata through a real send", async () => {
  const session = await launchVerificationServer();
  const env = { MURAGE_URL: session.info.url };
  try {
    const created = await runControlMurage(["new-bot", "--name", "Image Probe"], { env }) as { bot: { id: string; activeTaskId: string } };
    const threadId = created.bot.activeTaskId;
    expect(typeof threadId).toBe("string");
    expect(threadId.length).toBeGreaterThan(0);
    const { secret } = await (await fetch(`${session.info.url}/api/desktop-secret`)).json() as { secret: string };
    const headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, "content-type": "image/png" };
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64");
    const upload = (threadId: string, auth = true) => fetch(`${session.info.url}/api/attachments?threadId=${threadId}`, { method: "POST", headers: auth ? headers : { "content-type": "image/png" }, body: png });
    const denied = await upload(threadId, false); expect(denied.status).toBe(404); await denied.text();
    const missing = await upload("unknown"); expect(missing.status).toBe(404); await missing.text();
    const response = await upload(threadId); expect(response.status).toBe(201);
    const saved = await response.json() as { path: string; mime: string };
    await runControlMurage(["send", "--bot", created.bot.id, "--text", `<attached-image path="${saved.path}" />`], { env });
    await runControlMurage(["wait", "--bot", created.bot.id, "--timeout", "20"], { env });
    const read = await fetch(`${session.info.url}/api/threads/${threadId}/messages`, { headers });
    expect(read.status).toBe(200);
    const body = await read.json() as { messages: Array<{ role: string; attachments?: unknown[] }> };
    expect(body.messages.find(message => message.role === "user")?.attachments).toEqual([{ kind: "image", path: saved.path, mime: saved.mime }]);
  } finally { await session.close(); }
}, 30000);
