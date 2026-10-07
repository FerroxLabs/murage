// The call must survive a thread switch (moss-approval-bug.md): an approval
// notification for another bot used to unmount the call on the phone the
// moment it opened that bot's chat, because the call was mounted INSIDE the
// selected chat (CallOverlay nested in ChatView, GroupCallOverlay in
// GroupView) and only rendered for the bot that happened to be selected.
// The fix mounts the call once at Shell level, keyed to whichever bot or
// room is actually on the call — never to `state.selectedId` — and shrinks
// it to a bar instead of unmounting it when another thread is on screen.
//
// Source contracts, not rendered ones: this repo's vitest suite runs under
// `environment: "node"` with no jsdom and no testing-library (see the note
// at the top of CallView.test.ts, which this file follows).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

const app = read("./App.tsx");
const chatView = read("./components/ChatView.tsx");
const groupView = read("./components/GroupView.tsx");
const callControls = read("./components/CallControls.tsx");
const callBarContent = read("./components/CallBarContent.tsx");

// callbar-rereview.md I7: this logic used to live inline in App.tsx's Shell,
// which a hand-copied e2e harness could not exercise for real (reverting the
// `key` fix there didn't fail the call-host e2e suite). It now lives in
// CallOverlaySlot (CallControls.tsx), which App.tsx mounts and the e2e
// harness imports and mounts too — the same component, not a re-implementation.
describe("the call is mounted once, keyed to the call's own target, via CallOverlaySlot (I7)", () => {
  it("App.tsx mounts CallOverlaySlot, not its own inline overlay logic", () => {
    expect(app).toContain('import { CallOverlaySlot } from "@/components/CallControls";');
    expect(app).not.toContain('import { CallOverlay, GroupCallOverlay } from "@/components/CallControls";');
    expect(app).not.toContain('import { useOnCall } from "@/lib/call";');
    expect(app).toMatch(
      /<CallOverlaySlot\s*state=\{state\}\s*dispatch=\{dispatch\}\s*isCallTargetCovered=\{isCallTargetCovered\}\s*uncoverCallTarget=\{uncoverCallTarget\}\s*\/>/,
    );
  });

  // callbar-rereview.md N4: the call's own bot/room's workspace (LocalVm or
  // Browser) owns the screen while it is open, and used to sit UNDER a
  // full-screen call with nothing usable to return to. App.tsx reports
  // that through isCallTargetCovered/uncoverCallTarget rather than
  // CallOverlaySlot knowing about workspace panels at all.
  it("App.tsx's isCallTargetCovered/uncoverCallTarget cover the call's own workspace (N4)", () => {
    const coveredAt = app.indexOf("const isCallTargetCovered = useCallback(");
    expect(coveredAt).toBeGreaterThan(-1);
    const covered = app.slice(coveredAt, app.indexOf("const uncoverCallTarget = useCallback("));
    expect(covered).toContain("localVmWorkspaceBotId === id || browserWorkspaceBotId === id");
    const uncoverAt = app.indexOf("const uncoverCallTarget = useCallback(");
    const uncover = app.slice(uncoverAt, app.indexOf("[localVmWorkspaceBotId, browserWorkspaceBotId],", uncoverAt));
    expect(uncover).toContain("if (localVmWorkspaceBotId === id) setLocalVmWorkspaceBotId(null);");
    expect(uncover).toContain("if (browserWorkspaceBotId === id) setBrowserWorkspaceBotId(null);");
  });

  it("CallOverlaySlot reads the active call from useOnCall(), not from the selected bot or group", () => {
    expect(callControls).toMatch(/const activeCallId = useOnCall\(\);/);
    // Resolved against the FULL bots/groups lists, never against whatever
    // `state.selectedId` currently points to.
    expect(callControls).toMatch(
      /activeCallGroup = activeCallId \? state\.groups\.find\(\(g\) => g\.id === activeCallId\) : undefined;/,
    );
    expect(callControls).toMatch(
      /activeCallBotRaw = !activeCallGroup && activeCallId \? state\.bots\.find\(\(b\) => b\.id === activeCallId\) : undefined;/,
    );
    // Projected through viewedTaskBot, like every other conversation
    // control (callbar-review.md I6), and memoized (M7).
    expect(callControls).toContain('import { useStore, viewedTaskBot, type Bot, type Group } from "@/state/store";');
    expect(callControls).toMatch(
      /const activeCallBot = useMemo\(\(\) => \(activeCallBotRaw \? viewedTaskBot\(activeCallBotRaw\) : undefined\), \[activeCallBotRaw\]\);/,
    );
    expect(callControls).toMatch(/const activeCallGroupMembers = useMemo\(\s*\(\) =>\s*activeCallGroup/);
  });

  it("is full screen only while that call's own thread is selected AND its own target is not covered (N4)", () => {
    const callIsSelectedAt = callControls.indexOf("const callIsSelected =");
    expect(callIsSelectedAt).toBeGreaterThan(-1);
    const callIsSelected = callControls.slice(callIsSelectedAt, callControls.indexOf("const returnToCall = () => {"));
    expect(callIsSelected).toContain('state.activeView === "chat" &&');
    expect(callIsSelected).toContain("state.selectedId === activeCallId &&");
    expect(callIsSelected).toContain("!(activeCallId && isCallTargetCovered?.(activeCallId));");
    expect(callControls).toMatch(/collapsed=\{!callIsSelected\}/);
  });

  it("tapping the bar uncovers the call's own target (if covered), re-selects it, and restores its own frozen thread (N4, G2)", () => {
    const returnToCall = callControls.slice(
      callControls.indexOf("const returnToCall = () => {"),
      callControls.indexOf("return (", callControls.indexOf("const returnToCall = () => {")),
    );
    expect(returnToCall).toContain("if (!activeCallId) return;");
    expect(returnToCall).toContain("uncoverCallTarget?.(activeCallId);");
    expect(returnToCall).toContain('dispatch({ type: "select", id: activeCallId });');
    // callbar-rereview2.md G2: selecting alone can leave the call's own
    // bot/room on whatever thread a push moved it to -- restore the call's
    // frozen thread too, the same way CallBarStrip's own tap already does.
    expect(returnToCall).toContain('dispatch({ type: "switchTask", botId: bar.targetId, threadId: bar.threadId });');
    expect(returnToCall).toContain('dispatch({ type: "switchGroupTask", groupId: bar.targetId, threadId: bar.threadId });');
    expect(callControls).toMatch(/onExpand=\{returnToCall\}/);
  });

  it("renders CallOverlay/GroupCallOverlay unconditionally on the active call, never gated on bot/group selection", () => {
    // The old bug: rendering the overlay only for the selected bot/group
    // meant switching selection made the condition false and the overlay
    // — and the mounted Call underneath it — unmounted.
    expect(callControls).toMatch(/\{activeCallBot && \(\s*<CallOverlay key=\{activeCallId\} bot=\{activeCallBot\}/);
    expect(callControls).toMatch(/\{activeCallGroup && activeCallGroupMembers && \(\s*<GroupCallOverlay\s*key=\{activeCallId\}/);
  });

  it("keys both overlays to the call's own target, so calling a different one mounts fresh (callbar-review.md I1)", () => {
    expect(callControls).toContain("<CallOverlay key={activeCallId} bot={activeCallBot}");
    expect(callControls).toMatch(/<GroupCallOverlay\s*key=\{activeCallId\}\s*group=\{activeCallGroup\}/);
  });
});

describe("ChatView and GroupView no longer own the call overlay", () => {
  it("ChatView does not mount CallOverlay inside the selected chat", () => {
    expect(chatView).not.toMatch(/<CallOverlay\b/);
    expect(chatView).not.toContain('import { CallOverlay } from "./CallControls";');
  });

  it("GroupView does not mount GroupCallOverlay inside the selected room", () => {
    expect(groupView).not.toMatch(/<GroupCallOverlay\b/);
    expect(groupView).toContain('import { GroupCallButton, CallBarStrip } from "./CallControls";');
  });
});

describe("CallOverlay/GroupCallOverlay forward collapsed and onExpand through to the call", () => {
  it("CallOverlay passes collapsed/onExpand to Call", () => {
    expect(callControls).toMatch(
      /export function CallOverlay\(\{\s*bot,\s*collapsed = false,\s*onExpand,\s*\}: \{/,
    );
    expect(callControls).toMatch(/<Call bot=\{bot\} collapsed=\{collapsed\} onExpand=\{onExpand\} \/>/);
  });

  it("GroupCallOverlay passes collapsed/onExpand to GroupCall", () => {
    expect(callControls).toMatch(
      /export function GroupCallOverlay\(\{\s*group,\s*members,\s*collapsed = false,\s*onExpand,\s*\}: \{/,
    );
    expect(callControls).toMatch(
      /<GroupCall group=\{group\} members=\{members\} collapsed=\{collapsed\} onExpand=\{onExpand\} \/>/,
    );
  });
});

// callbar-review.md I1: calling a different bot or room while one call is
// collapsed must end it first, with no confirm dialog — otherwise the new
// call (even with the key fix) is started alongside one still running.
describe("a call button ends whatever is on the call before starting a different one", () => {
  it("CallTargetButton reads useOnCall() and hangs up the other target first, no confirm", () => {
    expect(callControls).toMatch(/const onCall = useOnCall\(\);\s*const active = onCall === targetId;/);
    expect(callControls).toMatch(
      /if \(onCall && onCall !== targetId\) endCall\(onCall\);\s*startCall\(targetId\);/,
    );
    // No AskUserQuestion, no window.confirm, no dialog component anywhere
    // near this — the ruling was explicit: no confirm.
    expect(callControls).not.toMatch(/confirm\(/);
  });
});

// callbar-review.md I3, I4, I5: the call's full screen portals into the
// chat/room column that is actually on screen, and the collapsed bar is a
// strip ChatView/GroupView render themselves, in normal layout — neither
// lives in Call's own fixed/floating JSX any more except as a last-resort
// fallback (pinned in CallView.test.ts). callbar-rereview.md N3: the strip
// matches on the call's own thread too, not just the bot/room id.
describe("the chat/room column owns a call slot and renders the bar itself", () => {
  it("ChatView registers a call slot on mount and unregisters it on unmount", () => {
    expect(chatView).toContain('import { registerCallSlot } from "@/lib/call-slot";');
    expect(chatView).toMatch(
      /const callSlotRef = useRef<HTMLDivElement>\(null\);\s*useEffect\(\(\) => \{\s*registerCallSlot\(callSlotRef\.current\);\s*return \(\) => registerCallSlot\(null\);\s*\}, \[\]\);/,
    );
    expect(chatView).toContain('<div ref={callSlotRef} className="pointer-events-none absolute inset-0" />');
  });

  it("GroupView registers a call slot the same way", () => {
    expect(groupView).toContain('import { registerCallSlot } from "@/lib/call-slot";');
    expect(groupView).toMatch(
      /const callSlotRef = useRef<HTMLDivElement>\(null\);\s*useEffect\(\(\) => \{\s*registerCallSlot\(callSlotRef\.current\);\s*return \(\) => registerCallSlot\(null\);\s*\}, \[\]\);/,
    );
  });

  it("ChatView renders CallBarStrip under its header, keyed to its own bot AND thread (N3)", () => {
    expect(chatView).toContain('import { CallBarStrip } from "./CallControls";');
    expect(chatView).toContain("<CallBarStrip ownId={bot.id} ownThreadId={bot.threadId} />");
  });

  it("GroupView renders CallBarStrip under its header, keyed to its own room AND thread (N3)", () => {
    expect(groupView).toContain("<CallBarStrip ownId={group.id} ownThreadId={group.threadId} />");
  });
});

describe("CallBarStrip (callbar-review.md I4, I5; callbar-rereview.md N3): status and matching", () => {
  const strip = callControls.slice(
    callControls.indexOf("export function CallBarStrip"),
    callControls.length,
  );

  it("takes ownId AND ownThreadId, and hides only on the call's own thread — not merely its own bot/room", () => {
    expect(strip).toMatch(/export function CallBarStrip\(\{ ownId, ownThreadId \}: \{ ownId: string; ownThreadId\?: string \}\) \{/);
    expect(strip).toContain("if (!bar || (bar.targetId === ownId && bar.threadId === ownThreadId)) return null;");
    expect(strip).not.toMatch(/\bfixed\b/);
    expect(strip).toContain('data-testid="call-bar"');
  });

  it("returning selects the target AND restores the call's own (frozen) thread — a bot via switchTask, a room via switchGroupTask", () => {
    expect(strip).toContain('dispatch({ type: "select", id: bar.targetId });');
    expect(strip).toContain('if (bar.kind === "bot") dispatch({ type: "switchTask", botId: bar.targetId, threadId: bar.threadId });');
    expect(strip).toContain('else dispatch({ type: "switchGroupTask", groupId: bar.targetId, threadId: bar.threadId });');
  });

  it("renders the shared CallBarContent with the published status, never its own copy", () => {
    expect(callControls).toContain('import { CallBarContent } from "./CallBarContent";');
    expect(strip).toMatch(/<CallBarContent\s*name=\{bar\.name\}\s*status=\{bar\.status\}/);
  });
});

// callbar-rereview.md N2, N4: Call/GroupCall's own fallback (rendered when
// no chat/room column is mounted at all) must show the SAME real status,
// not a hard-coded "live" — so it, and CallBarStrip, share one content
// component rather than drifting apart.
describe("CallBarContent (shared by CallBarStrip and Call/GroupCall's fallback)", () => {
  it("the pulse animates only when live", () => {
    expect(callBarContent).toMatch(/\{live && <span className="absolute inline-flex size-full animate-ping/);
  });

  it("swaps 'Tap to…' for the plain verb at md and above", () => {
    expect(callBarContent).toContain('const actionMobile = live ? "Tap to return" : resumable ? "Tap to resume" : "";');
    expect(callBarContent).toContain('const actionWide = live ? "Return to call" : resumable ? "Resume call" : "";');
    expect(callBarContent).toContain('<span className="md:hidden">{actionMobile}</span>');
    expect(callBarContent).toContain('<span className="hidden md:inline">{actionWide}</span>');
  });

  it("covers connecting, paused and lost with the ruling's exact copy", () => {
    expect(callBarContent).toContain('status === "connecting" ? `Connecting to ${name}…`');
    expect(callBarContent).toContain("`On a call with ${name}.`");
    expect(callBarContent).toContain("`Call with ${name} paused.`");
    // No em dash, never "safe", no price talk — checked on the actual
    // copy (the string literals), not the source file's own comments.
    const copy = ["Connecting to X…", "On a call with X.", "Call with X paused."];
    for (const line of copy) {
      expect(line).not.toMatch(/—/);
      expect(line).not.toMatch(/\bsafe\b/i);
    }
  });

  it("is two sibling buttons, never one nested in another (M2)", () => {
    expect(callBarContent).not.toMatch(/role="button"/);
    expect(callBarContent.match(/<button/g)?.length).toBe(2);
  });
});
