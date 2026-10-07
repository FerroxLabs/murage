// Conference call mode — one microphone, several room members.
//
// Capture stays half-duplex for the same reason as one-to-one calls: the
// native recognizer has no acoustic echo cancellation. Bot replies are
// explicitly queued so a fast second member never cuts off the first.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, PhoneOff, X } from "lucide-react";

import { currentCall, deferCallCleanup, endCall } from "@/lib/call";
import { publishCallBarState } from "@/lib/call-bar";
import { freshAuthSpoken, type FreshAuthCode } from "@/lib/fresh-auth";
import { CallBarContent } from "./CallBarContent";
import { useCallSlot } from "@/lib/call-slot";
import { CALL_ENDPOINT_LONG_MS, CALL_ENDPOINT_MS, groupBusyStep } from "@/lib/call-turns";
import { dictationDisabledNote, isDictationDisabled } from "@/lib/dictation-notes";
import { OwnerLine } from "@/lib/group-call";
import { newSendId } from "@/lib/send-id";
import { blockStamp, groupTurnTiming, RoomReplyVoice, type ReplyVoice } from "@/lib/group-call-stream";
import { cueMemberFor, routeSpokenGroupMessage } from "@/lib/group-call";
import { HOST_OFF_FOR_CALL, hostTurn, plainFailure, warmHost, type CallHandDown } from "@/lib/voice-host";
import { cancelWaitingHandDowns, expireFloorLine, FLOOR_MAX_MS, handDownMessage, interruptHandDowns, OwnerFloor, RoomHostMemory, roomHostMember, spokenToMember } from "@/lib/room-host";
import { ACK_KEYS, AckGate, cueMayPlay, phaseAfterCue, roomOtherSpeech, type AckKey } from "@/lib/call-ack";
import { localeCode, t } from "@/lib/i18n";
import { CueCache } from "@/lib/tts/cue-cache";
import { unheardMessages } from "@/lib/scrollback";
import { normalizeState } from "@/lib/mascot";
import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";
import { usePushToTalk } from "@/lib/push-to-talk";
import { useStore, useStreaming, type Bot, type Group, type Message, type OptionCardData } from "@/state/store";
import { cn } from "@/lib/cn";
import { MemberCallAvatar } from "./CallAvatar";
import { stillSignals, useAvatarAura } from "./CallAura";
import { CallMood } from "./CallMood";
import { ReadAlong } from "./ReadAlong";
import { botVoice } from "@/lib/audio-level";
import { auraPhaseFor } from "@/lib/call-aura";
import { useKeyboardHints } from "@/lib/use-keyboard-hints";
import { isRoutineApproval, isSkillApproval, pendingApprovals, spokenApprovalPrompt } from "./PendingApproval";

/** Pre-synthesized acknowledgement clips, kept across calls (see call-ack.ts). */
const cueCache = new CueCache((text, o) => speaker.fetchClip(text, o));

const YES = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|allow|approve|approved|fine|please do)\b/i;
const NO = /^(no|nope|don'?t|do not|stop|deny|denied|cancel|never|skip it)\b/i;

type Phase = "listening" | "sending" | "working" | "speaking";

function questionIn(messages: Message[]): Message | undefined {
  return messages.find(
    (message) =>
      message.kind === "options" &&
      message.card?.requestId &&
      !message.card.tool &&
      !message.card.answered &&
      !message.card.dismissed,
  );
}

export function GroupCall({
  group,
  members,
  collapsed = false,
  onExpand,
}: {
  group: Group;
  members: Bot[];
  /** Another thread or screen is on top; the call keeps running (App.tsx
   *  mounts this once per call, not once per selected chat — see Call in
   *  CallView.tsx for the same pattern). */
  collapsed?: boolean;
  onExpand?: () => void;
}) {
  const { state, dispatch } = useStore();
  const liveText = useStreaming().streaming;
  // Fixed for the call's lifetime, never the live group.threadId — the same
  // freeze as CallView.tsx's threadRef, for the same reason
  // (callbar-rereview.md N3).
  const threadRef = useRef(group.threadId);
  // A push for another of this room's own tasks moves `group.threadId`
  // while the call is still about its own thread: collapse rather than
  // leaving the full screen up over the approval it was opened for, same
  // as CallView.tsx's bot calls (callbar-rereview2.md G1).
  const threadDrifted = group.threadId !== threadRef.current;
  const effectiveCollapsed = collapsed || threadDrifted;
  const speech = useSpeech();
  const initialPhase: Phase = group.working || group.busyBotId ? "working" : "listening";
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [heard, setHeard] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [speakingMemberId, setSpeakingMemberId] = useState<string | null>(null);
  // The live voices the visuals read (CallAura.tsx, CallMood.tsx). A room
  // call always plays through the window's own player, so the bot's clips
  // are tapped for the call's lifetime. The owner's level here comes from
  // dictation pulses only (signals.owner.pulse() below): the room is the Mac
  // bridge, which reports words, not levels. A browser room would wire the
  // capture's onLevel into signals.owner.push, as CallView does.
  const [signals] = useState(() => stillSignals());
  useEffect(() => botVoice.attach(), []);
  const readAlongProgress = useCallback((chars: number) => botVoice.progress(chars), []);
  const pushToTalk = usePushToTalk(group.id, phase === "listening", () => {
    setNote("Push to talk couldn't start. Check Microphone and Speech Recognition access.");
  });

  const messages = group.messages;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const approval = pendingApprovals(messages)[0];
  const question = questionIn(messages);
  const membersRef = useRef(members);
  const busyRef = useRef(Boolean(group.working || group.busyBotId));
  const busyBotRef = useRef<string | null>(group.busyBotId ?? null);
  busyBotRef.current = group.busyBotId ?? null;
  /** The acknowledgement gate of the owner's newest line, and whether the
   *  reply has started writing (then no cue); the cue used last. */
  const ackGate = useRef<AckGate | null>(null);
  const ackTurn = useRef(0);
  const replyStarted = useRef(false);
  const lastAck = useRef<AckKey | null>(null);
  /** The voice host answers a line meant for one member (src/lib/room-host.ts);
   *  off for the rest of the call after a failure that will not fix itself. */
  const configRef = useRef(state.config);
  configRef.current = state.config;
  const hostDisabled = useRef(false);
  /** Read per turn: a call started before the config loads still gets the fast voice once it does. */
  const hostEnabled = useCallback(() => Boolean(configRef.current?.tts?.routes?.host) && !hostDisabled.current, []);
  const hostMemory = useRef(new RoomHostMemory());
  const hostAbort = useRef<AbortController | null>(null);
  /** The owner has the floor while their words come in: the room's speech
   *  waits for it (src/lib/room-host.ts OwnerFloor). */
  const expireOwnerLine = useRef<(line: string) => void>(() => {});
  const floor = useRef(new OwnerFloor(FLOOR_MAX_MS, (line) => expireOwnerLine.current(line)));
  const defaultResponderRef = useRef(group.defaultResponder);
  membersRef.current = members;
  if (group.threadId === threadRef.current) busyRef.current = Boolean(group.working || group.busyBotId);
  defaultResponderRef.current = group.defaultResponder;

  const spokenIds = useRef<Set<string>>(new Set());
  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    for (const message of messages) spokenIds.current.add(message.id);
  }

  const askedApproval = useRef<{
    requestId: string;
    /** The card as read aloud: the proof is checked against exactly this. */
    card?: OptionCardData;
    member?: Bot;
    routine: boolean;
    skill: boolean;
    submitted: boolean;
  } | null>(null);
  const askedQuestion = useRef<{ requestId: string; member?: Bot } | null>(null);
  const phaseRef = useRef<Phase>(initialPhase);
  const alive = useRef(true);
  const sayGeneration = useRef(0);
  const queueGeneration = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const queuedJobs = useRef(new Set<number>());
  const nextJobId = useRef(0);
  const listenWhenDrained = useRef(false);
  const listenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const allowBargeIn = useRef(false);
  /** The handed-down engine turn: seen working, and finished again. A turn
   *  that ended before the host's reply resolved must not reopen barge-in. */
  const handDownWork = useRef({ seen: false, done: false });
  // The owner's line, held while it sounds unfinished so its second half
  // joins it into ONE message to the room (src/lib/group-call.ts OwnerLine).
  const sendSpokenRef = useRef<(said: string) => void>(() => {});
  const ownerLine = useRef<OwnerLine | null>(null);
  if (!ownerLine.current) ownerLine.current = new OwnerLine((said) => sendSpokenRef.current(said));
  // The member's reply spoken as it is written (src/lib/group-call-stream.ts).
  const openVoiceRef = useRef<(member?: Bot) => ReplyVoice>(() => ({ push() {}, end() {} }));
  const roomVoice = useRef<RoomReplyVoice<Bot> | null>(null);
  /** Stamps for the `[call-diag] group turn timing` line: when the owner's
   *  line was sent, and when the member now writing first wrote text. */
  const turnStamps = useRef<{ sentAt: number; block: { memberId: string; at: number } | null } | null>(null);
  if (!roomVoice.current) roomVoice.current = new RoomReplyVoice<Bot>((member) => openVoiceRef.current(member));

  const move = useCallback((next: Phase) => {
    phaseRef.current = next;
    if (alive.current) setPhase(next);
  }, []);

  const hush = useCallback(() => {
    void window.muragebox?.speechStop();
  }, []);

  const listen = useCallback(() => {
    if (!alive.current || currentCall() !== group.id) return;
    move("listening");
    setSpeakingMemberId(null);
    setHeard("");
    setNote(null);
    void window.muragebox?.speechStart({ endpointMs: CALL_ENDPOINT_MS, endpointLongMs: CALL_ENDPOINT_LONG_MS }).catch(() => {
      if (alive.current && currentCall() === group.id) {
        setNote("The microphone couldn't start. Check Microphone and Speech Recognition access.");
      }
    });
  }, [group.id, move]);

  const scheduleListen = useCallback(
    (force = false, delay = 140) => {
      if (listenTimer.current) clearTimeout(listenTimer.current);
      listenTimer.current = setTimeout(() => {
        listenTimer.current = null;
        if (!alive.current || currentCall() !== group.id || queuedJobs.current.size) return;
        if (force || allowBargeIn.current || !busyRef.current) listen();
      }, delay);
    },
    [group.id, listen],
  );

  const say = useCallback(
    async (text: string, member?: Bot) => {
      if (!alive.current || currentCall() !== group.id) return false;
      const mine = ++sayGeneration.current;
      move("speaking");
      setSpeakingMemberId(member?.id ?? null);
      hush();
      await speaker.speak(text, { botId: member?.id, voiceId: member?.voice });
      return alive.current && currentCall() === group.id && sayGeneration.current === mine;
    },
    [group.id, hush, move],
  );

  const enqueueJob = useCallback(
    (run: () => Promise<unknown>, answerAfter = false) => {
      const generation = queueGeneration.current;
      const jobId = ++nextJobId.current;
      queuedJobs.current.add(jobId);
      if (answerAfter) listenWhenDrained.current = true;
      queue.current = queue.current
        .catch(() => {})
        .then(async () => {
          if (generation !== queueGeneration.current) return;
          await floor.current.wait();
          if (generation !== queueGeneration.current) return;
          await run();
        })
        .finally(() => {
          if (generation !== queueGeneration.current) return;
          queuedJobs.current.delete(jobId);
          if (queuedJobs.current.size) return;
          setSpeakingMemberId(null);
          const force = listenWhenDrained.current;
          listenWhenDrained.current = false;
          scheduleListen(force);
        });
    },
    [scheduleListen],
  );

  const enqueueSpeech = useCallback(
    (text: string, member?: Bot, answerAfter = false) => enqueueJob(() => say(text, member), answerAfter),
    [enqueueJob, say],
  );

  /** A member's voice for one text block: a speaker stream that opens when
   *  its turn in the queue comes (so the member before is never cut off),
   *  with whatever was written meanwhile waiting for it. */
  const openVoice = useCallback(
    (member?: Bot, answerAfter = false) => {
      const buffered: string[] = [];
      let finished = false;
      let live: ReturnType<typeof speaker.stream> | null = null;
      // the timing line's stamps, taken when this block's first clip is asked for
      const stamps = turnStamps.current;
      const firstTextAt = stamps?.block?.memberId === member?.id ? stamps?.block?.at ?? null : null;
      const firstClipAt = Date.now();
      let firstChars = 0;
      enqueueJob(async () => {
        if (!alive.current || currentCall() !== group.id) return;
        sayGeneration.current += 1;
        move("speaking");
        setSpeakingMemberId(member?.id ?? null);
        hush();
        live = speaker.stream({ botId: member?.id, voiceId: member?.voice });
        for (const sentence of buffered.splice(0)) live.push(sentence);
        if (finished) live.end();
        await live.done;
        if (stamps && alive.current) {
          console.warn(
            groupTurnTiming({ sentAt: stamps.sentAt, firstTextAt, firstClipAt, playingAt: live.playingAt(), piece: firstChars ? "sentence" : null, pieceChars: firstChars }),
          );
        }
      }, answerAfter);
      return {
        push: (sentence: string) => {
          firstChars ||= sentence.length;
          return live ? live.push(sentence) : buffered.push(sentence);
        },
        end: () => {
          finished = true;
          live?.end();
        },
      };
    },
    [enqueueJob, group.id, hush, move],
  );

  openVoiceRef.current = openVoice;

  const interruptSpeech = useCallback(() => {
    const wasBusy = busyRef.current;
    ackGate.current?.cancel();
    hostAbort.current?.abort();
    hostAbort.current = null;
    floor.current.release();
    ackTurn.current += 1;
    queueGeneration.current += 1;
    queue.current = Promise.resolve();
    queuedJobs.current.clear();
    listenWhenDrained.current = false;
    sayGeneration.current += 1;
    // the rest of the interrupted turn (deltas still on their way) is not
    // spoken, and nothing may close the microphone this opens
    roomVoice.current!.interrupt(wasBusy);
    ownerLine.current!.drop();
    speaker.stop();
    setSpeakingMemberId(null);
    allowBargeIn.current = true;
    if (wasBusy) dispatch({ type: "interruptGroup", groupId: group.id });
    listen();
  }, [dispatch, group.id, listen]);

  useEffect(() => {
    alive.current = true;
    // wake the host model once; any member's route reaches the same one
    if (hostEnabled() && membersRef.current[0]) warmHost(membersRef.current[0].id);
    return () => {
      alive.current = false;
      queueGeneration.current += 1;
      sayGeneration.current += 1;
      ackGate.current?.cancel();
      hostAbort.current?.abort();
      floor.current.release();
      if (listenTimer.current) clearTimeout(listenTimer.current);
      ownerLine.current?.drop();
      roomVoice.current?.end();
      deferCallCleanup(group.id, () => alive.current);
    };
  }, [group.id]);

  /** A short acknowledgement in the voice of the member answering, when the
   *  reply is slow. Only once that voice is known, and only into an idle
   *  room (never over a member speaking). A cue-only stream through the
   *  speech queue: it is not a message and goes nowhere near the thread. */
  const cueRoom = useCallback((key: AckKey, member: Bot | undefined, turnId: number) => {
    if (!member) return;
    const firedAt = Date.now();
    const voiceId = member.voice;
    const cached = cueCache.get({ botId: member.id, voiceId, locale: localeCode(), key });
    lastAck.current = key;
    console.warn(`[call-diag] group ack ${key} cached=${cached ? "yes" : "no"}`);
    const mayPlay = (inJob: boolean) =>
      cueMayPlay({
        live: alive.current && currentCall() === group.id && ackTurn.current === turnId,
        superseded: false,
        held: false,
        realStarted: replyStarted.current,
        otherSpeech: roomOtherSpeech({ queuedJobs: queuedJobs.current.size, inJob, speaking: speaker.isSpeaking() }),
        closed: false,
        ageMs: Date.now() - firedAt,
      });
    const play = (clip: Blob) => {
      if (!mayPlay(false)) return;
      enqueueJob(async () => {
        if (!alive.current || currentCall() !== group.id || !mayPlay(true)) return;
        // the owner has the floor: a cue must never close an open mic
        if (phaseRef.current === "listening") return;
        sayGeneration.current += 1;
        move("speaking");
        setSpeakingMemberId(member.id);
        hush();
        const cueStream = speaker.stream({ botId: member.id, voiceId });
        cueStream.cue(clip);
        cueStream.end();
        await cueStream.done;
        // out of "speaking" once the cue is over: a member still busy is
        // "working", and the mic reopens from there when the turn ends
        const back = phaseAfterCue({ live: alive.current && currentCall() === group.id && ackTurn.current === turnId, realStarted: replyStarted.current, phase: phaseRef.current, busy: busyRef.current });
        if (back) move(back);
      });
    };
    if (cached) play(cached);
    else
      void speaker.fetchClip(t(key), { botId: member.id, voiceId }).then((clip) => {
        cueCache.put({ botId: member.id, voiceId, locale: localeCode(), key }, clip);
        play(clip);
      }, () => undefined);
  }, [enqueueJob, group.id, hush, move]);

  /** The owner's line to the room engines, as before the voice host. */
  const sendToRoom = useCallback(
    (text: string) => {
      if (!alive.current || currentCall() !== group.id) return;
      allowBargeIn.current = false;
      move(busyRef.current ? "working" : "sending");
      hush();
      const sentAt = Date.now();
      turnStamps.current = { sentAt, block: null };
      // a slow reply is cued (call-ack.ts); the gate starts from the send
      ackGate.current?.cancel();
      replyStarted.current = false;
      const turnId = ++ackTurn.current;
      const gate = new AckGate({ fire: (key) => cueRoom(key, cueMemberFor(text, membersRef.current, busyBotRef.current), turnId), last: lastAck.current, keys: ACK_KEYS });
      ackGate.current = gate;
      gate.start(sentAt);
      dispatch({ type: "sendGroup", groupId: group.id, text, threadId: threadRef.current });
      scheduleListen(false, 600);
    },
    [cueRoom, dispatch, group.id, hush, move, scheduleListen],
  );

  /** One member answers through the voice host (server/voice/voice-host.ts):
   *  its sentences go through the room's speech queue, a hand-down becomes an
   *  ordinary room message to that member, and any failure sends the owner's
   *  words to the room engines as before. */
  const hostReply = useCallback(
    async (routedText: string, member: Bot, ownerWords: string) => {
      if (!alive.current || currentCall() !== group.id) return;
      allowBargeIn.current = false;
      move("sending");
      hush();
      const controller = new AbortController();
      hostAbort.current?.abort();
      hostAbort.current = controller;
      const sentAt = Date.now();
      turnStamps.current = { sentAt, block: null };
      ackGate.current?.cancel();
      replyStarted.current = false;
      const turnId = ++ackTurn.current;
      const gate = new AckGate({ fire: (key) => cueRoom(key, member, turnId), last: lastAck.current, keys: ACK_KEYS });
      ackGate.current = gate;
      gate.start(sentAt);
      const memory = hostMemory.current;
      const owner = spokenToMember(routedText, member);
      const live = () => alive.current && currentCall() === group.id && ackTurn.current === turnId;
      const turn = { voice: null as ReplyVoice | null, spoken: "", handed: null as { id: string; request: string; sendId: string } | null, failed: false };
      await hostTurn(
        member.id,
        {
          text: owner,
          groupId: group.id,
          threadId: threadRef.current,
          history: memory.history(member.id),
          handDowns: memory.handDowns(member.id),
          roomHeard: memory.heardBy(member.id),
        },
        (event) => {
          if (!live()) return;
          if (event.type === "sentence") {
            replyStarted.current = true;
            gate.realPiece();
            if (!turn.voice) {
              if (turnStamps.current) turnStamps.current.block = { memberId: member.id, at: Date.now() };
              turn.voice = openVoice(member, true);
            }
            turn.spoken += `${event.text} `;
            turn.voice.push(event.text);
          } else if (event.type === "lookup") {
            gate.slow("lookup");
          } else if (event.type === "hand_down" && !turn.handed) {
            // What is sent is the owner's own words for this turn, verbatim
            // (handDownMessage): the host's request is model output and never
            // decides it. No owner words behind it, nothing is sent.
            const message = handDownMessage(ownerWords, event.request);
            if (!message) return;
            const handed = { id: crypto.randomUUID(), request: message.text, sendId: newSendId() };
            turn.handed = handed;
            handDownWork.current = { seen: false, done: false };
            const record: CallHandDown = { ...handed, at: Date.now(), state: "sending" };
            memory.addHandDown(member.id, record);
            dispatch({
              type: "sendGroup",
              groupId: group.id,
              text: message.text,
              sendId: handed.sendId,
              threadId: threadRef.current,
              responderId: member.id,
              onReceipt: (receipt) => {
                // keep the receipt on the record: the harness reconciles it
                memory.updateHandDown(member.id, handed.id, { state: "accepted", queued: receipt.queued, ...(receipt.requestId ? { requestId: receipt.requestId } : {}) });
              },
              onError: (error: unknown) => {
                const reason = plainFailure(error instanceof Error ? error.message : String(error));
                memory.updateHandDown(member.id, handed.id, { state: "refused", reason });
                if (alive.current && currentCall() === group.id) enqueueSpeech(`I couldn't start that. ${reason}`, member, true);
                return true;
              },
            });
          } else if (event.type === "cancel") {
            // this member's own work only: its running turn, or its request
            // still waiting in the room's queue (another member may be busy)
            const act = dispatch as (action: Record<string, unknown>) => void;
            cancelWaitingHandDowns(memory, member.id, { groupId: group.id, threadId: threadRef.current ?? group.threadId }, act);
            if (busyBotRef.current === member.id) interruptHandDowns(memory, member.id, { groupId: group.id }, messagesRef.current, act);
          } else if (event.type === "error") {
            turn.failed = true;
            if (HOST_OFF_FOR_CALL.has(event.reason)) hostDisabled.current = true;
          }
        },
        controller.signal,
      );
      if (hostAbort.current === controller) hostAbort.current = null;
      gate.cancel();
      if (!live()) return;
      if (turn.failed && !turn.handed && !turn.spoken.trim()) return void sendToRoom(routedText);
      if (turn.handed && !turn.spoken.trim()) {
        turn.voice = openVoice(member, true);
        turn.voice.push("On it.");
        turn.spoken = "On it.";
      }
      turn.voice?.end();
      if (turn.failed && !turn.handed) enqueueSpeech("Sorry, I lost my train of thought.", member, true);
      memory.record(member, owner, { role: "host", text: turn.spoken.trim(), ...(turn.handed ? { handDown: turn.handed } : {}) });
      // the member's engine is on it: the owner may talk to the room meanwhile
      if (turn.handed && !handDownWork.current.done) allowBargeIn.current = true;
      if (!turn.voice) scheduleListen(true);
    },
    [cueRoom, dispatch, enqueueSpeech, group.id, hush, move, openVoice, scheduleListen, sendToRoom],
  );

  /** Send what the owner said, whole: to one member's voice, or to the room. */
  const sendSpoken = useCallback(
    (said: string) => {
      try {
        if (!alive.current || currentCall() !== group.id) return;
        const routed = routeSpokenGroupMessage(said, membersRef.current);
        if (defaultResponderRef.current.kind === "mentions" && !routed.addressed) {
          listen();
          const names = membersRef.current.map((member) => member.name).join(", ");
          setNote("Say a member's name" + (names ? " (" + names + ")" : "") + ", or say everyone.");
          return;
        }
        const member = hostEnabled() ? roomHostMember(routed.text, membersRef.current, { defaultResponder: defaultResponderRef.current, dm: group.dm }) : null;
        if (member) return void hostReply(routed.text, member, said);
        sendToRoom(routed.text);
      } finally {
        floor.current.release();
      }
    },
    [group.dm, group.id, hostEnabled, hostReply, listen, sendToRoom],
  );
  sendSpokenRef.current = sendSpoken;
  // The floor's quiet cap: the line heard so far is finalised, never dropped.
  expireOwnerLine.current = (line) => {
    // An open approval or question keeps the line (expireFloorLine): the
    // recognizer's own final line still reaches its handler.
    expireFloorLine({
      live: alive.current && currentCall() === group.id,
      listening: phaseRef.current === "listening",
      approvalOpen: Boolean(askedApproval.current),
      questionOpen: Boolean(askedQuestion.current),
      line,
      final: (l) => ownerLine.current!.final(l),
      send: (said) => sendSpokenRef.current(said),
    });
  };

  useEffect(() => {
    const bridge = window.muragebox;
    if (!bridge) return;
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (!alive.current || currentCall() !== group.id || phaseRef.current !== "listening") return;
      if (line.error) {
        setNote("Dictation stopped unexpectedly. Check Microphone and Speech Recognition access.");
        return;
      }
      if (typeof line.text !== "string") return;
      setHeard(line.text);
      // a new partial: the owner is talking (the aura's listening ripple)
      if (line.partial !== false) signals.owner.pulse();
      if (line.partial !== false) ownerLine.current!.partial(line.text);
      // words are coming in: a reply waits for the owner's line
      if (line.partial !== false && line.text.trim()) floor.current.take(line.text);
      if (line.partial !== false) return;
      const said = line.text.trim();
      // the line is over unless it waits for its second half (OwnerLine),
      // which sendSpoken releases when it goes out
      if (!said || askedApproval.current || askedQuestion.current) floor.current.release();
      if (!said) return listen();

      const openApproval = askedApproval.current;
      if (openApproval) {
        if (openApproval.submitted) {
          move("working");
          hush();
          return;
        }
        if (YES.test(said) || NO.test(said)) {
          const allow = YES.test(said);
          if (allow && openApproval.skill) {
            setHeard("");
            enqueueSpeech(
              "Open the channel chat to review the complete skill before enabling it. You can say no now to deny it.",
              openApproval.member,
              true,
            );
            return;
          }
          // Hold this approval in-flight until its server patch arrives so a
          // slow response cannot reopen the microphone and submit it twice.
          openApproval.submitted = true;
          allowBargeIn.current = false;
          move("working");
          hush();
          setHeard("");
          dispatch({
            type: "decideRequest",
            threadId: threadRef.current,
            requestId: openApproval.requestId,
            behavior: allow ? "allow" : "deny",
            message: allow ? undefined : "Denied by the user, on a group call.",
            card: openApproval.card,
            botName: openApproval.member?.name,
            onError: (error: string, code?: FreshAuthCode) => {
              const pending = askedApproval.current;
              if (
                !alive.current ||
                currentCall() !== group.id ||
                pending?.requestId !== openApproval.requestId ||
                !pending.submitted
              ) return;
              pending.submitted = false;
              // A refused or cancelled phone prompt (SEC-006 Decision 7): said plainly, the card stays pending.
              if (code) {
                enqueueSpeech(freshAuthSpoken(code), openApproval.member, true);
                return;
              }
              const detail = error.trim().slice(0, 240);
              const decision = openApproval.routine ? "routine decision" : "approval";
              enqueueSpeech(
                `I couldn't save that ${decision}${detail ? `: ${detail}` : "."} Please try again.`,
                openApproval.member,
                true,
              );
            },
          });
          return;
        }
        enqueueSpeech("Sorry, is that a yes or a no?", openApproval.member, true);
        return;
      }

      const openQuestion = askedQuestion.current;
      if (openQuestion) {
        askedQuestion.current = null;
        allowBargeIn.current = false;
        dispatch({
          type: "decideRequest",
          threadId: threadRef.current,
          requestId: openQuestion.requestId,
          behavior: "answer",
          message: said,
        });
        move("working");
        return;
      }

      // A line that stops mid-clause waits for the rest. The microphone is
      // already reopening (onSpeechEnd below), so the second half is heard
      // and joins it; a line that is whole goes straight out.
      const whole = ownerLine.current!.final(said);
      if (whole === null) return;
      sendSpokenRef.current(whole);
    });
    const offEnd = bridge.onSpeechEnd(({ code, reason }) => {
      if (!alive.current || currentCall() !== group.id) return;
      if (code === 2) {
        setNote("Calls need macOS dictation, which isn't available here yet.");
        return;
      }
      if (code === 1) {
        setNote(
          reason === "helper-build-failed"
            ? "The dictation helper couldn't be built. Install Apple's Command Line Tools and try again."
            : reason === "helper-stop-pending"
              ? "The previous dictation session is still closing. Try again in a moment."
              : isDictationDisabled(reason)
                ? dictationDisabledNote()
                : "Dictation needs Microphone + Speech Recognition access in System Settings.",
        );
        return;
      }
      if (phaseRef.current === "listening") listen();
    });
    if ((group.working || group.busyBotId) && !approval && !question) move("working");
    else listen();
    return () => {
      offTranscript();
      offEnd();
      void window.muragebox?.speechStop();
    };
    // Live busy/card changes are handled below without restarting native capture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, enqueueSpeech, group.id, hush, listen, move, scheduleListen]); // threadRef is a ref

  const writing = liveText[threadRef.current] ?? "";
  useEffect(() => {
    // The member's text as it is written: each finished sentence is spoken
    // at once, so first audio follows the first sentence, not the whole
    // block. Only the call's own thread, and only for the member working.
    if (group.threadId !== threadRef.current) return;
    if (writing && (askedApproval.current || askedQuestion.current)) return;
    if (writing) {
      replyStarted.current = true;
      ackGate.current?.realPiece();
    }
    const member = members.find((candidate) => candidate.id === group.busyBotId);
    const stamps = turnStamps.current;
    if (stamps) blockStamp(stamps, member?.id, writing, Date.now());
    roomVoice.current!.update(member, writing);
  }, [group.busyBotId, group.threadId, members, writing]);

  useEffect(() => {
    // `approval`/`question`/`messages` are read from the room's LIVE
    // thread, not necessarily the call's own (frozen) one. While drifted,
    // asking about or deciding one of those would send the call's own
    // threadId alongside a requestId that belongs to the OTHER thread —
    // worse than doing nothing (CallView.tsx's identical guard,
    // callbar-rereview2.md G1). The call is already collapsed to the bar
    // for exactly this case.
    if (group.threadId !== threadRef.current) return;
    let resumeAfterRoutine = false;
    if (askedApproval.current && approval?.requestId !== askedApproval.current.requestId) {
      resumeAfterRoutine = askedApproval.current.routine && askedApproval.current.submitted;
      askedApproval.current = null;
    }
    if (askedQuestion.current && question?.card?.requestId !== askedQuestion.current.requestId) {
      askedQuestion.current = null;
    }

    if (resumeAfterRoutine && !approval && !question && !group.working && !group.busyBotId) {
      scheduleListen(true);
      return;
    }
    // Keep the voice queue and microphone closed until this exact decision
    // is settled or its request reports an error.
    if (askedApproval.current?.submitted) return;

    if (approval && askedApproval.current?.requestId !== approval.requestId) {
      const member = members.find((candidate) => candidate.id === approval.message.from?.botId);
      // a prompt must never wait behind a reply still being written
      roomVoice.current!.end();
      askedApproval.current = {
        requestId: approval.requestId,
        card: approval.message.card,
        member,
        routine: isRoutineApproval(approval),
        skill: isSkillApproval(approval),
        submitted: false,
      };
      spokenIds.current.add(approval.message.id);
      const name = member?.name ?? approval.message.from?.name ?? "A channel member";
      const skillPrompt = approval.message.card?.skillRequest?.action === "update"
        ? `${name} wants to update a learned skill. Open the channel chat to review the complete skill before replacing the current version. You can say no to deny it.`
        : `${name} wants to enable a new learned skill. Open the channel chat to review the complete skill before enabling it. You can say no to deny it.`;
      enqueueSpeech(isSkillApproval(approval) ? skillPrompt : spokenApprovalPrompt(approval, name), member, true);
    }

    if (question?.card?.requestId && askedQuestion.current?.requestId !== question.card.requestId) {
      const member = members.find((candidate) => candidate.id === question.from?.botId);
      roomVoice.current!.end();
      askedQuestion.current = { requestId: question.card.requestId, member };
      spokenIds.current.add(question.id);
      const name = member?.name ?? question.from?.name ?? "A channel member";
      const detail = question.card.subtitle.trim();
      const choices = question.card.options.length
        ? " The options are " + question.card.options.join(", ") + "."
        : "";
      enqueueSpeech(
        name + " asks: " + detail + (/[.!?]$/.test(detail) ? "" : ".") + choices,
        member,
        true,
      );
    }

    // unheardMessages: a scrollback page loaded mid-call is not news.
    const fresh = unheardMessages(messages, spokenIds.current);
    if (!fresh.length) return;
    for (const message of fresh) spokenIds.current.add(message.id);

    const replies = fresh.filter(
      (message) => message.role === "bot" && message.kind === "text" && message.text?.trim(),
    );
    for (const reply of replies) {
      const member = members.find((candidate) => candidate.id === reply.from?.botId);
      // What streamed in has been said already; only the rest goes now.
      roomVoice.current!.settle(member, reply.text!);
    }
    if (!replies.length) {
      const chip = [...fresh].reverse().find((message) => message.kind === "activity" && message.tool?.spoken);
      if (chip?.tool?.spoken) {
        const member = members.find((candidate) => candidate.id === chip.from?.botId);
        enqueueSpeech(chip.tool.spoken, member);
      }
    }
  }, [approval, enqueueSpeech, group.busyBotId, group.threadId, group.working, members, messages, question, scheduleListen]);

  useEffect(() => {
    // From the call's frozen thread, not the room's live one: another task
    // going busy or idle must not park the call, hush its microphone or start
    // it listening (call-turns.ts groupBusyStep, callbar-rereview3.md A3).
    const { busy, step } = groupBusyStep({
      live: { threadId: group.threadId, working: group.working, busyBotId: group.busyBotId },
      frozenThreadId: threadRef.current,
      lastBusy: busyRef.current,
      phase: phaseRef.current,
      asking: Boolean(askedApproval.current || askedQuestion.current),
      allowBargeIn: allowBargeIn.current,
    });
    busyRef.current = busy;
    if (group.threadId !== threadRef.current) return;
    if (busy) handDownWork.current.seen = true;
    else if (handDownWork.current.seen) handDownWork.current.done = true;
    if (!busy) {
      allowBargeIn.current = false;
      // the turn is over: no more sentences are coming for the reply
      roomVoice.current!.turnOver();
    }
    if (step === "work") {
      move("working");
      hush();
    } else if (step === "listen") {
      scheduleListen();
    }
  }, [group.busyBotId, group.threadId, group.working, hush, move, scheduleListen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (effectiveCollapsed) return;
      if (event.key === "Escape") {
        event.preventDefault();
        endCall(group.id);
      } else if (event.code === "Space" && speaker.isSpeaking()) {
        event.preventDefault();
        interruptSpeech();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [effectiveCollapsed, group.id, interruptSpeech]);

  const speakingMember = members.find((member) => member.id === speakingMemberId);
  const workingMember = members.find((member) => member.id === group.busyBotId);
  const focusId = speakingMember?.id ?? workingMember?.id;
  const status =
    phase === "listening"
      ? pushToTalk
        ? "Push to talk"
        : workingMember
          ? "Listening · " + workingMember.name + " is working"
          : "Listening"
      : phase === "sending"
        ? "Bringing the channel in"
        : phase === "speaking"
          ? (speakingMember?.name ?? "Channel member") + " is speaking"
          : workingMember
            ? workingMember.name + " is working"
            : "Working";

  // GroupCall has no hold/lost concept (no native call audio here): once
  // open it is simply "live" for the strip ChatView/GroupView render
  // (CallControls.tsx's CallBarStrip) whenever it isn't on screen.
  useEffect(() => {
    publishCallBarState({ targetId: group.id, threadId: threadRef.current, name: group.name, status: "live", kind: "group" });
  }, [group.id, group.name]);
  useEffect(() => () => publishCallBarState(null), []);

  // Where the full screen portals to (src/lib/call-slot.ts), so it covers
  // exactly the room column, never the sidebar or side panels
  // (callbar-review.md I3).
  const slot = useCallSlot();
  // The mood takes the colour of whoever is talking, else the one working,
  // else the first member (CallAura.tsx).
  const auraPhase = auraPhaseFor({ phase });
  const moodAura = useAvatarAura(speakingMember ?? workingMember ?? members[0] ?? { color: "orange" });
  // No keyboard hints on a phone (use-keyboard-hints.ts).
  const keyboardHints = useKeyboardHints();

  // Fixed, not in any layout: for the rare case where no room column is
  // mounted at all (callbar-rereview.md N2, N4 — see CallView.tsx's
  // identical fallback for the full scenario list).
  const fallbackBar = (
    <div
      data-testid="call-bar"
      className="fixed inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-md items-center gap-2.5 rounded-2xl border border-hairline/50 bg-panel px-3 py-2.5 shadow-2xl md:left-4 md:right-auto"
    >
      <CallBarContent name={group.name} status="live" onReturn={() => onExpand?.()} onHangUp={() => endCall(group.id)} />
    </div>
  );

  if (effectiveCollapsed) return slot ? null : fallbackBar;

  // pointer-events-auto: the slot it portals into (GroupView's own
  // call-slot div) is pointer-events-none so an EMPTY slot never blocks the
  // room underneath, and pointer-events is inherited — without this the
  // whole call screen would silently stop taking clicks.
  const fullScreen = (
    <div className="pointer-events-auto absolute inset-0 isolate z-30 flex flex-col items-center justify-center gap-6 bg-app/95 px-8 backdrop-blur-sm">
      <CallMood phase={auraPhase} color={moodAura.mood} signals={signals} />
      <button
        onClick={() => endCall(group.id)}
        aria-label="Hang up"
        className="absolute right-5 top-[calc(1.25rem+env(safe-area-inset-top))] rounded-md p-2 text-ink-secondary hover:bg-raised hover:text-ink"
      >
        <X size={18} />
      </button>

      <div className="max-w-full overflow-x-auto px-4 py-3">
        <div className="flex min-w-max items-end justify-center gap-3">
          {members.map((member) => {
            const focused = member.id === focusId;
            const state =
              speakingMember?.id === member.id
                ? "sending"
                : workingMember?.id === member.id
                  ? "working"
                  : phase === "listening"
                    ? "listening"
                    : normalizeState(member.mascotExpression) ?? "happy";
            return (
              <div
                key={member.id}
                className={cn(
                  "flex w-[124px] flex-col items-center gap-2 rounded-3xl px-2 py-3 transition-all duration-200",
                  focused ? "scale-105 bg-raised/70 shadow-lg" : "opacity-75",
                )}
              >
                <MemberCallAvatar
                  member={member}
                  state={state}
                  phase={auraPhase}
                  focused={focused}
                  working={workingMember?.id === member.id}
                  signals={signals}
                />
                <span className={cn("text-[13px] font-medium", focused ? "text-ink" : "text-ink-secondary")}>
                  {member.name}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col items-center gap-1.5 text-center">
        <div className="text-[20px] font-medium text-ink">{group.name}</div>
        <div className="flex items-center gap-2 text-[13.5px] text-ink-secondary">
          {(phase === "working" || phase === "sending") && <Loader2 size={13} className="animate-spin" />}
          {status}
        </div>
      </div>

      {/* one fixed height in every phase, as tall as the read-along's
          maximum, so the row of members never jumps between turns */}
      <div className="h-[9.5rem] w-full max-w-[620px] overflow-hidden text-center text-[15px] leading-relaxed text-ink">
        <div className="flex max-h-full flex-col items-center justify-end overflow-hidden">
          {phase === "listening" ? (
            heard || (
              <span className="text-ink-secondary">
                {pushToTalk
                  ? "Release Control + Option to send…"
                  : "Say a name, say “everyone,” or just talk to the channel…"}
              </span>
            )
          ) : phase === "speaking" && speech.caption ? (
            <ReadAlong spoken={speech.spoken} current={speech.caption} queued={speech.queued} progress={readAlongProgress} />
          ) : phase === "speaking" ? (
            speech.caption
          ) : (
            <span className="text-ink-secondary">{workingMember ? "You’ll hear each response in turn." : ""}</span>
          )}
        </div>
      </div>

      {note && (
        <div className="flex max-w-[520px] flex-col items-center gap-2 text-center text-[12.5px] text-warning">
          <span>{note}</span>
          <button
            onClick={listen}
            className="rounded-full border border-warning/40 px-3 py-1.5 text-[12px] hover:bg-warning/10"
          >
            Try microphone again
          </button>
        </div>
      )}
      {speech.error && <div className="max-w-[460px] text-center text-[12.5px] text-danger">{speech.error}</div>}

      <div className="flex items-center gap-3">
        {speaker.isSpeaking() && (
          <button
            onClick={interruptSpeech}
            className="rounded-full border border-hairline/50 px-4 py-2 text-[13.5px] text-ink hover:bg-raised"
          >
            Interrupt
          </button>
        )}
        <button
          onClick={() => endCall(group.id)}
          className="flex items-center gap-2 rounded-full bg-danger px-5 py-2.5 text-[14px] font-medium text-white hover:brightness-110"
        >
          <PhoneOff size={16} /> Hang up
        </button>
      </div>

      {keyboardHints && (
        <div className="text-[11.5px] text-ink-secondary/70" data-call-keyboard-hints>
          Hold Control + Option to talk · Say a member’s name to direct the turn · Space interrupts · Esc hangs up
        </div>
      )}
    </div>
  );

  // The full screen wants to show but no room column is mounted — see
  // CallView.tsx's identical fallback for when this can happen.
  if (!slot) return fallbackBar;

  return createPortal(fullScreen, slot);
}
