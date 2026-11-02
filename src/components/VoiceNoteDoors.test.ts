// 1.0.14: a bot's voice note plays on every door, not only the desktop.
//
// The phone, the browser door and the phone app (a shell over the browser
// door's page) cannot reach Files, so a saved-file card there stays off. A
// voice note is asked for on the conversation's own route instead
// (shared/voice-note-audio.ts), fetched once, and played from a blob. The
// renderer suite runs in node with no DOM: this pins the fetch rule, the
// player's first paint in each state, and the wiring each door depends on.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { fetchRemoteVoiceNote, remoteVoiceNoteVerdict } from "@/lib/voice-note-audio";
import { filesRefused, RemoteVoiceNoteBubble, VoiceNotePlayer, voiceNoteDownloadName } from "./ArtifactCards";
import { VOICE_NOTE_AUDIO_MAX_BYTES } from "../../shared/voice-note-audio";

const cards = readFileSync(fileURLToPath(new URL("./ArtifactCards.tsx", import.meta.url)), "utf8");
const chat = readFileSync(fileURLToPath(new URL("./ChatView.tsx", import.meta.url)), "utf8");
const browserDoor = readFileSync(fileURLToPath(new URL("../../companion/src/browser.ts", import.meta.url)), "utf8");
const cloudPolicy = readFileSync(fileURLToPath(new URL("../../server/cloud-home/b1b-policy.ts", import.meta.url)), "utf8");

type Call = { url: string; init: RequestInit };
const fake = (response: Response, calls: Call[] = []) =>
  (async (url: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(url), init: init ?? {} }); return response; }) as typeof fetch;

describe("asking a door for a voice note", () => {
  it("plays only a 200 in one of the voice note audio types", () => {
    expect(remoteVoiceNoteVerdict(200, "audio/mpeg")).toBe("read");
    expect(remoteVoiceNoteVerdict(200, "audio/wav; charset=binary")).toBe("read");
    expect(remoteVoiceNoteVerdict(200, "AUDIO/OGG")).toBe("read");
    expect(remoteVoiceNoteVerdict(200, "text/html")).toBe("none");
    expect(remoteVoiceNoteVerdict(200, "application/json")).toBe("none");
    expect(remoteVoiceNoteVerdict(200, "audio/x-unknown")).toBe("none");
    expect(remoteVoiceNoteVerdict(200, null)).toBe("none");
    expect(remoteVoiceNoteVerdict(404, "application/json")).toBe("none");
    expect(remoteVoiceNoteVerdict(401, "application/json")).toBe("none");
    expect(remoteVoiceNoteVerdict(409, "application/json")).toBe("unavailable");
    expect(remoteVoiceNoteVerdict(410, "application/json")).toBe("unavailable");
  });

  it("fetches the conversation's own route, same origin, uncached, never following a redirect", async () => {
    const calls: Call[] = [];
    const answer = await fetchRemoteVoiceNote("task-7", "m-3", undefined, fake(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } }), calls));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/threads/task-7/messages/m-3/voice-note");
    expect(calls[0]!.init).toMatchObject({ redirect: "error", cache: "no-store", credentials: "same-origin" });
    expect(answer.status).toBe("audio");
    if (answer.status !== "audio") return;
    expect(answer.blob.type).toBe("audio/mpeg");
    expect(answer.blob.size).toBe(3);
  });

  it("another saved file, a refusal or a page in place of audio draws no player", async () => {
    const json = { "content-type": "application/json" };
    expect(await fetchRemoteVoiceNote("t", "m", undefined, fake(new Response("{}", { status: 404, headers: json })))).toEqual({ status: "none" });
    expect(await fetchRemoteVoiceNote("t", "m", undefined, fake(new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })))).toEqual({ status: "none" });
    expect(await fetchRemoteVoiceNote("t", "m", undefined, fake(new Response(new Uint8Array(), { status: 200, headers: { "content-type": "audio/mpeg" } })))).toEqual({ status: "none" });
    expect(await fetchRemoteVoiceNote("t", "m", undefined, fake(new Response("{}", { status: 410, headers: json })))).toEqual({ status: "unavailable" });
  });

  it("refuses a body larger than a voice note before reading it", async () => {
    let read = false;
    const response = new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "audio/mpeg", "content-length": String(VOICE_NOTE_AUDIO_MAX_BYTES + 1) } });
    response.blob = async () => { read = true; return new Blob([]); };
    expect(await fetchRemoteVoiceNote("t", "m", undefined, fake(response))).toEqual({ status: "none" });
    expect(read).toBe(false);
  });
});

describe("the voice note player", () => {
  it("with audio: a play button, the audio and a Download that is the door's own save", () => {
    const html = renderToStaticMarkup(createElement(VoiceNotePlayer, { id: "m-3", url: "blob:https://door/abc", busy: false, onDownload: () => {} }));
    expect(html).toContain('data-voice-note="m-3"');
    expect(html).toContain('<audio src="blob:https://door/abc" preload="metadata"');
    expect(html).toMatch(/<button type="button" aria-label="[^"]+" class="[^"]*"><svg/);
    expect(html).not.toMatch(/<button type="button" disabled=""/);
    expect(html).toMatch(/<button type="button" class="[^"]*"><svg[^]*?<\/svg>Download<\/button>/);
    expect(html).not.toContain("href=");
    expect(html).not.toContain("download=");
    expect(html).not.toContain("Show in folder");
  });

  it("never points a download link at its audio URL, even a harness one with no save handed in", () => {
    // 1.0.14 cut: an <a href={url} download> fallback had no desktop proof, and
    // a browser-loaded /api URL without a ticket is answered 404 on the desktop.
    const html = renderToStaticMarkup(createElement(VoiceNotePlayer, { id: "a-1", url: "/api/media/bytes/a-1?cap=x", busy: false }));
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("download=");
    const player = cards.slice(cards.indexOf("export function VoiceNotePlayer"), cards.indexOf("/** The desktop's voice note"));
    expect(player).not.toMatch(/<a\b|\bdownload=|href=/);
  });

  it("unavailable: no audio, play is off and the length reads as a dash", () => {
    const html = renderToStaticMarkup(createElement(VoiceNotePlayer, { id: "m-3", url: null, unavailable: true, busy: false }));
    expect(html).not.toContain("<audio");
    expect(html).toContain('disabled=""');
    expect(html).toContain(">–</span>");
    expect(html).not.toContain("download=");
  });

  it("on another door nothing is drawn until the harness says the message holds a voice note", () => {
    expect(renderToStaticMarkup(createElement(RemoteVoiceNoteBubble, { threadId: "t", messageId: "m" }))).toBe("");
  });

  it("names a download by its audio type", () => {
    expect(voiceNoteDownloadName("audio/mpeg")).toBe("voice-note.mp3");
    expect(voiceNoteDownloadName("audio/wav")).toBe("voice-note.wav");
    expect(voiceNoteDownloadName("audio/ogg")).toBe("voice-note.ogg");
    expect(voiceNoteDownloadName("")).toBe("voice-note.mp3");
  });
});

describe("wiring on each door", () => {
  it("the desktop keeps its saved-file cards and its resolver-backed voice note", () => {
    expect(cards).toContain("if (desktop !== true || !key) return;");
    expect(cards).toContain('artifact.producer === "voice-note" && artifact.savedState === "available"');
    expect(cards).toContain("void resolveArtifactMedia(artifact.id, controller.signal)");
  });

  it("another door asks for the voice note only, never Files, and draws nothing while the door is unknown", () => {
    expect(cards).toContain("if (desktop === false || refused) return voiceNote && key ? <div className=\"mt-3 space-y-2\"><RemoteVoiceNoteBubble threadId={voiceNote.threadId} messageId={voiceNote.messageId} /></div> : null;");
    const remote = cards.slice(cards.indexOf("export function RemoteVoiceNoteBubble"), cards.indexOf("/** IDs are supplied only by the server"));
    expect(remote).toContain("fetchRemoteVoiceNote(threadId, messageId, controller.signal)");
    expect(remote).toContain("URL.revokeObjectURL(made)");
    expect(remote).not.toMatch(/\/api\/artifacts|\/api\/media|resolveArtifactMedia/);
  });

  it("another door saves the bytes it already fetched through the one save door, never a link", () => {
    const remote = cards.slice(cards.indexOf("export function RemoteVoiceNoteBubble"), cards.indexOf("/** IDs are supplied only by the server"));
    expect(remote).toContain("saveBlob(held, voiceNoteDownloadName(held.type)).catch(reportSaveFailure)");
    expect(remote).toContain("onDownload={onDownload}");
  });

  it("the desktop voice note downloads through the proved saved-file route", () => {
    expect(cards).toMatch(/<VoiceNoteBubble key=\{artifact\.id\} artifact=\{artifact\} busy=\{busy\}\s+onDownload=\{\(\) => \{ void action\(\(\) => downloadSavedArtifact\(artifact\)\); \}\}/);
    // onDownload is required on the desktop wrapper, so the desktop always has it.
    expect(cards).toContain("artifact: Artifact; busy: boolean; onDownload: () => void; onReveal?: () => void;");
  });

  it("the chat hands a bot row's thread and message to the cards, the way the paged screen frame does", () => {
    expect(chat).toContain('<ArtifactCards ids={message.artifactIds} voiceNote={message.role === "bot" ? { threadId: bot.threadId, messageId: message.id } : undefined} />');
    expect(chat).toContain("<PagedScreenFrame threadId={bot.threadId} messageId={m.id} />");
  });

  it("both remote pages may play audio from a blob the page made", () => {
    expect(browserDoor).toContain("\"media-src 'self' data: blob:\"");
    expect(cloudPolicy).toContain("media-src 'self' blob:");
  });
});

describe("a door that reads settings as the desktop but may not open Files", () => {
  // Astra r1 High: a Cloud remembered-owner or chat-only browser is told
  // "desktop" by /api/config (a settings read), then Files answers 403.
  it("a 403 from Files plays the voice note from the conversation instead of showing a refusal", () => {
    expect(filesRefused(Object.assign(new Error("Pair this device"), { status: 403 }))).toBe(true);
    expect(cards).toContain("if (filesRefused(reason)) { setRefused(true); return; }");
  });
  it("a 404 (one file gone on the desktop) or a network failure stays an error", () => {
    expect(filesRefused(Object.assign(new Error("This saved file is unavailable."), { status: 404 }))).toBe(false);
    expect(filesRefused(new Error("offline"))).toBe(false);
    expect(filesRefused(null)).toBe(false);
  });
});
