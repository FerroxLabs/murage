// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";

let fixture: VerificationServer;
let provider: Server;
let desktop: Record<string, string>;
let transcriptionRedirect: string | undefined;
const requests: Array<{ path: string; body: string; key?: string }> = [];
beforeAll(async () => {
  provider = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ path: req.url!, body: Buffer.concat(chunks).toString(), key: req.headers["xi-api-key"] as string | undefined });
    if (req.url === "/v1/speech-to-text" && transcriptionRedirect) { res.writeHead(307, { location: transcriptionRedirect }); return res.end(); }
    if (req.url!.startsWith("/v1/text-to-speech/")) { res.setHeader("content-type", "audio/mpeg"); return res.end(Buffer.from([1, 2, 3])); }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/v1/voices" ? { voices: [] } : { text: "สวัสดี", language_code: "tha" }));
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as { port: number }).port;
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `process.env.MURAGE_ELEVENLABS_API = "http://127.0.0.1:${port}/v1";` });
  const proof = await fetch(`${fixture.info.url}/api/desktop-secret`);
  expect(proof.status).toBe(200);
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await proof.json() as { secret: string }).secret };
}, 180_000);
afterAll(async () => { await fixture?.stop(); if (provider) await new Promise<void>(resolve => provider.close(() => resolve())); });
it("the isolated speech route rejects an unsupported language before requesting speech", async () => {
  const response = await fetch(`${fixture.info.url}/api/tts/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Hello", language: "xx" }) });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "unsupported language" });
});
it("the isolated speech route keeps the plain missing-key response", async () => {
  const response = await fetch(`${fixture.info.url}/api/tts/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "สวัสดี" }) });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: "Add an ElevenLabs key in Settings on the computer to turn on voice." });
});
it("the isolated app speaks Thai and listens after saving an own ElevenLabs key", async () => {
  const saved = await fetch(`${fixture.info.url}/api/config`, { method: "PATCH", headers: { "content-type": "application/json", ...desktop }, body: JSON.stringify({ tts: { provider: "elevenlabs", key: "fixture-voice", voice: "fixtureVoice" } }) });
  expect(saved.status).toBe(200);
  const configText = await (await fetch(`${fixture.info.url}/api/config`, { headers: desktop })).text();
  expect(configText).not.toContain("fixture-voice");
  expect(JSON.parse(configText).tts.routes.transcribe).toBe("elevenlabs");
  const speech = await fetch(`${fixture.info.url}/api/tts/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "สวัสดี" }) });
  expect(speech.status).toBe(200); expect(new Uint8Array(await speech.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  expect(JSON.parse(requests.find(request => request.path.startsWith("/v1/text-to-speech/"))!.body).model_id).toBe("eleven_v3");
  const transcript = await fetch(`${fixture.info.url}/api/voice/transcribe`, { method: "POST", headers: { "content-type": "audio/webm" }, body: new Uint8Array(1024) });
  expect(transcript.status).toBe(200); expect(await transcript.json()).toMatchObject({ text: "สวัสดี", language: "tha" });
  const upload = requests.find(request => request.path === "/v1/speech-to-text")!;
  expect(upload.key).toBe("fixture-voice"); expect(upload.body).toContain("scribe_v2"); expect(upload.body).toContain('filename="clip.webm"');
  console.log("isolated ElevenLabs fixture: key saved, Thai v3 audio received, Scribe transcript received, public config contains no key");
});
it("the isolated transcription route refuses to replay the owner's audio or key across a redirect", async () => {
  let received = 0;
  const recipient = createServer((_req, res) => { received++; res.end(); });
  await new Promise<void>(resolve => recipient.listen(0, "127.0.0.1", resolve));
  transcriptionRedirect = `http://127.0.0.1:${(recipient.address() as { port: number }).port}/redirected`;
  try {
    const response = await fetch(`${fixture.info.url}/api/voice/transcribe`, { method: "POST", headers: { "content-type": "audio/webm" }, body: new Uint8Array(1024) });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("fixture-voice");
    expect(received).toBe(0);
  } finally {
    transcriptionRedirect = undefined;
    await new Promise<void>(resolve => recipient.close(() => resolve()));
  }
});
