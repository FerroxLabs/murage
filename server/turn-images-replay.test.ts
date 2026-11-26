// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { transcriptText } from "./replies.ts";
import { sourced } from "./testing/bot-row.ts";
import { buildTurnContext, fitRenderedReplay, renderDriverReplay, replayMetadata, transcriptForDriver } from "./turn-context.ts";
import type { Message } from "./store.ts";

const note = "[These images were attached to an earlier message. They do not show the current screen.]";
const oldImage = '<attached-image path="/fixture/attachments/earlier.png" />';
const liveImage = '<attached-image path="/fixture/attachments/current.png" />';
const history = () => sourced([{ id: "earlier", role: "user" as const, text: `Earlier screen\n${oldImage}` }]);
const flags = { fresh: true, rewound: false, externallyUpdated: false, replaysNatively: false };

describe("earlier images in a replay", () => {
  it("marks an earlier image in inline history while leaving the live image alone", () => {
    const transcript = history();
    const before = structuredClone(transcript);
    const result = buildTurnContext({ ...flags, transcript, text: liveImage });
    expect(result.turnText).toContain(`${note}\nEarlier screen\n${oldImage}`);
    expect(result.turnText.split("[Now reply to the user's latest message:]\n\n")[1]).toBe(liveImage);
    expect(result.turnText.split(note)).toHaveLength(2);
    expect(transcript).toEqual(before);
  });

  it("marks native transcript history and session recovery with the same note", () => {
    const transcript = history();
    const rows = transcriptForDriver(transcript);
    expect(rows[0]?.text).toBe(`${note}\nEarlier screen\n${oldImage}`);
    expect(renderDriverReplay(rows)).toContain(`${note}\nEarlier screen\n${oldImage}`);
    const current = buildTurnContext({ ...flags, replaysNatively: true, transcript, text: liveImage });
    expect(current.turnText.endsWith(liveImage)).toBe(true);
    expect(current.turnText).not.toContain(note);
  });

  it("leaves a live image unchanged on an empty or resumed turn", () => {
    expect(buildTurnContext({ ...flags, transcript: [], text: liveImage }).turnText).toBe(liveImage);
    expect(buildTurnContext({ ...flags, fresh: false, transcript: history(), text: liveImage }).turnText).toBe(liveImage);
  });

  it("adds one note for several images and none for text or file references", () => {
    const rows = transcriptForDriver(sourced([
      { role: "user" as const, text: `${oldImage}\n${liveImage}` },
      { role: "assistant" as const, text: 'A file: <attached-file path="/fixture/report.txt" />' },
      { role: "user" as const, text: "What changed?" },
    ]));
    expect(rows[0]?.text.split(note)).toHaveLength(2);
    expect(rows[1]?.text).toBe('A file: <attached-file path="/fixture/report.txt" />');
    expect(rows[2]?.text).toBe("What changed?");
  });

  it("keeps images left out of an earlier turn out of its replay", () => {
    const row = { id: "earlier", at: 1, role: "user", kind: "text", text: `Earlier screen\n${oldImage}`, imagesNotSent: ["/fixture/attachments/earlier.png"] } as Message;
    const text = transcriptText(row, new Map());
    const replayed = transcriptForDriver(sourced([{ role: "user" as const, text }]));
    expect(replayed[0]?.text).toBe(text);
    expect(replayed[0]?.text).not.toContain(note);
    expect(replayed[0]?.text).not.toContain(oldImage);
  });

  it("includes the note in the replay byte budget", () => {
    const transcript = history();
    // The row fits without the note, but is one byte too large with it.
    const budget = 256 + Buffer.byteLength(renderDriverReplay(transcript, replayMetadata()))
      + Buffer.byteLength("\n\n[Now reply to the user's latest message:]\n\n") + Buffer.byteLength(`${note}\n`) - 1;
    const fitted = fitRenderedReplay(transcript, undefined, 0, budget);
    expect(fitted).toEqual({ transcript: [], omitted: 1 });
    const result = buildTurnContext({ ...flags, transcript: fitted.transcript, omitted: fitted.omitted, text: "Next" });
    expect(result.turnText).not.toContain(oldImage);
    expect(Buffer.byteLength(result.turnText)).toBeLessThanOrEqual(budget);
  });
});
