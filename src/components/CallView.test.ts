// Source-pinning tests, not rendered ones: this repo's vitest config runs
// component tests under `environment: "node"` with no jsdom, no
// testing-library and no react-test-renderer anywhere in the tree (checked
// across every src/components/*.test.ts), so CallView — an effect-heavy,
// ref-driven component whose microphone wiring lives inside a useEffect —
// cannot be mounted and driven with a fake mic here the way the
// investigation doc's suggested test would. What CAN be pinned, the way
// ChatView.test.ts already does for its own hard-to-render logic, is the
// exact shape of the fix in the source: that a failed or stalled reply clip
// (heardAll === false) no longer bails out of tellReply/hostReply before
// the call has a chance to recover, and that only a real interruption
// (a stale sayGeneration, the call gone, or — in tellReply — having already
// left "speaking") still does.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./CallView.tsx", import.meta.url)), "utf8");

/** Cuts one function body out of the source by its start marker, up to the
 *  next top-level `);` that closes a useCallback — brittle by line count,
 *  robust to it, exactly like ChatView.test.ts's approach next door. */
function slice(fromMarker: string, upToMarker: string): string {
  const start = source.indexOf(fromMarker);
  expect(start, `expected to find ${JSON.stringify(fromMarker)} in CallView.tsx`).toBeGreaterThan(-1);
  const end = source.indexOf(upToMarker, start);
  expect(end, `expected to find ${JSON.stringify(upToMarker)} after ${JSON.stringify(fromMarker)}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("never stuck on speaking (call-fixes-brief.md item 2)", () => {
  const tellReply = slice("const tellReply = useCallback(", "const tellNext = useRef(tellReply);");
  const hostReply = slice("const hostReply = useCallback(", "// \"Still on it\"");

  it("tellReply no longer bails out on a failed clip before checking who is still on the line", () => {
    // The old bug: `if (!heardAll) return;` unconditionally, before ever
    // asking whether this generation/call/phase was still current — so a
    // clip that merely failed to play looked identical to a real hang-up.
    expect(tellReply).not.toMatch(/if \(!heardAll\) return;/);
    // The fix folds heardAll into the same generation/liveness guard that
    // decides a real interruption, so a failure with nothing else wrong
    // falls through to the held/listen recovery below it.
    expect(tellReply).toMatch(
      /if \(!alive\.current \|\| currentCall\(\) !== bot\.id \|\| sayGeneration\.current !== mine \|\| phaseRef\.current !== "speaking"\) return;/,
    );
    // and that recovery — tell the next held reply, or listen — must still
    // be reachable right after the guard
    const guardAt = tellReply.indexOf("sayGeneration.current !== mine");
    expect(tellReply.slice(guardAt)).toContain("deferredReplies.current.shift()");
    expect(tellReply.slice(guardAt)).toContain("else listen();");
  });

  it("hostReply's stream branch no longer bails on !heardAll ahead of the liveness check", () => {
    // The old bug, same shape: `if (!heardAll || sayGeneration.current !== mine || ...) return;`
    expect(hostReply).not.toMatch(/if \(!heardAll \|\|/);
    // The fix: only a stale generation or a dead call returns early here...
    expect(hostReply).toMatch(
      /if \(!alive\.current \|\| currentCall\(\) !== bot\.id \|\| sayGeneration\.current !== mine\) return;/,
    );
    // ...so a failed clip falls through to the shared recovery below, which
    // still calls listenOrCatchUp() for "speaking" (and "sending", the
    // no-stream edge case) exactly as a normal finished reply does.
    const guardAt = hostReply.indexOf("if (!alive.current || currentCall() !== bot.id || sayGeneration.current !== mine) return;");
    expect(hostReply.slice(guardAt)).toMatch(
      /if \(phaseRef\.current === "speaking" \|\| phaseRef\.current === "sending"\) listenOrCatchUp\(\);/,
    );
  });
});

describe("the owner's words stay on screen (call-fixes-brief.md item 1)", () => {
  it("renders the caption through CallCaption instead of a listening-only line", () => {
    expect(source).toContain('import { CallCaption } from "./CallCaption";');
    expect(source).toMatch(/<CallCaption phase=\{phase\} heard=\{heard\} caption=\{speech\.caption\} spoken=\{speech\.spoken\} queued=\{speech\.queued\} progress=\{readAlongProgress\} pushToTalk=\{pushToTalk\} \/>/);
  });

  it("no longer has the old listening-only caption block inline", () => {
    // The old block showed `heard` only while phase === "listening"; a
    // phone's final transcript and the move to "sending" land in the same
    // render, so it was never painted. See CallCaption.test.ts for the
    // replacement's actual rendered behaviour.
    expect(source).not.toMatch(/\{phase === "listening" \? \(\s*heard \|\| \(/);
  });
});

// iPhone native call audio (spec rev 3, §4.3.2 to §4.3.5). The behaviour is
// driven end to end in src/e2e/call-host.human.spec.ts against a fake
// murageNative; these pin the orders the spec fixes, which a behavioural
// test can only see indirectly.
describe("native call audio: the path, the hold and the lifecycle", () => {
  /** Positions of each needle in `text`, in the order given; every one must
   *  be present, and each after the one before. */
  function inOrder(text: string, needles: string[]) {
    let from = 0;
    for (const needle of needles) {
      const at = text.indexOf(needle, from);
      expect(at, `expected ${JSON.stringify(needle)} after position ${from}`).toBeGreaterThanOrEqual(from);
      from = at + needle.length;
    }
  }

  it("chooses the path when the call opens, through CallAudio, never at render", () => {
    expect(source).toMatch(/import \{ CallAudio(, micFor)?(, offerResumeWhenHeld)?(, type CallAudioPath)? \} from "@\/lib\/call-audio";/);
    expect(source).not.toMatch(/nativeHas\(|nativeAvailable\(/);
    const mic = slice("// ── the microphone", "// ── narrate the work");
    expect(mic).toContain("audio.open()");
  });

  it("holds in the spec's order", () => {
    const hold = slice("const holdCall = useCallback(", "const resumeFromHold = useCallback(");
    inOrder(hold, [
      "sayGeneration.current += 1;",
      "dropMaybeOwner();",
      "hostAbort.current?.abort();",
      "hostSpeaking.current = false;",
      "speaker.stop();",
      "hush();",
      "resetDetection();",
      "pulse(false);",
      "heldRef.current = true;",
    ]);
  });

  it("resumes in the spec's order, and asks owed prompts before going back to work", () => {
    const resume = slice("const resumeFromHold = useCallback(", "const loseCall = useCallback(");
    inOrder(resume, [
      "heldRef.current = false;",
      "resetDetection();",
      "firstSpokeAt.current = 0;",
      "lastSpeechAt.current = Date.now();",
      'move("working")',
      "listenOrCatchUp();",
    ]);
    expect(resume).toContain("owed.current.length");
  });

  it("lost resets detection, and Resume call reopens the source with a new player, never closing the mic", () => {
    const lost = slice("const loseCall = useCallback(", "const resumeCall = useCallback(");
    expect(lost).toContain("resetDetection()");
    const resumeCall = slice("const resumeCall = useCallback(", "}, [");
    inOrder(resumeCall, [".reopen()", ".player()", "speaker.useOutput("]);
    expect(resumeCall).not.toMatch(/\.close\(\)/);
    expect(resumeCall).toContain('"The microphone couldn\'t start."');
  });

  // I2 (c): a hold nothing on the phone ends is not a dead end.
  it("offers Resume call after a long hold too, through the same reopen", () => {
    const offer = slice("  useEffect(() => {\n    if (!held || lost) {", "const onCallAudio = useRef<");
    inOrder(offer, ["setHeldLong(false);", "return offerResumeWhenHeld(setHeldLong);", "}, [held, lost]);"]);
    expect(source).toMatch(/\{\(lost \|\| heldLong\) && \(\s*<button\s*onClick=\{\(\) => void resumeCall\(\)\}/);
    // resumeFromHold still requires the hold, so a reopen with the hold
    // already ended by native does not resume twice.
    expect(slice("const resumeFromHold = useCallback(", "const loseCall = useCallback(")).toContain(
      "if (!heldRef.current || lostRef.current) return;",
    );
  });

  it("unmount stops speech, then clears the output, then closes the native session", () => {
    const cleanup = slice("alive.current = false;", "deferCallCleanup(bot.id");
    inOrder(cleanup, ["speaker.stop();", "speaker.useOutput(null);", "audioRef.current?.close();"]);
  });

  it("begin() sets the output first and drains with listenOrCatchUp, so an approval open at the start is asked", () => {
    const begin = slice("const begin = (attempt: number) => {", "const openCall = () => {");
    inOrder(begin, ["speaker.useOutput(", "outputReady.current = true;", "listenOrCatchUp();"]);
    expect(begin).not.toMatch(/else listen\(\);/);
  });

  it("gates speech on outputReady and held", () => {
    // (a line held for the rest of the owner's sentence gates too: review I-1)
    expect(source).toMatch(/const gated = \(\) => !outputReady\.current \|\| heldRef\.current( \|\| Boolean\(heldLine\.current\?\.holding\))?;/);
    const say = slice("const say = useCallback(", "const sayThenListen = useCallback(");
    expect(say).toContain("if (gated()) return false;");
    const sayThenListen = slice("const sayThenListen = useCallback(", "const sayThenListenRef");
    expect(sayThenListen).toMatch(/if \(gated\(\)\) \{\s*deferredReplies\.current\.unshift\(text\);/);
    const tellReply = slice("const tellReply = useCallback(", "const tellNext = useRef(tellReply);");
    expect(tellReply).toMatch(/if \(gated\(\)\) \{\s*deferredReplies\.current\.unshift\(text\);/);
    const listen = slice("const listen = useCallback(", "// Whenever the bot starts to speak");
    expect(listen).toContain("if (heldRef.current) return;");
  });

  it("never defers an approval or question prompt: they are owed and asked through sayThenListen", () => {
    const effect = slice("// ── narrate the work, speak the answer, read the approvals", "// busy is the harness's word");
    expect(effect).not.toMatch(/deferredReplies\.current\.(push|unshift)\((ask|skillPrompt|prompt)/);
    expect(effect).toMatch(/askPrompt\(\s*approval\.requestId,/);
    expect(effect).toMatch(/askPrompt\(\s*question\.card\.requestId,/);
    const ask = slice("const askPrompt = useCallback(", "}, [");
    expect(ask).toMatch(/sayThenListen\(text[,)]/);
    expect(ask).not.toContain("tellReply");
  });

  // callbar-rereview2.md G5: while drifted, bot.busy belongs to whatever
  // thread the push left on screen, not the call's own frozen thread —
  // following it would hush the mic, or resume listening, for the wrong
  // conversation.
  it("the busy effect is guarded by the same thread-drift check as the narration effect (G5)", () => {
    const busyEffect = slice("// busy is the harness's word", "}, [bot.busy, bot.threadId, hush, listen, move]);");
    expect(busyEffect).toMatch(/if \(bot\.threadId !== threadRef\.current\) return;/);
    // The drift check comes before heldRef's, so a drifted call never
    // touches the mic or the phase no matter what held is doing.
    expect(busyEffect.indexOf("if (bot.threadId !== threadRef.current) return;")).toBeLessThan(
      busyEffect.indexOf("if (heldRef.current) return;"),
    );
  });

  it("the pulse includes !held, and WorkingPulse is built only on the web path", () => {
    expect(source).toMatch(/const pulsing =\s*!held &&/);
    const pulse = slice("useEffect(() => {\n    if (audioPath === \"native\")", "const status =");
    inOrder(pulse, ["audioRef.current?.pulse(pulsing)", 'audioPath !== "web"', "new WorkingPulse()"]);
  });

  it("the status line is the one pure decision in src/lib/call-status.ts, and the copy is the spec's", () => {
    // the precedence (paused over connecting over muted over the phase) is
    // tested by behaviour in src/lib/call-status.test.ts
    expect(source).toContain("const status = callStatusText({ phase, held, connecting, muted, pushToTalk });");
    expect(source).toContain('"Allow the microphone for Murage in Settings, then try again"');
    expect(source).toContain("Resume call");
  });
});

// The 2026-09-30 cut-offs (call-cutoff-analysis.md, fixes 2, 5 and 6). The
// timing rules themselves are tested behaviourally in src/lib/call-turns
// .test.ts; these pin how CallView wires them, as the blocks above do.
describe("split sentences, the cut-in note and turn timing", () => {
  const hostReply = slice("const hostReply = useCallback(", "const joinTurn = useCallback(");
  const joinTurn = slice("const joinTurn = useCallback(", "const sendTurn = useCallback(");
  const onLine = slice("const handleLine = (line: MicLine) => {", "offEnd = mic.onEnd(");

  it("uses the shared pause-tolerant endpoints, by mic kind, not the old 850 ms", () => {
    expect(source).not.toContain("const CALL_ENDPOINT_MS = 850;");
    expect(source).toContain("CALL_ENDPOINT_MS");
    expect(source).toContain("VAD_ENDPOINT_MS");
    expect(source).toContain("endpointLongMs");
  });

  it("an unfinished final line waits for the rest, and the rest of a turn in flight joins it", () => {
    const at = onLine.indexOf("heldLine.current!.take(joinTurn(said, began), line.endedAt, line.longEndpoint ? LONG_ENDPOINT_HOLD_MS : undefined)");
    expect(at).toBeGreaterThan(-1);
    // after "stop", the approval and the question have had their say
    expect(onLine.indexOf("STOP_ONLY.test(said)")).toBeLessThan(at);
    expect(onLine.indexOf("const open = askedApproval.current;")).toBeLessThan(at);
    expect(onLine.slice(at)).toMatch(/if \(whole === null\) \{[\s\S]*?return;\s*\}\s*sendTurn\(whole, timing\);/);
    // "stop" forgets a held line and counts as the owner cutting in
    const stop = onLine.slice(onLine.indexOf("STOP_ONLY.test(said)"), at);
    expect(stop).toContain('heldLine.current?.drop("stop");');
    expect(stop).toContain("ownerCutInAt.current = Date.now();");
  });

  it("a final line while the answer is fetched joins that turn, but not a listening noise or an answer to a card", () => {
    expect(onLine).toMatch(/const joinable =\s*mic\.duplex &&\s*phaseRef\.current === "sending" &&\s*line\.partial === false &&/);
    expect(onLine).toMatch(/!askedApproval\.current &&\s*!askedQuestion\.current;/);
    expect(onLine).toContain('(phaseRef.current !== "listening" && !bargeable && !joinable)');
    expect(onLine).toMatch(/if \(joinable && \(BACKCHANNEL\.test\(said\) \|\| STOP_ONLY\.test\(said\)\)\)/);
    // the talk-over rules still run first while the bot speaks
    expect(onLine.indexOf("STOP_NOW.test(line.text.trim())")).toBeLessThan(onLine.indexOf("heldLine.current!.take("));
    expect(onLine.indexOf("bargeIn();")).toBeLessThan(onLine.indexOf("heldLine.current!.take("));
  });

  it("joining stops the turn in flight and its audio, and takes it back out of the history and the log", () => {
    expect(joinTurn).toContain("joinsTurn({ sentAt: turn.sentAt, playingAt }, { began, now })");
    expect(joinTurn).toContain("if (!hostOn.current || !turn || turn.superseded || turn.acted) return said;");
    for (const step of [
      "turn.superseded = true;",
      "turn.controller.abort();",
      "speaker.stop();",
      "hostHistory.current = hostHistory.current.filter((e) => !turn.history.includes(e));",
      "callLog.current = callLog.current.filter((e) => !turn.log.includes(e));",
      'move("listening");',
      "return `${turn.said} ${said}`;",
    ]) {
      expect(joinTurn).toContain(step);
    }
  });

  it("a superseded turn records and speaks nothing more, and never falls back to the engine", () => {
    const afterTurn = hostReply.slice(hostReply.indexOf("controller.signal,\n        );"));
    expect(afterTurn.indexOf("if (turn.superseded) return;")).toBeLessThan(afterTurn.indexOf("if (failed && !handed && !spoken)"));
    expect(hostReply).toMatch(/const heardAll = await told\.done;\s*if \(turn\.superseded\) return;/);
    // work handed down or cancelled is never asked again
    expect(hostReply.match(/turn\.acted = true;/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("notes the owner cut in only when they did, not when a clip failed", () => {
    expect(source).toMatch(/const bargeIn = useCallback\(\(\) => \{\s*interruptedAt\.current = Date\.now\(\);\s*ownerCutInAt\.current = Date\.now\(\);/);
    expect(hostReply).toContain("const cutIn = !heardAll && ownerCutInAt.current >= turn.sentAt;");
    expect(hostReply).not.toMatch(/heardAll \? "" : " \[the owner cut in here\]"/);
    const tellReply = slice("const tellReply = useCallback(", "const tellNext = useRef(tellReply);");
    expect(tellReply).toContain('heardAll || ownerCutInAt.current < startedAt ? "" : " [the owner cut in here]"');
  });

  it("a hold drops a line waiting for the rest", () => {
    const hold = slice("const holdCall = useCallback(", "const resumeFromHold = useCallback(");
    expect(hold).toContain('heldLine.current?.drop("hold");');
  });

  it("logs one turn-timing line per turn, from the finally", () => {
    const finallyBlock = hostReply.slice(hostReply.lastIndexOf("} finally {"));
    expect(finallyBlock).toContain("turnTiming({");
    expect(finallyBlock).toContain("...timing,");
    expect(finallyBlock).toContain("playingAt: turn.playingAt(),");
    expect(finallyBlock).toContain("ttsFirstByteAt: clip?.firstByteAt,");
    expect(finallyBlock).toContain('path: "host",');
    expect(hostReply.match(/turnTiming\(/g)).toHaveLength(1);
  });
});

// Review round 1 (voice-fixes-review.md I-1, I-2). The e2e drives I-1 end to
// end (call-host.human.spec.ts); these pin the wiring the e2e cannot see.
describe("a held line and the owner's utterance start", () => {
  const onLine = slice("const handleLine = (line: MicLine) => {", "offEnd = mic.onEnd(");

  it("I-1: the call counts as busy while a line is held, so nothing is said over it", () => {
    expect(source).toContain("const gated = () => !outputReady.current || heldRef.current || Boolean(heldLine.current?.holding);");
  });

  it("I-1: the rest of a held line never answers a card, and no line answers a card whose prompt is owed", () => {
    expect(onLine).toContain("const continuing = Boolean(heldLine.current?.holding);");
    expect(onLine).toContain("const open = continuing ? null : askedApproval.current;");
    expect(onLine).toContain("if (open && !(!open.submitted && unheard(open.requestId))) {");
    expect(onLine).toContain("const openQuestion = continuing ? null : askedQuestion.current;");
    expect(onLine).toContain("if (openQuestion && !unheard(openQuestion.requestId)) {");
    // "stop" after a held line takes it back; "hold on", "wait" and "pause"
    // keep it waiting for the rest (re-review m-3)
    expect(onLine).toMatch(/if \(continuing && STOP_ONLY\.test\(said\)\) \{\s*if \(!holdsOn\(said\)\) \{\s*heldLine\.current\?\.drop\("stop"\);/);
    expect(onLine).toMatch(/\} else \{\s*diag\("hold on: the held line waits for the rest"\);\s*heldLine\.current\?\.park\(\);\s*listen\(\);/);
  });

  it("I-1: a prompt cut by the call itself (not the owner, not a hold) is owed again", () => {
    const ask = slice("const askPrompt = useCallback(", "const sayQuietly = useCallback(");
    expect(ask).toMatch(/if \(gated\(\)( \|\| [^\n]*)?\) return owe\(\);/);
    expect(ask).toMatch(/sayThenListen\(text, \(\) => \{\s*if \(!alive\.current \|\| heldRef\.current \|\| ownerCutInAt\.current >= startedAt\) return;\s*owe\(\);/);
    const say = slice("const sayThenListen = useCallback(", "const sayThenListenRef = useRef(sayThenListen);");
    expect(say).toContain("if (!stillMine) onCut?.();");
  });

  it("I-1: without the host, what waited on a held line is said once it is sent", () => {
    expect(source).toMatch(/sendTurnRef\.current\(text, lineTiming\.current\);\s*if \(!hostOn\.current\) drainAfterHeldRef\.current\(\);/);
    expect(source).toContain("if (!gated() && (owed.current.length || deferredReplies.current.length)) listenOrCatchUp();");
  });

  it("I-2: every final or failed line ends the utterance's start, before any early return", () => {
    const top = onLine.indexOf("if (line.partial === false || line.error) utteranceBegan.current = 0;");
    expect(top).toBeGreaterThan(-1);
    expect(top).toBeLessThan(onLine.indexOf('diag("ignored (not listening, not talk-over)")'));
    expect(top).toBeLessThan(onLine.indexOf("if (line.error) {"));
    expect(top).toBeLessThan(onLine.indexOf('diag("dropped: no speech heard")'));
    // and nowhere later clears it a second way
    expect(onLine.match(/utteranceBegan\.current = 0/g)).toHaveLength(1);
  });

  it("I-2: a hold, a mute and a failed transcription clear it; the voice sets it only unmuted", () => {
    const hold = slice("const holdCall = useCallback(", "const resumeFromHold = useCallback(");
    expect(hold).toContain("utteranceBegan.current = 0;");
    expect(source).toMatch(/mutedRef\.current = next;\s*\/\/ muting drops a half-heard utterance: its start goes with it\s*utteranceBegan\.current = 0;/);
    expect(source).toContain("if (code !== 0) utteranceBegan.current = 0;");
    expect(source).toContain("if (speaking && !mutedRef.current && !utteranceBegan.current) utteranceBegan.current = Date.now();");
  });

  it("I-2 and ruling 2: a held line waits on speech begun after the pause, and its cap runs from the pause", () => {
    expect(source).toContain("(since) => Boolean(micRef.current?.pending()) || utteranceBegan.current >= since,");
    expect(onLine).toContain("heldLine.current!.take(joinTurn(said, began), line.endedAt, line.longEndpoint ? LONG_ENDPOINT_HOLD_MS : undefined)");
  });
});

// Re-review round 2 (voice-fixes-rereview.md m-1): a prompt that lands while
// the host fetches or speaks used to silence the host's reply while the reply
// was still recorded as said. It is owed now, and asked when the turn ends.
describe("a prompt landing during a host turn", () => {
  it("is owed while the host fetches or speaks, never read over it", () => {
    const ask = slice("const askPrompt = useCallback(", "const sayQuietly = useCallback(");
    expect(ask).toContain('if (gated() || (hostOn.current && (phaseRef.current === "sending" || hostSpeaking.current))) return owe();');
  });

  it("is asked when the host turn fails over to the engine, and after a stop", () => {
    const hostReply = slice("const hostReply = useCallback(", "const joinTurn = useCallback(");
    expect(hostReply).toMatch(/sendFromCall\(said, said\);(?:\s*\/\/[^\n]*\n)+\s*if \(owed\.current\.length \|\| \(hostOn\.current && duplex\(\)\)\) listenOrCatchUp\(\);\s*return;/);
    const onLine = slice("const handleLine = (line: MicLine) => {", "offEnd = mic.onEnd(");
    expect(onLine.match(/listenAskingOwed\(\);/g)).toHaveLength(3);
    expect(onLine).not.toMatch(/"\(stopped talking\)" \}\);\s*listen\(\);/);
  });
});

// moss-approval-bug.md item 1: the call is now mounted once at App.tsx's
// Shell level (App.test.ts pins that wiring) and told to collapse instead of
// unmounting when another thread is on screen. Everything above this point
// in the component — the mic, the turn loop, the native session — runs
// exactly the same either way; only the JSX returned at the very end
// changes. These tests pin that the collapsed branch exists, renders before
// the full screen, and never touches call state itself.
describe("collapsed: the call survives a thread switch (moss-approval-bug.md item 1)", () => {
  it("Call takes collapsed/onExpand, defaulting to a full, expanded screen", () => {
    expect(source).toMatch(
      /export function Call\(\{\s*bot,\s*collapsed = false,\s*onExpand,\s*\}: \{/,
    );
  });

  // callbar-review.md I4, I5: the bar itself is no longer Call's own JSX —
  // ChatView/GroupView render it (CallControls.tsx's CallBarStrip, pinned
  // in App.test.ts), reading the status this component publishes. Only the
  // "no slot mounted" fallback (I3) still renders a bar from here.
  it("publishes its live status for the strip, and clears it only on true unmount", () => {
    expect(source).toContain('import { publishCallBarState, type CallBarStatus } from "@/lib/call-bar";');
    expect(source).toMatch(
      /const barStatus: CallBarStatus = lost \? "lost" : held \? "paused" : connecting \? "connecting" : "live";/,
    );
    // The call's own frozen thread, not the bot's live one (callbar-rereview.md
    // N3): the strip hides only on the call's own thread, and its tap brings
    // that exact thread back.
    expect(source).toContain(
      'publishCallBarState({ targetId: bot.id, threadId: threadRef.current, name: bot.name, status: barStatus, kind: "bot" });',
    );
    expect(source).toMatch(
      /publishCallBarState\(\{ targetId: bot\.id, threadId: threadRef\.current, name: bot\.name, status: barStatus, kind: "bot" \}\);\s*\}, \[bot\.id, bot\.name, barStatus\]\);/,
    );
    expect(source).toContain("useEffect(() => () => publishCallBarState(null), []);");
  });

  it("portals its full screen into the on-screen chat/room column, never Shell's own container (I3)", () => {
    expect(source).toContain('import { createPortal } from "react-dom";');
    expect(source).toContain('import { useCallSlot } from "@/lib/call-slot";');
    expect(source).toContain("const slot = useCallSlot();");
    expect(source).toContain("return createPortal(fullScreen, slot);");
  });

  // The slot it portals into is pointer-events-none (ChatView.tsx), so an
  // empty slot never blocks the chat underneath — and pointer-events is an
  // inherited CSS property, so without this the whole call screen silently
  // stops taking clicks the moment it portals (found running the real
  // browser e2e case, not by source review alone).
  it("marks its own root pointer-events-auto, since the slot it portals into is pointer-events-none", () => {
    expect(source).toContain(
      '<div className="pointer-events-auto absolute inset-0 isolate z-30 flex flex-col items-center justify-center gap-6 bg-app/95 backdrop-blur-sm">',
    );
  });

  // callbar-rereview.md N2: when collapsed (or the bot's own thread
  // drifted) but no chat/room slot is mounted on screen at all — Routines,
  // the team map, the skill recorder, an empty state, another bot's
  // workspace — the call must still render its own fallback bar rather
  // than vanishing, since no other component is there to show one.
  it("effectiveCollapsed returns the fallback bar when no slot is mounted, and null when the strip elsewhere shows one (N2)", () => {
    const collapsedAt = source.indexOf("if (effectiveCollapsed) return slot ? null : fallbackBar;");
    const fullScreenAt = source.indexOf('<div className="pointer-events-auto absolute inset-0 isolate z-30 flex flex-col items-center justify-center gap-6 bg-app/95 backdrop-blur-sm">');
    expect(collapsedAt).toBeGreaterThan(-1);
    expect(fullScreenAt).toBeGreaterThan(collapsedAt);
  });

  it("falls back to a floating bar, built from the shared CallBarContent, whenever no slot is mounted -- collapsed or not (I3, M2, N2, N4)", () => {
    expect(source).toContain('import { CallBarContent } from "./CallBarContent";');
    const fallbackAt = source.indexOf("const fallbackBar = (");
    const collapsedReturnAt = source.indexOf("if (effectiveCollapsed) return slot ? null : fallbackBar;");
    const noSlotReturnAt = source.indexOf("if (!slot) return fallbackBar;");
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(collapsedReturnAt).toBeGreaterThan(fallbackAt);
    // Reachable from BOTH branches: collapsed with no slot (N2), and not
    // collapsed but no slot mounted yet (I3).
    expect(noSlotReturnAt).toBeGreaterThan(collapsedReturnAt);
    const fallback = source.slice(fallbackAt, source.indexOf("// Another thread or screen"));
    expect(fallback).toContain('data-testid="call-bar"');
    expect(fallback).toMatch(
      /<CallBarContent name=\{bot\.name\} status=\{barStatus\} onReturn=\{\(\) => onExpand\?\.\(\)\} onHangUp=\{\(\) => endCall\(bot\.id\)\} \/>/,
    );
  });

  it("Escape and Space are inert while effectively collapsed: another thread owns the keyboard", () => {
    const onKey = source.slice(
      source.indexOf("// Escape hangs up; space interrupts"),
      source.indexOf("}, [bot.id, effectiveCollapsed, listen]);"),
    );
    expect(onKey).toMatch(/const onKey = \(e: KeyboardEvent\) => \{\s*if \(effectiveCollapsed\) return;/);
  });

  // callbar-review.md M8: a push for another of this bot's own tasks moves
  // bot.threadId on the store while the call is still about its own
  // thread. threadRef must not track that live value, or the mic effect's
  // own [bot.threadId] dependency tears the call's listeners down over it.
  it("freezes threadRef at the call's own thread, and collapses (rather than tearing the mic down) when it drifts", () => {
    expect(source).not.toMatch(/threadRef\.current = bot\.threadId;/);
    expect(source).toMatch(/const threadRef = useRef\(bot\.threadId\);/);
    expect(source).toMatch(/const threadDrifted = bot\.threadId !== threadRef\.current;/);
    expect(source).toMatch(/const effectiveCollapsed = collapsed \|\| threadDrifted;/);
  });
});

// moss-approval-bug.md item 3: an open that never answers used to show
// "Listening" forever (CallView started in that phase and nothing timed the
// open out). "Connecting…" now owns the status line until real audio opens,
// and a hung open gets a retry note instead of silence.
describe("connecting: no silent 'Listening' before audio really opens (moss-approval-bug.md item 3)", () => {
  it("starts connecting, and only stops once begin() or a concrete open failure sets it", () => {
    expect(source).toContain("const [connecting, setConnecting] = useState(true);");
    // begin() is the only path that reaches a genuinely open call.
    const begin = source.slice(source.indexOf("const begin = (attempt: number) => {"), source.indexOf("const openCall = () => {"));
    expect(begin).toMatch(/outputReady\.current = true;\s*setConnecting\(false\);/);
  });

  it("\"Connecting…\" wins over \"Muted\"/\"Listening\" in the status line", () => {
    // decided in src/lib/call-status.ts and tested by behaviour there; this
    // screen hands it every input that decision takes
    expect(source).toContain("const status = callStatusText({ phase, held, connecting, muted, pushToTalk });");
  });

  it("gives up after CONNECT_TIMEOUT_MS and offers a retry note, only if still not open", () => {
    expect(source).toContain("const CONNECT_TIMEOUT_MS = 8_000;");
    expect(source).toMatch(
      /connectTimeout = setTimeout\(\(\) => \{\s*if \(cancelled \|\| attempt !== openAttempt\.current \|\| outputReady\.current\) return;\s*setNoteRetry\("open"\);\s*setNote\(CONNECT_TIMEOUT_NOTE\);\s*\}, CONNECT_TIMEOUT_MS\);/,
    );
    // cleared on unmount/cancel like every other timer in this effect
    expect(source).toMatch(/cancelled = true;\s*clearTimeout\(connectTimeout\);/);
  });

  // callbar-review.md M1: re-armed on every attempt, including a retry
  // (not just once, at mount), and the note clears on a late success —
  // otherwise "Still connecting" can outlive the open it was about, or sit
  // forever after a retry hangs a second time with nothing left to clear it.
  it("re-arms the timeout on every open attempt, including a retry, and clears a stale note on success", () => {
    const openCall = source.slice(source.indexOf("const openCall = () => {"), source.indexOf("retryOpen.current = () => {"));
    expect(openCall).toMatch(/openAttempt\.current \+= 1;\s*const attempt = openAttempt\.current;/);
    expect(openCall).toMatch(/clearTimeout\(connectTimeout\);/);
    const begin = source.slice(source.indexOf("const begin = (attempt: number) => {"), source.indexOf("const openCall = () => {"));
    expect(begin).toContain('setNote((prev) => (prev === CONNECT_TIMEOUT_NOTE ? null : prev));');
  });

  // callbar-review.md I2: a retry while the first attempt is still in
  // flight must close it first (or its eventual begin() would attach every
  // listener a second time) and never overwrite the retry's own state once
  // it resolves as the now-expected "closed" error.
  it("retryOpen closes the pending attempt before opening a fresh one, and begin()/attach() ignore a stale attempt", () => {
    const retryOpen = slice("retryOpen.current = () => {", "\n    return () => {\n      cancelled = true;");
    expect(retryOpen).toMatch(/setNoteRetry\("listen"\);\s*setNote\(null\);\s*setConnecting\(true\);/);
    expect(retryOpen).toContain("audioRef.current?.close();");
    const begin = source.slice(source.indexOf("const begin = (attempt: number) => {"), source.indexOf("const openCall = () => {"));
    expect(begin).toContain("if (cancelled || attempt !== openAttempt.current) return;");
    const openCall = source.slice(source.indexOf("const openCall = () => {"), source.indexOf("retryOpen.current = () => {"));
    expect(openCall).toContain('if ((error as { code?: unknown } | null)?.code === "closed") return;');
    // attach() itself is idempotent too: a defensive second layer if begin()
    // is ever reached twice for the same attempt.
    const attach = source.slice(source.indexOf("const attach = (mic: CallMic) => {"), source.indexOf("offTranscript = mic.onLine("));
    expect(attach).toContain("offTranscript();");
    expect(attach).toContain("offEnd();");
    expect(attach).toContain("offVoice();");
  });

  it("the retry note's copy follows the house style: no em dash, never \"safe\", no price talk, and does not presume a network problem", () => {
    const note = "Still connecting.";
    expect(source).toContain(`const CONNECT_TIMEOUT_NOTE = "${note}";`);
    expect(note).not.toMatch(/—/);
    expect(note).not.toMatch(/\bsafe\b/i);
    expect(note).not.toMatch(/\$|price|subscription/i);
    // callbar-review.md I2: a Mac or browser mic-permission prompt is not
    // "your connection" — the old copy named a cause this screen can't know.
    expect(note).not.toMatch(/connection/i);
  });
});

// callbar-rereview3.md A8. CallView cannot be mounted here (see the header), so
// this pins the shape that keeps the microphone effect from re-running: its
// dependency list holds say, tellReply, hostReply and openTurn, so each of
// those must read the bot's voice and name through refs, the way threadRef
// carries the thread, and must not list them as dependencies.
describe("the bot's voice and name are read through refs, so a settings edit mid-call never reopens the mic (A8)", () => {
  const openTurn = slice("const openTurn = useCallback(", "const listen = useCallback(");
  const say = slice("const say = useCallback(", "const sayThenListen");
  const tellReply = slice("const tellReply = useCallback(", "const tellNext = useRef(tellReply);");
  const hostReply = slice("const hostReply = useCallback(", "// \"Still on it\"");

  it("declares refs updated on every render", () => {
    expect(source).toMatch(/const voiceRef = useRef\(bot\.voice\);\s*voiceRef\.current = bot\.voice;/);
    expect(source).toMatch(/const nameRef = useRef\(bot\.name\);\s*nameRef\.current = bot\.name;/);
  });

  it("say, tellReply and hostReply speak with voiceRef.current and do not depend on bot.voice", () => {
    for (const body of [say, tellReply, hostReply]) {
      expect(body).toContain("voiceId: voiceRef.current");
      expect(body).not.toContain("voiceId: bot.voice");
      expect(body).not.toMatch(/\[[^\]]*bot\.voice[^\]]*\],?\s*$/m);
    }
  });

  it("openTurn hints with nameRef.current and does not depend on bot.name", () => {
    expect(openTurn).toContain("hints: [nameRef.current]");
    expect(openTurn).not.toContain("hints: [bot.name]");
    expect(openTurn).toContain("}, [bot.id]);");
  });
});

describe("hold and resume reach the streaming mic (Task 13)", () => {
  it("holdCall suspends the mic and resumeFromHold resumes it", () => {
    const hold = slice("const holdCall = useCallback(", "const resumeFromHold = useCallback(");
    expect(hold).toContain("micRef.current?.suspend?.();");
    const resume = slice("const resumeFromHold = useCallback(", "}, [holdCall]);");
    expect(resume).toContain("void micRef.current?.resume?.();");
  });
});

describe("dropped owner turns, round 1 (dropped-turns-review.md)", () => {
  const handler = slice("const handleLine = (line: MicLine)", "offEnd = mic.onEnd(");
  const openTurn = slice("const openTurn = useCallback(", "const listen = useCallback(");
  const onEnd = slice("offEnd = mic.onEnd(", "if (!alive.current || currentCall() !== bot.id) return;");
  const mute = slice("const next = !muted;", "if (!next && micRef.current");

  it("keeps the words in an UtteranceWords, never on the Flux path, and never the placeholder", () => {
    expect(source).toContain("const lastWordsRef = useRef(new UtteranceWords());");
    expect(handler).toMatch(/if \(mic\.kind !== "flux"\) lastWordsRef\.current\.push\(line\.text\);/);
    expect(handler).not.toMatch(/lastWordsRef\.current = line\.text/);
  });

  it("shows Flux's placeholder as the caption while the owner speaks, never remembering or sending it", () => {
    expect(handler).toMatch(/const shown = [^;]*;[^]*?setHeard\(shown \|\| \(line\.text\.trim\(\) === "…" \? "…" : ""\)\);/);
    expect(handler).toMatch(/heardRef\.current = line\.partial === false \? "" : shown;/);
    expect(handler).toContain("const said = shown.trim();");
  });

  it("clears the words on openTurn, onEnd, mute, and after every final or failed line", () => {
    expect(openTurn).toContain("lastWordsRef.current.clear();");
    expect(onEnd).toContain("lastWordsRef.current.clear();");
    expect(mute).toContain("lastWordsRef.current.clear();");
    expect(source).toMatch(/handleLine\(line\);\s*\} finally \{\s*[^]*?if \(line\.partial === false \|\| line\.error\) \{\s*lastWordsRef\.current\.clear\(\);\s*utteranceRejected\.current = false;/);
  });

  it("an empty final over the bot resumes the bot instead of cutting it off", () => {
    expect(handler).toMatch(/if \(bargeable && line\.partial === false && !line\.text\.trim\(\)\) \{\s*callTrace\("discard empty final talk-over"[^)]*\);\s*resumeBot\(\);\s*return;\s*\}/);
    expect(handler.indexOf("discard empty final talk-over")).toBeLessThan(handler.indexOf("talkOverVerdict({"));
  });

  it("judges a final on its endpoint wait and remembers a share rejection for the utterance", () => {
    expect(handler).toContain("endpointMs:");
    expect(handler).toContain("rejectedEarlier: utteranceRejected.current");
    expect(handler).toMatch(/utteranceRejected\.current = true/);
  });

  it("has no dead utteranceStart", () => {
    expect(source).not.toContain("utteranceStart");
  });
});

describe("the engine turn's timing stamp belongs to the engine's reply only", () => {
  const say = slice("const say = useCallback(", "const sayThenListen = useCallback(");
  const sayThenListen = slice("const sayThenListen = useCallback(", "const sayThenListenRef = useRef");
  const tellReply = slice("const tellReply = useCallback(", "const tellNext = useRef(tellReply);");

  it("say never takes the stamp itself, so an owed prompt, a still-on-it line or an approval prompt cannot", () => {
    expect(say).not.toContain("takeEngineTurn");
    expect(sayThenListen).not.toContain("takeEngineTurn");
    // the engine's reply hands its logger down explicitly
    expect(say).toContain("onPlaying");
    expect(sayThenListen).toMatch(/onPlaying\?: \(\) => void/);
  });

  it("tellReply takes it, after the gate, before either way of speaking, and hands it to the short path", () => {
    const gate = tellReply.indexOf("if (gated())");
    const take = tellReply.indexOf("takeEngineTurn()");
    const short = tellReply.indexOf("return sayThenListen(");
    expect(take).toBeGreaterThan(gate);
    expect(take).toBeLessThan(short);
    expect(tellReply).toMatch(/sayThenListen\(text, undefined, /);
    expect(tellReply.match(/takeEngineTurn\(\)/g)).toHaveLength(1);
  });

  it("the host's failed turn keeps its own sent time, and a hang-up drops a pending stamp", () => {
    expect(source).toContain("engineTurn.current = { ...timing, sentAt: turn.sentAt };");
    expect(source).toMatch(/alive\.current = false;\s*engineTurn\.current = null;/);
  });
});

describe("instant acknowledgement in the 1:1 call (speed plan task 15)", () => {
  const hostReply = slice("const hostReply = useCallback(", "// \"Still on it\"");
  const fireAck = slice("const fireAck = (key: AckKey) => {", "let spoken = \"\";");
  const joinTurn = slice("const joinTurn = useCallback(", "/** Send what the owner said");
  const bargeIn = slice("const bargeIn = useCallback(", "// Talking over the bot");
  const holdCall = slice("const holdCall = useCallback(", "// Navigating away from this bot hangs up.");

  it("warms the cue clips where the call warms the host, for this bot's voice and language", () => {
    expect(source).toMatch(/if \(hostOn\.current\) warmHost\(bot\.id\);[\s\S]{0,800}cueCache\.prewarm\(/);
    expect(source).toMatch(/cueCache\.prewarm\(\{[^}]*localeCode\(\)[^}]*keys/);
    expect(source).toContain("pickAck(");
  });

  it("arms the gate from the send time, and the first real sentence, a lookup and an engine fallback tell it", () => {
    expect(hostReply).toMatch(/gate\.start\(turn\.sentAt\)/);
    expect(hostReply).toMatch(/event\.type === "sentence"[\s\S]{0,200}gate\.realPiece\(\)/);
    expect(hostReply).toMatch(/event\.type === "lookup"[\s\S]{0,200}gate\.slow\("lookup"\)/);
    expect(hostReply).toMatch(/if \(failed && !handed && !spoken\) \{[\s\S]{0,600}gate\.slow\("engine"\)/);
    expect(hostReply).toMatch(/finally \{[\s\S]{0,200}gate\.cancel\(\)/);
  });

  it("plays one cue per turn: the spoken cue is skipped when the instant cue already played", () => {
    expect(fireAck).toMatch(/cueMayPlay\(\{[\s\S]{0,600}instantCued: instantCued\.current/);
    const effect = slice("if (phase === \"sending\" && was === \"listening\") {", "}, [phase, bot.id]);");
    expect(effect).toMatch(/instantCued\.current = cued/);
    expect(effect).toMatch(/else if \(phase === "listening"\) \{[\s\S]{0,120}instantCued\.current = false/);
  });

  it("plays the cue through the speaker's cue(), only when cueMayPlay says so", () => {
    expect(fireAck).toContain("cueMayPlay(");
    expect(fireAck).toMatch(/\.cue\(/);
    expect(fireAck).toContain("[call-diag] ack ");
    expect(fireAck).toMatch(/cached=\$\{cached \? "yes" : "no"\}/);
  });

  it("the cue never reaches the said text, the host's history, the call log or the deferred replies", () => {
    for (const forbidden of ["spoken", "hostHistory", "callLog", "deferredReplies", "turn.history", "turn.log"]) {
      expect(fireAck, forbidden).not.toContain(forbidden);
    }
    expect(source).not.toMatch(/hostHistory\.current\.push\([^)]*(cue|ack)/i);
    expect(source).not.toMatch(/(spoken \+= |callLog\.current\.push\()[^;]*(cue|ack)/i);
  });

  it("barge-in, a hold, hang-up and a join cancel the gate; a join hands its fired state to the next turn", () => {
    expect(bargeIn).toContain("ackGate.current?.cancel()");
    expect(holdCall).toContain("ackGate.current?.cancel()");
    expect(source).toMatch(/alive\.current = false;\s*engineTurn\.current = null;[\s\S]{0,200}ackGate\.current\?\.cancel\(\)/);
    expect(joinTurn).toContain("ackGate.current?.cancel()");
    expect(joinTurn).toMatch(/carriedAck\.current = [^;]*fired/);
    expect(hostReply).toMatch(/carriedAck\.current/);
  });

  it("a cue standing alone for an engine turn recovers the call when it ends, if the engine is already done or the host is on", () => {
    expect(hostReply).toMatch(
      /void own\.done\.finally\(\(\) => \{[\s\S]{0,200}if \(quiet && alive\.current && currentCall\(\) === bot\.id && sayGeneration\.current === mine && \(hostOn\.current \|\| !busyRef\.current\) && \(phaseRef\.current === "working" \|\| phaseRef\.current === "sending"\)\) listenOrCatchUp\(\);/,
    );
  });

  it("an engine cue is tracked, and an engine turn that finishes while it sounds stops it and listens at once", () => {
    expect(hostReply).toMatch(/if \(quiet\) engineCue\.current = stream/);
    expect(hostReply).toMatch(/if \(engineCue\.current === [a-z]+\) engineCue\.current = null/);
    const busyFalse = source.slice(source.indexOf("phaseRef.current === \"working\" &&\n      !askedApproval.current"), source.indexOf("// A push for another of this bot's own tasks"));
    expect(busyFalse).toMatch(/\(!speaker\.isSpeaking\(\) \|\| engineCue\.current\)/);
    expect(busyFalse).toMatch(/if \(engineCue\.current\) \{[\s\S]{0,200}sayGeneration\.current \+= 1;[\s\S]{0,120}hostSpeaking\.current = false;[\s\S]{0,120}speaker\.stop\(\);[\s\S]{0,200}listen\(\)/);
  });

  it("a host failure with reason upstream does not leave the call in sending: it listens while the engine works", () => {
    expect(hostReply).toMatch(/if \(owed\.current\.length \|\| \(hostOn\.current && duplex\(\)\)\) listenOrCatchUp\(\);/);
  });

  it("the screens call the cue helpers: the cue's end, a late cue, and the other-speech check", () => {
    expect(hostReply).toMatch(/const cueEnded = cueStream\.cue\(clip\)/);
    expect(hostReply).toMatch(/cueEnded\.then\([\s\S]{0,200}phaseAfterCue\(/);
    expect(hostReply).toMatch(/finally \{[\s\S]{0,1500}closed = !turnOver/);
    expect(hostReply).toMatch(/cueMayPlay\(\{[\s\S]{0,500}closed,/);
    expect(hostReply).toMatch(/otherSpeech: !stream && \(speaker\.isSpeaking\(\) \|\| hostSpeaking\.current\)/);
  });

  it("the cue is not the first clip: the turn's playingAt stays the stream's real clip", () => {
    expect(hostReply).toContain("playingAt: () => (stream as ReturnType<typeof speaker.stream> | null)?.playingAt() ?? null");
    expect(hostReply).toMatch(/ackAt: [^,]*cueAt\(\)/);
  });
});

describe("the voice host setting is read per render, not once at mount (final-review M6)", () => {
  it("hostOn follows the live config and a call-long switch-off, so a late config still gets the host", () => {
    expect(source).not.toMatch(/const hostOn = useRef\(Boolean\(state\.config/);
    expect(source).toMatch(/const hostOffForCall = useRef\(false\);/);
    expect(source).toMatch(/hostOn\.current = Boolean\(state\.config\?\.tts\?\.routes\?\.host\) && !hostOffForCall\.current;/);
    expect(source).toMatch(/if \(HOST_OFF_FOR_CALL\.has\(event\.reason\)\) \{\s*hostOffForCall\.current = true;\s*hostOn\.current = false;\s*\}/);
    });
  });

describe("a spoken yes goes through fresh authentication (SEC-006 Decision 7)", () => {
  const spoken = slice("const answer = approvalAnswer(said);", "// Not a decision: never guess consent from it.");
  const grant = slice("// allowed for the rest of this call: answered without asking again", "// held: asked (owed) now, heard when the call is back");

  it("the spoken decision gives the store the card on screen and the bot's name", () => {
    expect(spoken).toMatch(/type: "decideRequest"/);
    expect(spoken).toMatch(/card: open\.card/);
    expect(spoken).toMatch(/botName: bot\.name/);
  });

  it("a spoken allow is behavior allow, never an allow-task, and carries no proof of its own", () => {
    expect(spoken).toMatch(/behavior: allow \? "allow" : "deny"/);
    expect(spoken).not.toMatch(/allowForTask/);
    expect(spoken).not.toMatch(/freshAuth\s*:/);
  });

  it("a cancel is spoken kindly with no error toast, and a refusal is spoken in plain words", () => {
    expect(spoken).toMatch(/onError: \(error: string, code\?: FreshAuthCode\)/);
    expect(spoken).toMatch(/freshAuthSpoken\(code\)/);
    expect(spoken).toMatch(/pending\.submitted = false/);
    expect(spoken).not.toMatch(/showError|toast/i);
  });

  it("a failed yes for the rest of the call drops the grant for any failure, after the request guard", () => {
    const failure = spoken.slice(spoken.indexOf("onError:"));
    const guard = failure.indexOf("!pending.submitted");
    const drop = failure.indexOf("if (forCall) allowedForCall.current = false;");
    expect(guard).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(guard);
    expect(failure.indexOf("if (code)")).toBeGreaterThan(drop);
    expect(spoken.match(/allowedForCall\.current = true/g)?.length).toBe(1);
  });

  it("the rest-of-the-call sentence and flag wait for the decision to succeed, never before the prompt", () => {
    const before = spoken.slice(0, spoken.indexOf("dispatch({"));
    expect(before).not.toContain("FOR_CALL_SPOKEN");
    expect(before).not.toMatch(/allowedForCall\.current = true/);
    const success = spoken.slice(spoken.indexOf("onSuccess:"), spoken.indexOf("onError:"));
    expect(success).toMatch(/!forCall/);
    expect(success).toMatch(/allowedForCall\.current = true/);
    expect(success).toContain("sayThenListen(FOR_CALL_SPOKEN)");
    expect(success).toMatch(/!alive\.current/);
    expect(spoken.match(/FOR_CALL_SPOKEN/g)?.length).toBe(1);
  });

  it("on the grant re-ask a cancel adds no line of its own", () => {
    expect(grant).toMatch(/code && code !== "cancelled"/);
  });

  it("the call-long grant passes the card and the name, and speaks the same refusals", () => {
    expect(grant).toMatch(/behavior: "allow"/);
    expect(grant).not.toMatch(/allowForTask/);
    expect(grant).toMatch(/card: approval\.message\.card/);
    expect(grant).toMatch(/botName: bot\.name/);
    expect(grant).toMatch(/freshAuthSpoken\(code\)/);
  });

  it("CallView never posts an approval itself: every Allow goes through the store's decideRequest", () => {
    expect(source).not.toMatch(/(?:api|fetch)\([^)]*\/respond/);
    expect(source.match(/type: "decideRequest"/g)?.length).toBe(2);
  });
});
