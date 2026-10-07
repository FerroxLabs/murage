// moss-approval-bug.md item 1, the room-call counterpart to CallView.test.ts's
// "collapsed" block: App.tsx now mounts GroupCall once, keyed to the room on
// the call, and collapses it to a bar instead of unmounting it when another
// thread or screen is on top. Source contracts only — see CallView.test.ts's
// header comment for why this suite cannot render the component.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./GroupCallView.tsx", import.meta.url)), "utf8");

describe("collapsed: the room call survives a thread switch (moss-approval-bug.md item 1)", () => {
  it("GroupCall takes collapsed/onExpand, defaulting to a full, expanded screen", () => {
    expect(source).toMatch(
      /export function GroupCall\(\{\s*group,\s*members,\s*collapsed = false,\s*onExpand,\s*\}: \{/,
    );
  });

  // callbar-review.md I4, I5: the bar itself is ChatView/GroupView's own
  // strip now (CallControls.tsx's CallBarStrip, pinned in App.test.ts),
  // reading the "live" status this component always publishes (GroupCall
  // has no hold/lost concept). Only the "no slot mounted" fallback (I3)
  // still renders a bar from here.
  it("publishes 'live' for the strip, and clears it only on true unmount", () => {
    expect(source).toContain('import { publishCallBarState } from "@/lib/call-bar";');
    expect(source).toContain('const threadRef = useRef(group.threadId);');
    expect(source).toContain(
      'publishCallBarState({ targetId: group.id, threadId: threadRef.current, name: group.name, status: "live", kind: "group" });',
    );
    expect(source).toMatch(
      /publishCallBarState\(\{ targetId: group\.id, threadId: threadRef\.current, name: group\.name, status: "live", kind: "group" \}\);\s*\}, \[group\.id, group\.name\]\);/,
    );
    expect(source).toContain("useEffect(() => () => publishCallBarState(null), []);");
  });

  it("portals its full screen into the on-screen room column, never Shell's own container (I3)", () => {
    expect(source).toContain('import { createPortal } from "react-dom";');
    expect(source).toContain('import { useCallSlot } from "@/lib/call-slot";');
    expect(source).toContain("const slot = useCallSlot();");
    expect(source).toContain("return createPortal(fullScreen, slot);");
  });

  // The slot it portals into is pointer-events-none (GroupView.tsx), and
  // pointer-events is inherited — without this the full screen silently
  // stops taking clicks the moment it portals.
  it("marks its own root pointer-events-auto, since the slot it portals into is pointer-events-none", () => {
    expect(source).toContain(
      '<div className="pointer-events-auto absolute inset-0 isolate z-30 flex flex-col items-center justify-center gap-6 bg-app/95 px-8 backdrop-blur-sm">',
    );
  });

  // callbar-rereview.md N2: collapsed but no room-column slot mounted at
  // all (Routines, team map, skill recorder, empty states, another bot's
  // workspace) must still render the call's own fallback bar.
  // callbar-rereview2.md G1: a drifted thread collapses the same way.
  it("effectiveCollapsed (collapsed, or the room's own thread drifted) returns the fallback bar when no slot is mounted, and null when the strip elsewhere shows one (N2, G1)", () => {
    expect(source).toContain("const threadDrifted = group.threadId !== threadRef.current;");
    expect(source).toContain("const effectiveCollapsed = collapsed || threadDrifted;");
    const collapsedAt = source.indexOf("if (effectiveCollapsed) return slot ? null : fallbackBar;");
    const fullScreenAt = source.indexOf(
      '<div className="pointer-events-auto absolute inset-0 isolate z-30 flex flex-col items-center justify-center gap-6 bg-app/95 px-8 backdrop-blur-sm">',
    );
    expect(collapsedAt).toBeGreaterThan(-1);
    expect(fullScreenAt).toBeGreaterThan(collapsedAt);
  });

  it("falls back to a floating bar, built from the shared CallBarContent, whenever no slot is mounted -- collapsed, drifted, or neither (I3, M2, N2, N4, G1)", () => {
    expect(source).toContain('import { CallBarContent } from "./CallBarContent";');
    const fallbackAt = source.indexOf("const fallbackBar = (");
    const collapsedReturnAt = source.indexOf("if (effectiveCollapsed) return slot ? null : fallbackBar;");
    const noSlotReturnAt = source.indexOf("if (!slot) return fallbackBar;");
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(collapsedReturnAt).toBeGreaterThan(fallbackAt);
    expect(noSlotReturnAt).toBeGreaterThan(collapsedReturnAt);
    const fallback = source.slice(fallbackAt, collapsedReturnAt);
    expect(fallback).toContain('data-testid="call-bar"');
    expect(fallback).toMatch(
      /<CallBarContent name=\{group\.name\} status="live" onReturn=\{\(\) => onExpand\?\.\(\)\} onHangUp=\{\(\) => endCall\(group\.id\)\} \/>/,
    );
  });

  it("Escape and Space are inert while effectively collapsed: another thread owns the keyboard", () => {
    const onKey = source.slice(source.indexOf("useEffect(() => {\n    const onKey"), source.indexOf("}, [effectiveCollapsed, group.id, interruptSpeech]);"));
    expect(onKey).toMatch(/const onKey = \(event: KeyboardEvent\) => \{\s*if \(effectiveCollapsed\) return;/);
  });

  // callbar-rereview2.md G1: approval/question/messages are read from the
  // room's LIVE thread; while drifted, asking about or deciding one of
  // those would send the call's own (frozen) threadId alongside a
  // requestId that belongs to the OTHER thread -- worse than doing
  // nothing, the same guard CallView.tsx's narration effect already has.
  it("the narration and approval effect is guarded by the same thread-drift check as CallView.tsx's (G1)", () => {
    const narrationAt = source.indexOf("let resumeAfterRoutine = false;", source.indexOf("useEffect(() => {\n    // `approval`"));
    const effectAt = source.lastIndexOf("useEffect(() => {", narrationAt);
    const effect = source.slice(
      effectAt,
      source.indexOf("}, [approval, enqueueSpeech, group.busyBotId, group.threadId, group.working, members, messages, question, scheduleListen]);"),
    );
    expect(effect).toMatch(/if \(group\.threadId !== threadRef\.current\) return;/);
    // The drift guard runs before anything else in the effect.
    expect(effect.indexOf("if (group.threadId !== threadRef.current) return;")).toBeLessThan(
      effect.indexOf("let resumeAfterRoutine = false;"),
    );
  });
});

// Track C3: the room call gets the 1:1 call's hold and its speak-as-it-streams.
// The behaviour is tested in src/lib/group-call-wiring.test.ts (OwnerLine and
// RoomReplyVoice with fakes); this only pins that the component uses them
// (this suite cannot render the component).
describe("hold and stream like the 1:1 call (track C3)", () => {
  it("uses the shared pause-tolerant endpoints, not its own 850 ms", () => {
    expect(source).not.toContain("const CALL_ENDPOINT_MS = 850;");
    expect(source).toContain("endpointMs: CALL_ENDPOINT_MS, endpointLongMs: CALL_ENDPOINT_LONG_MS");
  });

  it("finals go through OwnerLine, replies through RoomReplyVoice, with one sendGroup", () => {
    expect(source).toContain("new OwnerLine(");
    expect(source).toContain("ownerLine.current!.final(said)");
    expect(source).toContain("new RoomReplyVoice<Bot>(");
    expect(source.match(/type: "sendGroup"/g)).toHaveLength(2);
  });

  it("an interrupt tells the reply voice, and the turn ending clears it", () => {
    expect(source).toContain("roomVoice.current!.interrupt(wasBusy)");
    expect(source).toContain("roomVoice.current!.turnOver()");
  });
});

describe("instant acknowledgement in the room call (speed plan task 16)", () => {
  const start = source.indexOf("const sendToRoom = useCallback(");
  const sendToRoom = source.slice(start, source.indexOf("/** One member answers through the voice host"));
  const interruptSpeech = source.slice(source.indexOf("const interruptSpeech = useCallback("), source.indexOf("useEffect(() => {\n    alive.current = true;"));
  const writingEffect = source.slice(source.indexOf("const writing = liveText[threadRef.current]"), source.indexOf("// `approval`/`question`/`messages` are read"));
  const cueRoom = source.slice(source.indexOf("const cueRoom = useCallback("), source.indexOf("/** The owner's line to the room engines"));

  it("sendToRoom starts a gate from the send time; the first text written for the call's thread ends it", () => {
    expect(sendToRoom).toMatch(/new AckGate\(/);
    expect(sendToRoom).toMatch(/gate\.start\(sentAt\)/);
    expect(writingEffect).toMatch(/if \(writing\) \{[\s\S]{0,120}ackGate\.current\?\.realPiece\(\)/);
  });

  it("the cue needs a known voice: the member writing, else the one addressed, else none", () => {
    expect(sendToRoom).toContain("cueMemberFor(");
    expect(cueRoom).toMatch(/if \(!member\) return;/);
  });

  it("plays only into an idle room, as a cue-only stream through the speech queue", () => {
    expect(cueRoom).toContain("cueMayPlay(");
    expect(cueRoom).toContain("roomOtherSpeech(");
    expect(cueRoom).toMatch(/enqueueJob\(/);
    expect(cueRoom).toMatch(/\.cue\(/);
    expect(cueRoom).toMatch(/\.end\(\)/);
  });

  it("the cue job re-checks in the job, skips an open mic, and leaves the speaking phase through phaseAfterCue", () => {
    expect(cueRoom).toMatch(/enqueueJob\(async \(\) => \{[\s\S]{0,160}mayPlay\(true\)/);
    expect(cueRoom).toMatch(/phaseRef\.current === "listening"\) return;/);
    expect(cueRoom).toMatch(/await cueStream\.done;[\s\S]{0,300}phaseAfterCue\(/);
    expect(cueRoom.indexOf('phaseRef.current === "listening"')).toBeLessThan(cueRoom.indexOf('move("speaking")'));
  });

  it("nothing from the cue is dispatched to the thread or kept as a message", () => {
    for (const forbidden of ["dispatch(", "spokenIds", "roomVoice", "messages"]) {
      expect(cueRoom, forbidden).not.toContain(forbidden);
    }
  });

  it("an interrupt and a hang-up cancel the gate", () => {
    expect(interruptSpeech).toContain("ackGate.current?.cancel()");
    expect(interruptSpeech).toContain("ackTurn.current += 1");
    expect(source).toMatch(/alive\.current = false;\s*queueGeneration\.current \+= 1;[\s\S]{0,200}ackGate\.current\?\.cancel\(\)/);
  });
});

describe("the room's voice host is stopped with the call (group-voice-host-plan.md Task 6)", () => {
  it("an interrupt aborts a host turn in flight and gives the owner the floor back", () => {
    expect(source).toMatch(/const interruptSpeech = useCallback\(\(\) => \{[\s\S]*?hostAbort\.current\?\.abort\(\);[\s\S]*?floor\.current\.release\(\);/);
  });
  it("hang-up aborts a host turn in flight", () => {
    expect(source).toMatch(/return \(\) => \{\s*alive\.current = false;[\s\S]*?hostAbort\.current\?\.abort\(\);[\s\S]*?floor\.current\.release\(\);/);
  });
  it("every room speech job waits for the owner's line", () => {
    expect(source).toMatch(/if \(generation !== queueGeneration\.current\) return;\s*await floor\.current\.wait\(\);\s*if \(generation !== queueGeneration\.current\) return;\s*await run\(\);/);
  });
  it("the voice host setting is read per turn, not once at mount", () => {
    expect(source).not.toMatch(/const hostOn = useRef\(Boolean\(state\.config/);
    expect(source).toMatch(/const hostEnabled = useCallback\(\(\) => Boolean\(configRef\.current\?\.tts\?\.routes\?\.host\) && !hostDisabled\.current, \[\]\);/);
    expect(source).toMatch(/const member = hostEnabled\(\) \?/);
  });
  it("sendSpoken depends on hostEnabled, and releases the floor in a finally", () => {
    const sendSpoken = source.slice(source.indexOf("const sendSpoken = useCallback("), source.indexOf("sendSpokenRef.current = sendSpoken;"));
    expect(source).toMatch(/const hostEnabled = useCallback\(\(\) => Boolean\(configRef/);
    expect(sendSpoken).toMatch(/\[group\.dm, group\.id, hostEnabled, hostReply, listen, sendToRoom\]/);
    expect(sendSpoken).toMatch(/try \{[\s\S]*\} finally \{\s*floor\.current\.release\(\);\s*\}/);
  });
  it("a hand-down is pinned to the member who made it and sends the owner's own words, never the host's request or a stripped text (F1, F8)", () => {
    const hostReply = source.slice(source.indexOf("const hostReply = useCallback("), source.indexOf("/** Send what the owner said, whole"));
    expect(hostReply).toContain("handDownMessage(ownerWords, event.request)");
    expect(hostReply).not.toContain("replace(/@/g");
    expect(hostReply).not.toMatch(/text: event\.request/);
    expect(hostReply).toMatch(/type: "sendGroup",[\s\S]{0,200}text: message\.text,[\s\S]{0,120}responderId: member\.id,/);
    expect(hostReply).toContain("if (!message) return;");
    expect(source).toContain("hostReply(routed.text, member, said)");
  });
  it("the hand-down record keeps the send receipt, and a cancel reaches the member's queued request even when another member is busy (F7)", () => {
    const hostReply = source.slice(source.indexOf("const hostReply = useCallback("), source.indexOf("/** Send what the owner said, whole"));
    expect(hostReply).toMatch(/sendId: handed\.sendId,/);
    expect(hostReply).toMatch(/onReceipt: \(receipt\) => \{[\s\S]{0,200}queued: receipt\.queued[\s\S]{0,120}requestId: receipt\.requestId/);
    // the cancel decisions are room-host.ts's (tested there by behaviour)
    expect(hostReply).toContain("cancelWaitingHandDowns(memory, member.id");
    // the running-turn interrupt stays tied to THIS member being the busy one
    expect(hostReply).toMatch(/if \(busyBotRef\.current === member\.id\) interruptHandDowns\(/);
  });
  it("the floor's quiet cap finalises the line heard so far instead of dropping it (F9)", () => {
    expect(source).toContain("new OwnerFloor(FLOOR_MAX_MS, (line) => expireOwnerLine.current(line))");
    expect(source).toContain("floor.current.take(line.text)");
    expect(source).toMatch(/expireOwnerLine\.current = \(line\) => \{[\s\S]{0,700}sendSpokenRef\.current\(said\)/);
  });
  it("the quiet cap hands the open approval and question state to expireFloorLine (behaviour tested in room-host.test.ts)", () => {
    const expire = source.slice(source.indexOf("expireOwnerLine.current = (line) => {"), source.indexOf("useEffect(() => {\n    const bridge = window.muragebox;"));
    expect(expire).toContain("approvalOpen: Boolean(askedApproval.current)");
    expect(expire).toContain("questionOpen: Boolean(askedQuestion.current)");
  });
  it("allowBargeIn is raised only while the handed-down work is still running (M2)", () => {
    expect(source).toContain("if (turn.handed && !handDownWork.current.done) allowBargeIn.current = true;");
    expect(source).toMatch(/if \(busy\) handDownWork\.current\.seen = true;\s*else if \(handDownWork\.current\.seen\) handDownWork\.current\.done = true;/);
    expect(source).toContain("handDownWork.current = { seen: false, done: false };");
  });
  it("a host that errors after speaking says so instead of leaving a half answer (M3)", () => {
    expect(source).toMatch(/if \(turn\.failed && !turn\.handed\) enqueueSpeech\("Sorry, I lost my train of thought\.", member, true\);/);
  });
  it("the store forwards responderId in the room send body (I1)", () => {
    const store = readFileSync(fileURLToPath(new URL("../state/store.tsx", import.meta.url)), "utf8");
    expect(store).toMatch(/responderId\?: string;/);
    expect(store).toMatch(/action\.onReceipt\?\.\(\{\s*sendId,/);
    expect(store).toMatch(/mode: action\.mode \?\? "chat",\s*\.\.\.\(action\.responderId \? \{ responderId: action\.responderId \} : \{\}\),/);
    });
  });

describe("a spoken yes in a room call goes through fresh authentication (SEC-006 Decision 7)", () => {
  const start = source.indexOf('type: "decideRequest"');
  const spoken = source.slice(start, source.indexOf("Sorry, is that a yes or a no?", start));

  it("passes the card and a name, never an allow-task or a proof of its own", () => {
    expect(spoken).toMatch(/card: openApproval\.card/);
    expect(spoken).toMatch(/botName:/);
    expect(spoken).not.toMatch(/allowForTask|freshAuth\s*:/);
  });

  it("leaves the name empty when the member has none, so the prompt uses the translated fallback", () => {
    expect(spoken).toMatch(/botName: openApproval\.member\?\.name,/);
    expect(source).not.toContain("this channel member");
  });

  it("speaks a cancel and every refusal in plain words, and re-opens the card", () => {
    expect(spoken).toMatch(/onError: \(error: string, code\?: FreshAuthCode\)/);
    expect(spoken).toMatch(/freshAuthSpoken\(code\)/);
    expect(spoken).toMatch(/pending\.submitted = false/);
  });
});
