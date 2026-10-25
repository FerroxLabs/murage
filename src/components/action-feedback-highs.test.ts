// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// One test group per High row of the 1.0.3 action-feedback audit. The renderer
// suite runs in node, so a fix is proved by running its logic where it has
// any (the pure helpers, the markup of the small components) and by reading
// the wiring where it has not.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { closePhonePairingOutcome, closePhonePairingIfOwned } from "@/lib/phone-setup";
import { DISMISS_FAILED } from "@/lib/announcements";
import { saveHelloAnswer, SIGNUP_FAILED_NOTE, type HelloAnswerDeps } from "./FirstRunHelloCard";
import { DeletionNoteBanner } from "./DeletionNoteBanner";
import { MEDIA_SAVE_FAILED, MEDIA_SAVE_WORKING, MediaUnplayableCard } from "./MediaPlayer";
import { markFailureFor, markVisibly, outcomeSheetActions, setMarkFailure } from "./OutcomeMark";
import { withModelAnswer } from "./MemorySettings";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const noSwallow = (source: string) => {
  expect(source).not.toMatch(/\.catch\(\s*\(\s*\)\s*=>\s*(?:\{\s*\}|undefined)\s*\)/);
};

describe("High: Memory, Download local model", () => {
  const source = read("./MemorySettings.tsx");
  it("applies the 'downloading' answer so the poll starts", () => {
    expect(source).toMatch(/changesStatus = new Set\([^)]*"model-download"/);
    const status = { mode: "active", model: { state: "missing", bytesDownloaded: 0, totalBytes: 0 } } as never;
    const next = withModelAnswer(status, { state: "downloading", bytesDownloaded: 0, totalBytes: 100 });
    expect((next as { model: { state: string } }).model.state).toBe("downloading");
    expect((next as { mode: string }).mode).toBe("active");
    expect(withModelAnswer(null, { state: "downloading" })).toBeNull();
    expect(withModelAnswer(status, undefined)).toBeNull();
    // the poll that was never starting keys off this state
    expect(source).toContain('status?.model.state !== "downloading"');
  });
  it("shows pending, progress and done next to the button, inside the Search model section, and opens it", () => {
    expect(source).toContain("<ActionButton action={download}");
    expect(source).toContain('pending: t("memorySettings.download.starting")');
    expect(source).toContain('data-testid="memory-model-progress"');
    expect(source).toContain("memorySettings.model.finished");
    // 1.0.3: the Search model card sits in Memory's Advanced (only where the model is not bundled), with no <details>
    expect(source).toContain('aria-label={t("memorySettings.model.title")}');
    // the busy flag is state, held by the shared action
    expect(source).toContain("const acting = doing.pending");
  });
  it("no longer sends the start through the section-top notice", () => {
    expect(source).not.toContain("Local model download requested");
  });
});

describe("High: Composer, Send while an intake question is open", () => {
  const source = read("./Composer.tsx");
  it("says so when the message could not be recorded as the answer, without calling the send failed", () => {
    noSwallow(source);
    expect(source).toContain("replyToIntake(bot.id, question.id, requestText, api, { alongside: true }).then(() => setIntakeNotice(null), () => setIntakeNotice(INTAKE_NOT_RECORDED))");
    expect(source).toContain('data-testid="intake-reply-notice"');
    expect(source).toMatch(/INTAKE_NOT_RECORDED = "Your message was sent\./);
  });
});

describe("High: Files, Open in app and Show in folder", () => {
  const source = read("./Files.tsx");
  it("runs the native action through act(), so it is busy, says what it did, and shows the error", () => {
    expect(source).toContain("const nativeAction = (artifact: Artifact, action: \"open\" | \"reveal\") => act(async () => {");
    expect(source).toContain("onNativeAction={onNativeAction ? nativeAction : undefined}");
    expect(source).not.toContain("void onNativeAction?.(");
  });
});

describe("High: Try again now in the deletion banner", () => {
  const note = { title: "Deleted. Murage will finish removing these when it can:", items: ["A copy."], retry: true };
  it("renders an idle, enabled retry with a place for the result", () => {
    const html = renderToStaticMarkup(createElement(DeletionNoteBanner, { note, onDismiss: () => {}, onRetry: async () => {} }));
    expect(html).toContain("Try again now");
    expect(html).toContain('aria-busy="false"');
    expect(html).toContain('aria-live="polite"');
  });
  it("both screens hand it a retry that can fail out loud", () => {
    for (const file of ["./ChatView.tsx", "./GroupView.tsx"]) {
      const source = read(file);
      noSwallow(source);
      expect(source, file).toContain('const response = await api("/api/deletions/retry", { method: "POST" });');
    }
    expect(read("./DeletionNoteBanner.tsx")).toContain('pending: "Trying again…"');
  });
});

describe("High: X on the connector card and the secret request card", () => {
  for (const file of ["./ConnectorCard.tsx", "./SecretRequestCard.tsx"]) {
    it(`${file} awaits the dismiss, disables while it runs, and shows the failure`, () => {
      const source = read(file);
      noSwallow(source);
      expect(source).toContain("useAction(async () => {");
      expect(source).toContain("/dismiss`");
      expect(source).toContain("disabled={dismissAction.pending}");
      expect(source).toContain("<ActionStatus action={dismissAction}");
    });
  }
});

describe("High: Continue on the hello card", () => {
  const deps = (subscribe: () => Promise<unknown>): HelloAnswerDeps => ({
    api: vi.fn(async (path: string) => (path === "/api/subscribe" ? subscribe() : { profile: { name: "Sean", email: "sean@example.com" } })),
    identify: vi.fn(), markGate: vi.fn(), answer: vi.fn(async () => {}), skip: vi.fn(async () => {}),
  });
  const typed = { name: "Sean", email: "sean@example.com" };
  it("does not hold the person up, and reports a refused signup", async () => {
    const out = await saveHelloAnswer(typed, deps(() => Promise.reject(new Error("down"))));
    expect(out.greeting).toContain("Sean");
    await expect(out.signup).resolves.toBe("failed");
  });
  it("reports a good signup and an email-less answer", async () => {
    await expect((await saveHelloAnswer(typed, deps(async () => ({})))).signup).resolves.toBe("ok");
    await expect((await saveHelloAnswer({ name: "Sean", email: "" }, deps(async () => ({})))).signup).resolves.toBe("none");
  });
  it("tells the person in plain words, without blocking entry", () => {
    expect(SIGNUP_FAILED_NOTE).toContain("could not add your email");
    const source = read("./FirstRunHelloCard.tsx");
    expect(source).toContain('data-testid="hello-signup-note"');
    noSwallow(source);
  });
});

describe("High: Save a copy on an expired media link", () => {
  it("says it is getting a fresh link, and shows the failure when the refresh returns nothing", () => {
    const asset = { id: "a", kind: "audio", name: "x.mp3", mime: "audio/mpeg", capabilities: { download: true } } as never;
    const working = renderToStaticMarkup(createElement(MediaUnplayableCard, { asset, url: "u", reason: "r", saveLine: { kind: "working", text: MEDIA_SAVE_WORKING } }));
    expect(working).toContain("Getting a fresh link…");
    const failed = renderToStaticMarkup(createElement(MediaUnplayableCard, { asset, url: "u", reason: "r", saveLine: { kind: "error", text: MEDIA_SAVE_FAILED } }));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Could not get a fresh link");
    expect(read("./MediaPlayer.tsx")).toContain('if (!next) { setSaveLine({ kind: "error", text: MEDIA_SAVE_FAILED }); return; }');
  });
});

describe("High: Mark outcome", () => {
  const reply = { id: "m1", role: "bot", kind: "text", text: "Here is the quote." };
  it("puts a refused mark where the person can see it, under the reply, and clears it on the next try", async () => {
    setMarkFailure("m1", null);
    const outcomes = { marks: new Map(), mark: vi.fn(async () => { throw new Error("The server said no."); }) };
    expect(await markVisibly(outcomes as never, "m1", "won")).toBe(false);
    expect(markFailureFor("m1")).toBe("The server said no.");
    outcomes.mark.mockResolvedValueOnce({} as never as never);
    expect(await markVisibly(outcomes as never, "m1", "won")).toBe(true);
    expect(markFailureFor("m1")).toBeUndefined();
  });
  it("the phone sheet's tap reports through the same place", async () => {
    setMarkFailure("m1", null);
    const outcomes = { marks: new Map(), proposal: undefined, mark: vi.fn(async () => { throw new Error("Not now."); }) };
    outcomeSheetActions(outcomes as never, { name: "Dax", title: "Sales" }, reply)[0]!.onSelect();
    await vi.waitFor(() => expect(markFailureFor("m1")).toBe("Not now."));
    setMarkFailure("m1", null);
  });
  it("the strip shows it as an alert", () => {
    const source = read("./OutcomeMark.tsx");
    noSwallow(source);
    expect(source).toContain('data-testid="outcome-mark-failed"');
  });
});

describe("High: sidebar section order", () => {
  it("says so when the order did not reach the computer", () => {
    const source = read("./Sidebar.tsx");
    expect(source).toContain("else setTeamFeedback({ error: true, text: SECTION_ORDER_NOT_SYNCED });");
    expect(source).toContain("Couldn't sync the order to your computer.");
  });
});

describe("High: Unsnooze", () => {
  it("shows pending, and a failure with Try again, instead of opening the snooze menu", () => {
    const source = read("./TaskPicker.tsx");
    expect(source).toContain("aria-busy={unsnoozing === task.threadId}");
    expect(source).toContain('data-testid="unsnooze-failed"');
    expect(source).not.toContain("catch(() => setSnoozing(task.threadId))");
  });
});

describe("High: voice list and team library search", () => {
  it("say the list could not load, with Try again", () => {
    const voice = read("./VoiceSettings.tsx");
    expect(voice).toContain("setVoicesFailed(true)");
    expect(voice).toContain('data-testid="voices-load-failed"');
    expect(voice).toContain("voiceReload");
  });
  it("say search is unavailable instead of silently showing everything", () => {
    const library = read("./TeamLibraryPanel.tsx");
    expect(library).toContain("setSearchUnavailable(true)");
    expect(library).toContain('data-testid="library-search-unavailable"');
    expect(library).toContain("Search is unavailable right now, so this shows all teams.");
  });
});

describe("High: Cancel on phone pairing", () => {
  const snapshot = { pairing: { token: "t1" } } as never;
  const same = async () => snapshot;
  it("tells a failed close from a code that was not ours", async () => {
    expect(await closePhonePairingOutcome(snapshot, same, async () => {}, () => true)).toBe("closed");
    expect(await closePhonePairingOutcome(snapshot, same, async () => { throw new Error("x"); }, () => true)).toBe("failed");
    expect(await closePhonePairingOutcome(snapshot, async () => { throw new Error("x"); }, async () => {}, () => true)).toBe("failed");
    expect(await closePhonePairingOutcome(snapshot, async () => ({ pairing: { token: "other" } }) as never, async () => {}, () => true)).toBe("not-owned");
    expect(await closePhonePairingOutcome(snapshot, same, async () => {}, () => false)).toBe("not-owned");
    expect(await closePhonePairingOutcome({} as never, same, async () => {}, () => true)).toBe("not-owned");
  });
  it("keeps the boolean helper as it was", async () => {
    expect(await closePhonePairingIfOwned(snapshot, same, async () => {}, () => true)).toBe(true);
    expect(await closePhonePairingIfOwned(snapshot, same, async () => { throw new Error("x"); }, () => true)).toBe(false);
  });
  it("both Cancel paths read the result and offer Retry", () => {
    const source = read("./PhoneSetupFlow.tsx");
    expect(source).not.toMatch(/void closePhonePairingIfOwned\(/);
    expect(source.match(/closeOwnedPairing\(/g)!.length).toBeGreaterThanOrEqual(3);
    expect(source).toContain("Retry closing the code");
    expect(source).toContain("The pairing code is still open.");
  });
});

describe("Medium rows folded into this lane", () => {
  it("a refused announcement dismiss brings the card back with a line", () => {
    expect(DISMISS_FAILED).toBe("Could not dismiss this. Try again.");
    const source = read("../lib/announcements.ts");
    expect(source).toContain("setDismissFailed(DISMISS_FAILED)");
    expect(source).not.toMatch(/dismiss"[^\n]*\.catch\(\(\) => \{\}\)/);
    expect(read("./Announcements.tsx")).toContain('data-testid="announcement-dismiss-failed"');
  });
  it("a refused channel edit puts the old value back", () => {
    const source = read("../state/store.tsx");
    expect(source).toContain('type: "groupPatchReverted"');
    expect(source).toContain('case "groupPatchReverted":');
    expect(source).toContain("const groupBeforePatch");
  });
});
