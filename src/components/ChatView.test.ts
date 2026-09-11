// Every control the desktop hover rail offers is reachable from a phone.
//
// Source contracts, for the same reason TranscriptWidth.test.ts is: the
// renderer suite runs in node with no DOM, and the two transcripts are ~1,500
// lines each. What a person actually does — tap a bubble, hit a 44px row —
// is proved in a browser by src/e2e/message-actions.human.spec.ts. What this
// file pins is that the two transcripts still carry the wiring that spec
// depends on, and that the phone's action list is derived from the same
// predicates the hover rail is, rather than drifting away from it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

const chat = read("./ChatView.tsx");
const group = read("./GroupView.tsx");
const styles = read("../styles.css");
const views: Array<[string, string]> = [["ChatView", chat], ["GroupView", group]];

describe("the bubble is the trigger", () => {
  it.each(views)("%s opens the sheet from a tap on the bubble itself", (_name, source) => {
    // The trigger is the bubble because the bubble is the one thing already
    // in the row. Any NEW element would inherit the row's `gap-1.5` — 6px of
    // the width the `max-md:hidden` fix just bought back.
    expect(source).toMatch(/data-testid="msg-bubble"[\s\S]{0,400}?onClick=/);
    expect(source).toContain("bubbleTapOpensActions");
    expect(source).toContain("BUBBLE_INTERACTIVE");
  });

  it.each(views)("%s gates the whole thing on being below md", (_name, source) => {
    // `narrow` is read once per transcript (one matchMedia subscription, not
    // one per row) and threaded down. Above `md` the bubble is not focusable,
    // announces no popup, and its click handler returns early — desktop is
    // exactly what it was.
    expect(source).toContain("useNarrowViewport");
    expect(source).toContain("tabIndex={narrow ? 0 : undefined}");
    expect(source).toContain('aria-haspopup={narrow ? "dialog" : undefined}');
  });

  it.each(views)("%s answers a keyboard as well as a thumb", (_name, source) => {
    // A 44px target is no use to someone on a keyboard. Enter and Space open
    // the same sheet, and the bubble's focus ring comes from BUBBLE_TAPPABLE.
    expect(source).toMatch(/event\.key !== "Enter" && event\.key !== " "/);
    expect(source).toContain("BUBBLE_TAPPABLE");
  });

  it.each(views)("%s renders the sheet", (_name, source) => {
    expect(source).toContain("<MessageActionSheet");
  });
});

/** Just the sheet's action list, cut out of the file.
 *
 *  Scoped deliberately: "Reply", "Regenerate response" and the conditions
 *  that gate them all appear in the hover rail a few lines above, so a
 *  whole-file `toContain` would pass on the rail's copy and prove nothing
 *  about the sheet. Cutting the list out is what makes these assertions able
 *  to fail. */
function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + 1);
  expect([start, end].every((i) => i > 0)).toBe(true);
  return source.slice(start, end);
}
const chatSheet = slice(chat, "const actions: MessageAction[] =", "const openFromTap");
const groupSheet = slice(group, "const roomActions = (m: Message)", "  return (");

describe("the hover rail's controls, as words", () => {
  it("offers a 1:1 message everything its rail does", () => {
    // The rail: edit, copy, reply, pin on a user message; copy, speak,
    // regenerate, reply, pin on a bot one. Nothing on it may be desktop-only.
    for (const label of [
      "Copy message",
      "Reply",
      "Edit message",
      "Regenerate response",
      "Read aloud",
    ]) {
      expect(chatSheet).toContain(`"${label}"`);
    }
    expect(chatSheet).toMatch(/pinned \? "Unpin message" : "Pin message"/);
  });

  it("derives the sheet from the same conditions the rail is drawn from", () => {
    // Parity is only real if it cannot drift. Editing rewinds the thread, so
    // it waits for the turn to end; regenerate is offered on the last bot
    // message only. The sheet asks both questions the way the rail asks them.
    expect(chatSheet).toMatch(/message\.kind === "text" && !webhookView && !bot\.busy/);
    expect(chatSheet).toMatch(/isLastBotText && !bot\.busy && onRegenerate/);
  });

  it("keeps the speak control in the list when it is not ready, and says why", () => {
    // SpeakButton's own rule, quoted: "a hidden button is a feature nobody
    // discovers". On a phone that matters more, not less — there is no
    // tooltip to hover for the reason.
    expect(chatSheet).toContain("Add an ElevenLabs key to read messages aloud");
    expect(chatSheet).toContain("Pick a voice in this agent's profile to read aloud");
    expect(chatSheet).toContain("Stop speaking");
  });

  it("offers a channel message its rail's pair", () => {
    // GroupView's rail is Reply and Pin, so the channel sheet is Reply and
    // Pin. It carries no fourth control the desktop row does not have.
    expect(groupSheet).toContain('id: "reply"');
    expect(groupSheet).toContain('id: "pin"');
    expect(groupSheet).toMatch(/pinned \? "Unpin message" : "Pin message"/);
  });

  it("shows the timestamp the phone lost with the rail", () => {
    // `group-hover:opacity-100 max-md:hidden` — the hover-revealed time is
    // gone below md too. The sheet's heading is where it comes back.
    expect(chat).toMatch(/heading=\{`.*formatTime\(message\.at\)\}`\}/);
    expect(group).toMatch(/heading=\{`.*formatTime\(m\.at\)\}`\}/);
  });
});

describe("the sheet behaves like a dialog", () => {
  it("is modal, labelled, and portalled out of the transcript", () => {
    expect(chat).toContain("createPortal");
    expect(chat).toContain('aria-modal="true"');
    expect(chat).toContain('aria-label="Message actions"');
  });

  it("can be left by escape, by the ground, and by a control of its own", () => {
    // Three ways out, because the sheet covers the composer: a phone that
    // opened one by accident must never be stuck in it.
    expect(chat).toMatch(/event\.key === "Escape"/);
    expect(chat).toMatch(/SHEET_BACKDROP\}\s+onClick=\{onClose\}/);
    expect(chat).toMatch(/Close</);
  });

  it("moves focus in and gives it back", () => {
    expect(chat).toContain("previous?.focus()");
    expect(chat).toMatch(/event\.key !== "Tab"/);
  });
});

// F5-T2: every content image in both transcripts and Files enlarges through
// the one shared lightbox. The browser proof is
// src/e2e/media-lightbox.human.spec.ts; this pins that no surface drifted
// back to a bare <img> with its own (or no) dialog.
describe("one image surface", () => {
  const files = read("./Files.tsx");
  const markdown = read("./ChatMarkdown.tsx");
  const preview = read("./AttachmentPreview.tsx");

  it.each(views)("%s renders no content image of its own", (_name, source) => {
    expect(source).not.toMatch(/<img\b/);
    expect(source).toContain("<AttachedImageGallery");
    expect(source).toContain("<ChatMarkdown");
  });

  it("routes the bot's screen frame through the shared thumbnail", () => {
    expect(chat).toContain('import { ScreenFrameMedia } from "./ImageMedia"');
    expect(chat).toMatch(/function ScreenFrame\([^)]*\)\s*\{[\s\S]{0,400}<ScreenFrameMedia/);
    expect(chat).toContain("<ScreenFrame png={m.png} mime={m.mime} />");
  });

  it("routes Markdown images, attachment galleries and the Files preview the same way", () => {
    expect(markdown).toMatch(/img\(\{ src, alt \}[\s\S]{0,300}<MarkdownImage /);
    expect(markdown).not.toMatch(/<img\b/);
    expect(preview).toContain("<ImageGallery");
    expect(preview).toContain("<ImageLightbox");
    expect(preview).not.toMatch(/<img\b|createPortal/);
    expect(files).toContain('<ArtifactImageMedia artifact={preview.artifact} content={preview.content} />');
    expect(files).not.toMatch(/<img\b/);
  });
});

describe("motion is optional", () => {
  it("switches the sheet's animation off for a reader who asked", () => {
    const reduced = styles.slice(styles.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.msg-sheet,\s*\.msg-sheet-backdrop\s*\{\s*animation:\s*none;?\s*\}/);
  });
});

// U0-T1. The rendered behaviour — hit rectangles, name widths, menus and
// screenshots at 320/390/480/640/820/1024 in both skins — is proved in a
// browser by src/e2e/chat-header.human.spec.ts. These are the wiring
// contracts that spec depends on.
describe("the chat header answers to its container, not the window", () => {
  const header = read("./ChatHeader.tsx");
  const memoryLauncher = read("./MemoryLauncher.tsx");
  const layout = read("../lib/chat-header-layout.ts");

  it("is one measured component ChatView hands its state to", () => {
    expect(chat).toContain('import { ChatHeader } from "./ChatHeader"');
    expect(chat).toMatch(/<ChatHeader[\s\S]{0,200}findOpen=\{findOpen\}[\s\S]{0,120}onToggleFind=/);
    // The old inline header is gone, not merely bypassed.
    expect(chat).not.toContain("@container/chathead");
    expect(chat).not.toContain("<TaskPicker");
    expect(chat).not.toContain("<ModelPicker");
  });

  it("measures the chat container rather than the viewport", () => {
    // A `max-md:` breakpoint would miss the case this exists for: a 1600px
    // window with the sidebar and the computer panel open. The header
    // measures ITSELF (its own box is the chat column's width) and decides
    // from that, including whether the chips fold.
    expect(header).toContain("useChatHeaderLayout(headerRef, contentKey)");
    expect(header).toContain("data-chat-header-chips={layout.chips}");
    expect(layout).toContain("new ResizeObserver(read)");
    expect(layout).toContain("observer.observe(header)");
    expect(header).not.toMatch(/\bmax-md:/);
    expect(header).not.toContain("window.innerWidth");
    expect(header).not.toContain("@container");
    // What changes the chips' width without changing the header's box —
    // a task switch, a model change — restarts the ladder through the key.
    expect(header).toMatch(/const contentKey = \[[\s\S]*task\?\.title[\s\S]*bot\.modelSelection\.model[\s\S]*\]\.join/);
  });

  it("keeps identity, Stop, the task/model context and the call button at every width", () => {
    for (const fixed of ["<TaskPicker bot={bot} />", "<CallButton bot={bot} />", "<BotAvatar", "<RenameTitle"]) {
      expect(header).toContain(fixed);
    }
    // None of the four is wrapped in an `inHeader(...)` gate.
    expect(header).not.toMatch(/inHeader\("(task|model|call|name|stop)"\)/);
    expect(header).toMatch(/\{bot\.busy && \(\s*<button[\s\S]{0,400}chatHeader\.stop/);
  });

  it("relocates the rest into one menu instead of hiding it", () => {
    for (const slot of ["folder", "usage", "find", "computer", "inspector"]) {
      expect(header, `${slot} is not gated on the layout`).toContain(`inHeader("${slot}")`);
    }
    expect(header).toContain("<ChatHeaderMenu");
    // Every relocated slot that has an action supplies a menu item.
    for (const id of ["usage", "inspector", "computer", "find", "memory", "folder"]) {
      expect(header).toMatch(new RegExp(`id: "${id}"`));
    }
  });

  it("moves the memory trigger without unmounting the dialog", () => {
    // A resize must never discard a memory edit in progress, so the launcher
    // stays mounted and only `showTrigger` changes.
    expect(header).toMatch(/<MemoryLauncher[\s\S]{0,400}showTrigger=\{inHeader\("memory"\)\}/);
    expect(header).toMatch(/<MemoryLauncher[\s\S]{0,500}open=\{memoryOpen\}/);
    expect(memoryLauncher).toContain("showTrigger");
    expect(memoryLauncher).toContain("returnFocusRef");
  });

  it("moves the task/model pickers between rows by class, not by re-parenting", () => {
    // Re-parenting would remount them: an open dropdown would close and the
    // selected task could change on a resize.
    expect(header).toMatch(/data-chat-header-secondary[\s\S]{0,300}twoRow \? "order-last w-full/);
    const secondary = header.slice(header.indexOf("data-chat-header-secondary"));
    expect(secondary.indexOf("<TaskPicker")).toBeGreaterThan(-1);
    expect(secondary.indexOf("<ModelPicker")).toBeGreaterThan(-1);
    // On the labelled second row the chips may truncate down to a floor,
    // everywhere else they overflow so the measurement can see them.
    expect(header).toMatch(/!twoRow \|\| layout\.chips === "compact"\s*\? "\*:shrink-0"/);
    expect(header).toContain('? "[&>[data-header-labelled]]:min-w-[5.5rem]"');
    expect(header).toContain(': "[&>*:not([data-header-labelled=task])]:shrink-0 [&>[data-header-labelled=task]]:min-w-[5.5rem]"');
  });

  it("gives the identity cluster the space the controls leave", () => {
    // ROOT CAUSE of the shipped overlap: the identity cluster was the only
    // thing without `shrink-0`, and had no `flex-1` to claim what was left.
    expect(header).toContain('className="flex min-w-0 flex-1 items-center gap-2.5');
    expect(header).toContain("data-chat-header-name");
  });

  it("opens the effective workspace, never the folder setting", () => {
    expect(header).toMatch(/WorkingFolderChip[\s\S]{0,600}openFiles\(\{ botId: bot\.id, threadId: bot\.threadId \}\)/);
    expect(header).not.toMatch(/WorkingFolderChip[\s\S]{0,600}toggleSettings/);
    // A custom task folder cannot read as the bot's default.
    expect(header).toContain('return { path: task.cwd, origin: "task" }');
    expect(header).toContain('return { path: bot.cwd, origin: "bot" }');
    expect(header).toContain('return { origin: "default" }');
    // The complete resolved location travels as the accessible description.
    expect(header).toMatch(/aria-label=\{`\$\{workspaceActionLabel\(workspace\)\} — \$\{detail\}`\}/);
    expect(header).toContain("description: workspaceDetail(workspace)");
  });
});
