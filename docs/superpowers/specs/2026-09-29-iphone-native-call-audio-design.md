# iPhone native call audio: design (rev 3, 2026-09-29)

Status: rev 3. Rev 2 folded in two independent audits (native: `audit-native-call-audio-ios.md`, web: `audit-native-call-audio-web.md`). Rev 3 folds in the confirmation audit (`audit-native-call-audio-confirm.md`: 6 partial fixes, N1 to N7, and the Minor items). All three are in `.superpowers/sdd/2026-09-27-plan-3b-push-native/`. §10 maps each finding to where it landed. Branch `mobile/v1`. Evidence: `call-audio-probe.md` (device probe variants A to J) and `voice-call-investigation.md` in the same directory.

## 1. The problem, proven

A call on the iPhone plays the bot's voice scratchy and quieter. The device probe proved why. While the page holds the microphone (getUserMedia), iOS runs the WebView's audio through voice-processing I/O and treats everything the page plays (`<audio>`, Web Audio, a MediaStream, a WebRTC loopback) as "other audio", ducked and mangled. Every web-side setting was tried: echo cancellation on and off, noise suppression and gain off, 16 and 48 kHz, `navigator.audioSession`, a MediaStream reply, and a WebRTC loopback. All of them were scratchy. With no microphone open (probe A), the same clip is crystal clear. Android is perfect and stays as it is.

The ChatGPT and Claude apps have native code that owns the audio. They put the session in `.playAndRecord` with the `.voiceChat` mode, capture through the voice-processing unit, and play the reply through the same unit. The reply is then the echo canceller's reference signal rather than "other audio", and the person can still talk over it.

That this sounds clean on Sean's iPhone is an inference, not yet a measurement. §6.0 measures it before anything else is built.

## 2. Goal and success criteria

- On the iPhone's built-in speaker and on wired headphones, the bot's voice on a call sounds as clean as the no-microphone clip (probe A). On AirPods it sounds like a clean FaceTime audio call. With the AirPods microphone in use, iOS switches AirPods to the hands-free Bluetooth profile, which is call quality rather than music quality. ChatGPT has the same limit. What matters is no ducking, no crackle and no scratch.
- Talk-over (barge-in) still works: the owner speaks while the bot talks, and the bot stops. The bot's own voice, and any sound Murage makes on the call, is never transcribed as the owner's words.
- A phone call, Siri, an alarm or a trip to another app holds the call cleanly, and the call carries on afterwards. Plugging AirPods in or out mid-call keeps the call working, with no error shown.
- Android, the desktop app, desktop browsers, group calls and voice messages outside a call behave exactly as today.
- No half-duplex stopgap.

Non-goals, with reasons:
- **The call does not keep going with the phone locked or Murage in the background.** The call's brain (turn-taking, speech detection, transcription requests, the bot's stream) runs in the page, and iOS suspends WebView script in the background. The honest behaviour is a clean hold: leaving pauses the call, and coming back resumes it. Keeping a call alive while locked means moving the turn-taking into native code, a separate and larger project (§9).
- **No native speech recognition.** The phone keeps today's recognizer path: the page detects each utterance (Silero plus the loudness gate) and Flux transcribes it via `/api/voice/transcribe`. That path is proven on both phones. On-device Apple recognition is a follow-up (§9).
- **No earpiece or speaker toggle.** The speaker is the default and a connected headset takes over automatically, as in ChatGPT.

## 3. Approaches considered

1. **Recommended: the iOS shell owns the call's audio and the page keeps the brain.** Native captures the microphone through voice processing and streams 16 kHz frames to the page. The page keeps detecting speech, deciding turns and transcribing. It still fetches each reply clip, so all auth stays in the page, and hands the bytes to native, which plays them through the same engine. The working pulse also plays natively, so the page makes no sound at all during a native call.
2. **Native owns everything: audio, turn-taking and transcription.** This is the "keep going while locked" design. It rewrites CallView's turn logic (barge-in, false interruptions, echo warm-up, backchannels, the voice host) in Swift. That is several days of work, duplicates proven logic and forks behaviour between platforms. Rejected for now (§9).
3. **Half duplex: close the microphone while the bot speaks.** Probe F showed the audio stays rough, and talk-over is lost. Sean ruled it out.

## 4. Architecture (approach 1)

```
 page (WKWebView, same bundle as today)                   iOS shell (Swift)
 ─────────────────────────────────────                   ──────────────────────────────────────────────
 CallView ─ FluxMic ◄─ NativeFrameSource ◄──── event callAudio {mic}      ◄── CallAudioEngine (one serial queue)
          ─ speaker ─► NativeClipPlayer ─────► callAudioPlay {pieces}    ──►   AVAudioSession .playAndRecord/.voiceChat
                                          ◄──── event callAudio {clip}         AVAudioEngine, voice processing on
          ─ pulse ───────────────────────────► callAudioControl {pulse}  ──►   input tap → 16 kHz mono frames
          ◄─ hold / resume / lost / route ◄──── event callAudio {…}             player node ← streamed decoder
                                                                                pulse node (synthesised tick)
```

### 4.1 Channel contract

**Methods (iOS only).** They all go through the existing `window.murageNative` channel and its native gate (`ChannelGate.admit`: the saved origin and the main frame only). `apps/mobile/contract/channel.json` gains a `platformMethods` block, `{ "ios": ["callAudioOpen", "callAudioClose", "callAudioPlay", "callAudioControl"] }`. The iOS test expects `methods + platformMethods.ios`. The Android test keeps expecting `methods` only, so Android's list is byte-identical. `apps/mobile/src/channel-script.test.ts` checks each wrapper against its own platform's list, and `src/lib/native-contract.test.ts` covers `platformMethods` too. The shared `requests` fixture is run by BOTH platforms' gate tests, so it gets no call-audio cases. The routing cases go under `platformRequests.ios`, which only the iOS gate test runs. The limit cases go under `callAudioRequests`, which the `MurageCallAudioCore` argument parser test runs, because the limits are argument errors rather than parse errors. `ChannelMethod`, `ChannelGate.advertised`, `ChannelScript.iosTemplate` (wrappers that copy the page's arguments into fresh objects, as the other wrappers do), `native-shell.ts` `KNOWN_METHODS`, and the fixtures all change together.

| Method | Args | Reply |
|---|---|---|
| `callAudioOpen` | none | `{ session: string, sampleRate: 16000, frame: 1024 }`, sent once the microphone is running. Error `denied` if microphone access is refused. Error `inactive` if the app is not `.active`; this is transient, and the page retries once on the next `resume` app event before falling back. Error `unavailable` if the engine cannot start. A second open while one is open or opening returns the same result, so there is one engine. After `lost` the old session is gone (see below), so an open starts a new one. |
| `callAudioClose` | `{ session }` | `true`. Stops the engine and deactivates the session with `.notifyOthersOnDeactivation`. A stale or unknown session is a no-op `true`. Idempotent. |
| `callAudioPlay` | `{ session, clip, seq, mime, bytes, last }` | `true`, or `badArgs` / `unavailable`. Appends one piece of a clip. The first piece (`seq` 0) may carry `paused: true`. During a hold, pieces are accepted and dropped: the answer is `true`, and the clip gets `cut` once. |
| `callAudioControl` | `{ session, action }`, where `action` is `"pause"`, `"resume"`, `"stop"`, `"pulseOn"` or `"pulseOff"` | `true`. `stop` drops the current clip. `pulseOn` and `pulseOff` start and stop the working tick. |

**Event `callAudio`** (native to page, through the existing `emit`). `native-shell.ts` gains a typed overload of `onNativeEvent` that passes the parsed detail and drops unknown shapes. The wrapper ANSWERS `true` to native for every well-formed event while the subscription is live and the listener ran without throwing, including while muted and when the page drops the frame. The native watchdog (§4.2.7) relies on that answer. Detail shapes:
- `{ type: "mic", session, pcm }`: 1024 samples of 16 kHz mono signed 16-bit little-endian PCM, base64 encoded (2,048 bytes, about 2.7 KB of text). There are 15.6 frames a second, arriving in bursts of one or two about every 100 ms.
- `{ type: "clip", session, clip, state, reason? }` (`reason` only with `"cut"`: `"stop"`, `"hold"` or `"next"`):
  - `state` is one of `"playing"`, `"progress"`, `"ended"`, `"failed"` or `"cut"`.
  - `"progress"` is sent about every 250 ms, but only while samples are actually rendering.
  - `"failed"` means the clip cannot be decoded or held nothing playable.
  - `"cut"` means native stopped the clip for a reason that is not the clip's fault: an interruption, a route change, background, or a stop from the page. The page shows no error for `"cut"`.
- `{ type: "hold", session, reason }` with `reason` one of `"interrupted"`, `"background"` or `"media-reset"`. It is always sent BEFORE any clip is cut for that reason.
- `{ type: "resume", session }`: the engine is running again.
- `{ type: "lost", session, reason }`: the engine could not be restarted after a hold (one retry already failed), or the session category was fought over too often (§4.2.5). Native tears the engine down, restores the session (§4.2.7), and ends that session: later calls that carry it answer `unavailable`. The page offers "Resume call", which opens a new session.
- `{ type: "route", session, output }`, where `output` is `"speaker"`, `"receiver"`, `"headphones"`, `"bluetooth"` or `"other"`. It comes from `routeChangeNotification` and is used for logging and a future toggle only. The page never acts on it. Real route rebuilds reach the page as hold, then resume.

**Limits.** These are enforced natively, pinned in the shared fixture, and tested:
- `session`: an opaque string from the open.
- `clip`: at most 64 characters, and unique for each `play()` on the page (a counter plus the session).
- `mime`: the page normalises it before sending: parameters are dropped, and `audio/mp3` and `audio/mpeg3` become `audio/mpeg`, while `audio/wave` and `audio/x-wav` become `audio/wav`. Native accepts `audio/mpeg`, `audio/wav`, `audio/aac` and `audio/mp4`. Native also sniffs the first bytes (ID3 or an MPEG frame sync, `RIFF…WAVE`, ADTS, `ftyp`), and the sniffed type wins over the label.
- `bytes`: base64, at most 256 KB of base64 text per piece (the hard cap). The page sends 64 KB pieces.
- A clip holds at most 8 MB of source bytes.
- `seq` counts up from 0 within a clip, with no gaps. A piece after `last`, a gap, or an unknown session answers `badArgs`. If the clip was live, native then sends `"failed"` for it exactly once.
- Only one clip is open at a time. A new clip's first piece while another is open cuts the old one (`"cut"`). The page never sends a second clip before the first has settled.
- The end of a clip is a piece with `last: true`, which may be empty. A download that broke part-way still sends `last: true` for what arrived. The HTML path plays a partial clip too.

### 4.2 Native: `CallAudioEngine`

**Code layout.**
- A new SwiftPM target, `MurageCallAudioCore` (Foundation, AVFAudio, AudioToolbox; testable on the Mac with `swift test`), holds:
  - the argument parsing and limits;
  - the pure state reducer (§4.2.6);
  - the mic framer and the 48 kHz to 16 kHz resampler;
  - the streamed decoder;
  - the clip bookkeeping.
- `MurageShellCore` stays Foundation-only, because the notification extension links it.
- `MurageShell` (iOS) holds `CallAudioEngine`, which drives AVAudioSession and AVAudioEngine from the reducer's decisions, and the wiring in `WorkspaceViewController`.

**4.2.1 Threading.** One serial `DispatchQueue` ("call-audio") owns every session and engine change, the decoder, the scheduler and the reducer. Session activation and engine start never run on the main thread, because voice-processing setup can block for hundreds of milliseconds. The tap block copies samples out of its buffer before returning, since that buffer is only valid during the call. Completion handlers and notifications (which can arrive on any thread) hop to the queue, and never call player or engine methods inline. Only finished `String`s and small dictionaries cross to `@MainActor` for `emit` and channel replies. The code uses Swift 5 language mode with explicit `@Sendable` boundaries. `CallAudioEngine` captures nothing strongly: all callbacks capture it weakly, and the view controller owns it.

**4.2.2 Setup order.** Getting this wrong crashes or silences the engine. The sequence is:
1. `setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP, .allowBluetoothA2DP])`, then `setActive(true)`. The SDKs on this Mac are iOS 26 or later, so `.allowBluetoothHFP` is the name to use. Apple recommends both Bluetooth options: HFP wins when the headset has a microphone, and A2DP covers output-only speakers.
2. Build a new `AVAudioEngine`.
3. Call `inputNode.setVoiceProcessingEnabled(true)`. It throws, and a failure maps to `unavailable`.
4. Set `inputNode.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)`.
5. Attach the player node and the pulse node. Both feed one submixer (`AVAudioMixerNode`), which feeds one shared `AVAudioUnitEQ(numberOfBands: 0)` (`globalGain`, a single tuning constant set from the §6.0 spike's loudness comparison) and one peak limiter (`AVAudioUnitEffect`, `kAudioUnitSubType_PeakLimiter`), into `mainMixerNode`. The player and pulse connections use a fixed format: `AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)`. The mixer adapts to whatever the voice-processing output is, so a route change never forces a decoder rebuild. The voice and the pulse always sit at the same loudness.
6. `installTap(onBus: 0, bufferSize: 4096, format: inputNode.outputFormat(forBus: 0))`, with the format read after step 3.
7. `prepare()`, then `start()`. The player node stays stopped between clips. `play()` runs per clip, when the jitter threshold is reached (§4.2.4), and again after any `playerNode.stop()`.

8. Measured on Sean's iPhone (spike, Task 1): voice processing posts an `AVAudioEngineConfigurationChange` about 0.1 s after EVERY start, in every mode, and the engine stops; the output then reads 44.1 kHz stereo against a 48 kHz input. The fix that works: on that change, remake the mixer-to-output connection, attach FRESH player and pulse nodes (a reused node never plays a scheduled buffer again), reinstall the tap after checking its format is valid (the input can briefly read 0 Hz, and a tap in that format crashes), and restart. The reducer must not debounce this first change away (it is a restart and a rebuild, §4.2.6), and it is not a hold: no `hold` or `resume` is sent for it while opening.

Never set `preferredSampleRate`, because a 16 kHz preference would narrow playback. Resampling happens only in the tap's converter.

The category, mode and options found at open are recorded before step 1, and restored on every close path (§4.2.7). `.allowBluetoothHFP` is the iOS 26 SDK name for `.allowBluetooth`, with the same raw value; the deployment target is iOS 17.0, so if the compiler gates the new name, use `.allowBluetooth`. `voiceProcessingOtherAudioDuckingConfiguration` affects only other apps' audio, never our own output, so it is no loudness lever.

**4.2.3 Microphone.** One long-lived `AVAudioConverter` per input format turns the input into 16 kHz mono Float32 through `convert(to:error:withInputFrom:)`. Its input block supplies each tap buffer once and then returns `.noDataNow`, never `.endOfStream`, so no samples are lost at the edges. Output capacity is `ceil(in × 16000 / inRate) + 32`. The framer carries its remainder across taps and cuts exact 1024-sample frames, which it converts to Int16 LE (clipped) and base64. Muting is not done natively. The page already drops frames while muted, and the engine must keep running so the echo canceller stays adapted. The microphone indicator therefore stays on while muted, which is intended.

**4.2.4 Playback.**
- **Decoder.** Each clip gets its own decoder. `AudioFileStreamOpen` is called with a type hint from the sniffed type (`kAudioFileMP3Type`, `kAudioFileWAVEType`, `kAudioFileAAC_ADTSType`, `kAudioFileM4AType`). For compressed data, the packets callback fills an `AVAudioCompressedBuffer` with the packet descriptions (VBR), plus the magic cookie when one is present. For WAV, the bytes are wrapped as PCM in the stream's format. An `AVAudioConverter` with `downmix = true` makes 48 kHz mono Float32. MP4/M4A is buffered whole before decoding, because `AudioFileStream` cannot stream a file whose `moov` comes after `mdat`. No current voice service sends it. Its input block returns `.noDataNow` while it waits for bytes, and `.endOfStream` only after `last`. MP3 priming (about 25 ms of leading silence) is accepted. Parsing and decoding run on the queue, not in the WKScriptMessage callback.
- **Jitter buffer.** Playback starts once at least 250 ms of PCM is scheduled or `last` has arrived. If the scheduled audio runs out before `last`, the player pauses (an underrun), `progress` stops, and playback resumes at 250 ms. This is logged as `call audio clip underrun`. A clip that starts with `paused: true` fills its buffer but waits for `resume`.
- **Completion.** Each clip gets a generation token. Every completion (`.dataPlayedBack`) checks that its clip is still the current, unstopped generation before it counts. A per-clip counter tracks buffers that are scheduled but not played. `ended` fires when `last` has arrived, the decoder has been flushed, and the counter reaches zero. Zero-length buffers are never scheduled. `stop`, a route change, an interruption or background uses `playerNode.stop()` and sends `"cut"` exactly once, from the control path and never from a completion. (Stop fires pending completions even for unplayed audio. The generation token ignores them.)
- **Pause and resume** pause and play the player node. `progress` stops while paused.
- **The pulse.** A second player node plays a synthesised tick: the same two-part blip as `src/lib/working-pulse.ts` (620 Hz then 740 Hz, a 0.82 pitch fall over 120 ms, a 1.8 kHz low-pass, peaks 0.07 and 0.045, 110 ms apart, repeating every 950 ms). It is generated once into a buffer and looped with a timer on the queue. Because it goes through the engine, it is part of the echo reference and is never heard as the owner.

**4.2.5 The owner's audio session stays ours.** WebKit shares the app's `AVAudioSession`. If page media ever changes the category, the call would lose its microphone. The engine observes `routeChangeNotification`. The trigger is reason `.categoryChange` AND the category or mode actually differing from `.playAndRecord` / `.voiceChat`. Our own `setCategory` also posts `.categoryChange` but leaves the values right, so it never triggers. On a real change, the reducer gets a `categoryLost` input. It adds the `mediaReset` hold reason, reapplies §4.2.2 step 1, restarts, and removes the reason, so the call resumes only when no other reason is held (§4.2.6). At most 3 reasserts in 10 s; the fourth sends `lost`. Each reassert logs `call audio session category reasserted`. The page rule (§4.3.3) keeps page media silent anyway, so this is a backstop.

**4.2.6 Lifecycle as a pure reducer.** `CallAudioState` is pure and tested for every order of events. Its inputs are:
- open requested, opened, open failed, and close;
- interruption began (ignored when it is the stale `.appWasSuspended` notice), and interruption ended. With `shouldResume` it restarts unless backgrounded; without it, it restarts only while the app is active, because an interruption answered or declined from the banner never resigns the app, so no `didBecomeActive` follows (final review I2);
- will resign active, did enter background, and did become active;
- engine configuration change. Apple stops the engine before posting it, so every change restarts the engine if it is not running, through the hold path. Every such restart rebuilds the tap and converter (the input format read when the notification lands can be stale, final review M2), and rebuilds (never restarts) are debounced within 500 ms of a start;
- category lost (§4.2.5);
- permission answered (granted or denied);
- restart succeeded, and restart failed (which drives the one retry and then `lost`);
- media services lost, and media services reset;
- navigation commit, WebContent process terminated, and controller closed;
- mic event unhandled.

It keeps a set of hold reasons (`interrupted`, `background`, `mediaReset`) and produces actions: start, stop, rebuild, emit hold, resume or lost, close, and restore session. Every restart anywhere in this design (§4.2.5, §4.2.8, §4.2.9) goes through the reducer. A rebuild or restart that arrives while another reason is held is deferred to the next `didBecomeActive`. Resuming happens only when the set is empty. It is attempted on `didBecomeActiveNotification`, never `willEnterForeground`, in this order: `setActive(true)`, `engine.start()`, then the pulse node's loop if the page's last pulse command was on, with one retry after 0.5 s. The voice player node plays again only for the next clip. If that fails, the reducer sends `lost`. On becoming active with a call open, `interrupted` and `background` are always cleared and a restart is attempted, because interruption `.ended` is not guaranteed; if another app still holds the audio, the start fails and the retry then `lost` path applies. A resume ALWAYS happens on becoming active while a call is open, because the owner is back on the call screen. The generic shell `pause`/`resume` events still fire, but the call acts only on `callAudio` hold and resume.

**4.2.7 Ownership, so the microphone never outlives the page.** The engine closes on:
- `callAudioClose`;
- `webView(_:didCommit:)`, which is new: any main-frame commit, including a reload;
- `webViewWebContentProcessDidTerminate`;
- `close(_:)` (sign out, re-pair, the launcher);
- dismissal in `viewDidDisappear`;
- `deinit`.

Every close path restores the category, mode and options recorded at open (§4.2.2), then calls `setActive(false, options: .notifyOthersOnDeactivation)`. So voice messages after a call sound as they did before it. A failed open does the same before the page falls back to getUserMedia.

There is also a liveness watchdog. `emit` already reports whether a listener handled the event, and the page's `callAudio` wrapper answers `true` for every well-formed event (§4.1). After 32 consecutive mic events (about 2 s) that went unhandled, native closes the engine and logs `call audio closed unheard`. This covers a page that unmounted the call without closing.

**4.2.8 Route changes.** An `AVAudioEngineConfigurationChange` (AirPods in or out, wired EarPods, receiver to speaker) goes to the reducer. It adds the `mediaReset` hold reason (sending `hold` first), cuts the current clip (`"cut"`, reason `"hold"`), rebuilds the tap and converter, restarts, and removes the reason, which sends `resume` only if no other reason is held. A route event comes from `routeChangeNotification`, which also fires for same-rate changes that don't reconfigure the engine. Keeping the decoded buffers across a rebuild is a later refinement. For now a cut ends the rest of that reply out loud (the full reply is still in the chat), and the call listens.

**4.2.9 Media services.** `mediaServicesWereLostNotification` adds the `mediaReset` hold reason. `mediaServicesWereResetNotification` throws away every AV object, builds a new engine, reapplies the session (§4.2.2), and removes the reason through the reducer, or sends `lost`.

**4.2.10 Permission and security.** `callAudioOpen` checks `AVAudioApplication.shared.recordPermission` first. `.denied` answers `denied` without a prompt. `.undetermined` calls `requestRecordPermission` (whose callback arrives on any queue and hops to the queue). The prompt makes the app inactive but not backgrounded, so the open waits for the answer rather than reading that as leaving. WebKit and native share one microphone grant, so an owner who already allowed the microphone on the web sees no second prompt. An open while the app is `.inactive` (a cold launch, a return from Siri or a lock) waits for `didBecomeActive`, at most 2 s, and only then answers `inactive`; a close ends the wait, and a second open joins it. In the background it answers `inactive` at once (final review Ruling 2). This matches today's trust model: the page on the saved origin can already open the microphone through getUserMedia (`NavigationPolicy.mayCapture`). The iOS orange microphone dot stays the visible control.

**4.2.11 Logging.** Fixed strings only, through ShellLog: `call audio open`, `close`, `hold interrupted`, `resume`, `lost`, `route bluetooth`, `clip failed decode`, `clip underrun`, `session category reasserted`, `closed unheard`, and the mic mode (`AVCaptureDevice.activeMicrophoneMode`) at open. No audio, text or clip ids are ever logged. `callAudioPlay` is exempt from the per-call `channelAccepted` log line.

### 4.3 Web

**4.3.1 Microphone (`src/lib/call-mic.ts`).**
- Capture moves behind a `FrameSource` interface: `open(onFrame: (frame: Float32Array) => void): Promise<void>`, `close(): void` and `readonly opened: boolean`.
- `WebAudioFrameSource` is today's getUserMedia and ScriptProcessor code, moved unchanged.
- `NativeFrameSource` calls `callAudioOpen`, subscribes to mic events for its session, decodes base64 Int16 to Float32, and hands on 1024-sample frames.
- EVERY `this.stream` check in `Capture` (lines 189, 209 and 234 today) becomes `source.opened`. Without this, Silero would never load on the native path and the call would silently drop to the loudness-only gate.
- `Capture` gets `resetDetection()`, the same reset `setMuted(true)` does (the gate, Silero, recording, preroll and silent frames), for use after a hold.
- Frames are timestamped by sample count from the open rather than by arrival time, so bursts don't skew `speechShare`. "Now" for `speechWithin` and `speechShare` is the newest frame's sample time, and that clock does not advance during a hold.
- "Resume call" after `lost` closes and reopens the SOURCE only (`source.close()` then `source.open()`), never `Capture.close()`, which would clear the line, end and voice listeners attached once in `begin()`.

**4.3.2 Choosing the path.**
- The choice is made in the async `open()`, not at render: `await nativeAvailable("callAudioOpen")` decides between the native and web sources.
- A page kill switch forces the web path. It is the constant `NATIVE_CALL_AUDIO = true` in `src/lib/call-audio-native.ts`, overridable per device by `localStorage["murage.call.nativeAudio"] = "off"`, and it is logged. With it, the native path can be turned off from the Mac the same day, without waiting for a new iPhone build.
- When the native method is available, `callMicKind` treats capture as available even without `navigator.mediaDevices`.
- The chosen path is logged once as a fixed `[call-diag] audio native` or `[call-diag] audio web`.
- If `callAudioOpen` answers `inactive`, the page retries once on the next `resume` app event. If it answers `unavailable` (or `inactive` again), the call falls back to the web path.
- If it answers `denied`, the call shows "Allow the microphone for Murage in Settings, then try again". "Try again" re-runs `open()` rather than `listen()`.

**4.3.3 The page stays silent during a native call.** While a native call is open, the page makes no sound except through `Speaker` into the native player, and it creates no `AudioContext`, plays no media element and calls no getUserMedia.
- The working pulse goes to native: CallView sends `pulseOn` and `pulseOff`, and `WorkingPulse` is never built on the native path.
- Chat media under the call overlay is paused when the call opens, BEFORE `callAudioOpen`, so any WebKit session change from that pause lands before native activates. Auto-speak already stays silent during a call.
- A unit guard asserts that `AudioContext` and `Audio` are never constructed while a native call is open.

**4.3.4 Speaker output (`src/lib/tts/index.ts`).**
- `Speaker.play` moves behind a `ClipPlayer` interface: `play(clip, live, opts) → Promise<"ended" | "failed" | "cut">`, plus `pause()`, `resume()`, `teardown()` and `readonly streams: boolean`.
- `HtmlAudioPlayer` is today's code, moved unchanged. It maps its outcomes as `ended` becoming `ended`, a failure or stall becoming `failed`, and an interruption becoming `cut`.
- `NativeClipPlayer`:
  - It sends pieces in order through `callAudioPlay`. When `Speaker.held` is set, the first piece carries `paused: true`.
  - It settles on `ended`, `failed` or `cut`.
  - It re-arms the 8 s stall clock on `playing` and `progress`, clears it on `pause()` and re-arms it on `resume()`. A hold for the owner that runs past 8 s therefore never fails the reply.
- `render()` asks the active player whether it streams. With the native player the response body is ALWAYS read as `Incoming`, whether or not `MediaSource` exists (the iPhone may lack it). Blob clips go out in 64 KB pieces.
- A `"cut"` outcome ends the utterance loop WITHOUT setting `CLIP_FAILED`. Only `"failed"` shows the red error.
- **Lifecycle.**
  - `speaker.useOutput(nativePlayer)` is set in CallView's `begin()`, after `open()` resolves, and never at render.
  - It is cleared (`useOutput(null)`) in the unmount cleanup before `callAudioClose`, and on the `unavailable` fallback.
  - Each `play()` holds on to the player it started with, so one clip never spans two players.
  - Group calls, voice messages outside a call, settings previews and chat media never use the native player.

**4.3.5 Hold in CallView.** Hold is a ref plus a render flag, `held`, not a new `Phase`, so the avatar and caption keep their inputs.
- **Before the output is chosen.** A named `outputReady` ref, separate from `held`, gates call speech. Any call speech that would start before it (an open approval or question spoken on mount) waits. `begin()` sets it and drains with `listenOrCatchUp()`, not `listen()`, so an approval open when the call starts is asked at once.
- **Owed prompts.** Approval and question prompts never go into `deferredReplies` and never go through `tellReply` (which would send a long prompt through the host's brief mode and paraphrase it). A gated prompt is marked owed. When speech is allowed again, owed prompts are asked FIRST, through `sayThenListen`, exactly once.
- **Put back at the front.** A gated `tellReply` or `sayThenListen` puts its text back at the FRONT of `deferredReplies`, since `listenOrCatchUp` already took it off.
- **On `hold`, in this order:**
  1. `sayGeneration += 1`.
  2. Clear the `maybeOwner` timer.
  3. `hostAbort.current?.abort()` and `hostSpeaking = false`.
  4. `speaker.stop()`.
  5. `hush()`, which also aborts an in-flight Flux transcription. An utterance cut off by the hold is dropped, not sent.
  6. `pulseOff`.
  7. Set `held`.
- **While held:**
  - `say`, `tellReply`, `sayThenListen`, `listen`, `openTurn` and the "still on it" tick all check `held`.
  - Text that would have been spoken (an engine reply, a failure line, the chip narration) goes to `deferredReplies`. Approval and question prompts are marked owed instead.
  - The busy effect does not move the phase.
  - The status line reads "Call paused", and the avatar renders idle.
  - `pulsing` includes `!held`, so the pulse effect sends `pulseOff` on hold and `pulseOn` again on resume if work is still running. The page is the only owner of the pulse; native forgets the pulse state on a hold.
- **On `resume`, in this order:**
  1. Clear `held`.
  2. `mic.resetDetection()`.
  3. `firstSpokeAt = 0`, so the echo warm-up runs again on the next spoken line. `lastSpeechAt` is reset, so "This is taking a while" does not fire the moment the call resumes.
  4. If `bot.busy && !hostOn`, `move("working")`. Otherwise run `listenOrCatchUp()`, which asks owed prompts first, then speaks the deferred replies. An approval asked before the hold whose prompt the hold cut off is marked owed at hold time, so it is asked once here and never twice.
- **On `lost`:** the status reads "Call paused" with a "Resume call" button. The button calls `open()` again, and if that fails the note reads "The microphone couldn't start."
- **A long hold:** once a hold has lasted about 5 s with the page visible, the same "Resume call" button shows too, because nothing on the phone is sure to end a hold (final review I2). Time off screen does not count.
- **Muted and held together:** "Call paused" wins, because it explains why nothing is happening.

**4.3.6 Channel typing (`src/lib/native-shell.ts`).** This adds the four methods, the `callAudio` event, and a parser that drops unknown shapes and wrong sessions.

## 5. Error handling summary

| Situation | Behaviour |
|---|---|
| Microphone refused | `denied`. The note points to Settings, and "Try again" re-opens. |
| Engine cannot start | `unavailable`. The call falls back to the web path, which is logged. |
| Engine cannot restart after a hold | `lost`. The call shows "Call paused" with "Resume call". |
| A clip cannot be decoded | `failed`. The existing clip error shows, and the call moves on. |
| No `ended` arrives (a native bug) | The page's 8 s stall clock ends the clip, as today. It never fires while the clip is deliberately paused. |
| A phone call, Siri or an alarm | `hold` (interrupted), then `resume` on return to the app. No error. |
| AirPods or wired headphones in or out | `hold`, the clip `cut`, a restart (and a rebuild if the input changed), then `resume`. The rest of that reply is not spoken (it is in the chat), and the call listens. No error. |
| WebKit and native fight over the session | Up to 3 reasserts in 10 s, then `lost` and "Resume call". |
| WebKit changes the audio session | The category is reasserted with a hold and resume, and logged. |
| The page reloads, navigates or crashes mid-call | Native closes on the commit or on the process ending, and the new page starts clean. |
| The page drops the call without closing | The watchdog closes the engine after about 2 s of unheard mic frames. |
| Background or lock | `hold` (background), the microphone turns off, and `resume` comes on return. |
| The native path misbehaves in the field | The kill switch forces the web path from the Mac. |

## 6. Testing

**6.0 Gate: the native spike (before any channel or web work).** A DEBUG-only path in the shell, behind the existing `E2EProbe` launch argument, opens the engine exactly as §4.2.2 describes with the tap running. It plays a bundled fixture MP3 (the probe-A sentence in Dax's voice, fetched once from the isolated test host and committed as a test fixture) through the player node, and plays the pulse. It logs the mic RMS during playback and during silence, which gives a number for echo return loss. Sean listens on the speaker and on AirPods against probe A, for clarity AND loudness, at EQ gain 0, +6 and +12 dB. The chosen gain becomes the tuning constant before the build. The result goes into `call-audio-probe.md`. If it is rough, the spike tries `.default` mode with voice processing on, and then `.videoChat`, before anything else is built. Go or no-go is Sean's call. Pure pieces with no dependency on the outcome (the reducer, the parsing and limits, the framer and resampler) may be built while the spike waits for Sean.

**6.1 Swift (`swift test` on the Mac, one build at a time).**
- **MurageCallAudioCore:**
  - Argument parsing and every limit, driven from the shared fixture.
  - The framer and resampler: a sine fed in uneven pieces, with the frequency and length checked and no edge loss.
  - The decoder: fixture MP3 files (with ID3v2 tags, VBR, and pieces split mid-frame and mid-header), WAV, and ADTS AAC, each compared against a one-shot decode for frame count and continuity.
  - MIME sniffing.
  - Clip bookkeeping: the generation token, the outstanding-buffer counter, `last` with an empty flush, and a second clip cutting the first.
  - The `CallAudioState` reducer over every event order: `.began` with no `.ended`, background during an interruption, a configuration change during open, close during open, a commit during a hold, and the watchdog.
- **MurageShellCore:** `ChannelGate` lists and parses the new methods on iOS.
- **iOS simulator unit bundle:** drives the real `CallAudioEngine` lifecycle with posted `interruptionNotification`, `routeChangeNotification` and configuration-change notifications, including their userInfo. The sound quality in the simulator means nothing, and this is said in the test.

**6.2 Contract.**
- `apps/mobile/contract/channel.json` gains `platformMethods` and the new request fixtures.
- The iOS `ChannelGateTests`, the Android `ChannelGateTest` (its list is unchanged) and `apps/mobile/src/channel-script.test.ts` are all updated.
- `apps/mobile/src/native-guards*.test.ts` stay green.

**6.3 Web (vitest).**
- NativeFrameSource with a fake bridge: decoding, frame hand-off, session filtering, and close unsubscribing.
- Silero active on native frames: `speechWithin()` is not null.
- `resetDetection`.
- NativeClipPlayer: pieces in order; `ended`, `failed` and `cut` outcomes; `cut` never setting `CLIP_FAILED`; the stall clock re-armed by progress, cleared by pause, and never tripped by a 10 s hold; `paused: true` when held between clips; stop.
- Streaming with `MediaSource` undefined: pieces reach `callAudioPlay` before the body ends.
- The MIME normaliser, with one case per voice service.
- The `useOutput` lifecycle: mount, open, unmount, then `speak()` uses the HTML player.
- The late-hello path: `open()` waits for hello.
- The kill switch.
- The native-shell event parser.
- CallView:
  - it picks the native path only when the method is listed and the switch is on;
  - it never constructs `AudioContext` or `Audio` on the native path;
  - a hold in each phase (speaking with a host stream, sending, working with a reply that lands during the hold, listening with a transcription in flight), then resume: nothing plays during the hold, the deferred reply plays after it, and an unanswered approval is asked again;
  - `lost`, then "Resume call" (a new session; listeners survive).
  - an approval open at call start is asked at once; an approval raised during a hold is asked once on resume, never twice, and never paraphrased;
  - the pulse stops on hold and comes back on resume while work is still running;
  - the `callAudio` wrapper answers `true` (the watchdog contract).

**6.4 Playwright (`src/e2e/call-host.human.spec.ts`).** A fake `murageNative` that implements the four methods, in both the streamed and the Blob branches, covering a full native-path turn, a hold then resume, and the pulse going to native.

**6.5 Build checks.** `xcodebuild` of the iOS app (one at a time, on this Mac, because it needs Xcode), `pnpm build && pnpm sync`, `npx tsc -b --noEmit`, and the touched vitest files.

**6.6 On the device, with Sean, on the isolated test host (never his real Murage).**
- **Sound:** clean voice on the speaker and on wired headphones, and on AirPods compared with a FaceTime call.
- **Talk-over:** talking over the bot stops it, and the bot is never transcribed.
- **The pulse:** it plays during a long engine turn and is not transcribed.
- **Route changes:** AirPods in and out while the bot is mid-reply, and an A2DP-only speaker (checking echo).
- **Interruptions:** a phone call or FaceTime during the reply, Siri, a timer alarm, and pulling down Control Center.
- **Lifecycle:** lock and unlock mid-call, a reload mid-call, and a WebContent crash (Web Inspector).
- **Page media:** a chat voice message and an audio artifact started just before the call; the microphone stays live and nothing of them is transcribed. A voice message played before a call and after it sounds the same (the session is restored).
- **Start conditions:** a call started within 2 s of a cold launch, and a call with an approval already open.
- **Endurance:** a 5-minute call on AirPods.
- **Calibration:** the voice thresholds, checked from the `[call-diag]` numbers (`VOICE_RMS` and `SPEECH_FLOOR_RMS` were measured on Chromium's canceller).
- **Android:** the Samsung is spot-checked to confirm nothing changed.

## 7. Rollout

The shell and the page ship together: the web bundle served by the Mac, plus a new iPhone build.
- An old iPhone build with a new page doesn't list the methods, so it gets today's path.
- A new iPhone build with an old page never calls them, so it also gets today's path.

Nothing changes on the server. The kill switch turns the native path off from the page. The work lands on `mobile/v1`, and reaches Sean's real Murage only with the next installer, on his say, as E1 did.

## 8. Risks

- **Loudness.** `.voiceChat` on the speaker is quieter than media playback, and ChatGPT lives with this. The lever is the EQ `globalGain` (up to +24 dB) ahead of the limiter. The mixer's own volume cannot go above 1.0. It is not boosted by default.
- **The premise.** The spike (§6.0) measures the sound quality before the build depends on it.
- **The decoder** is the most intricate native piece. It has the most Swift tests (§6.1).
- **The frame event rate.** 15.6 `callAsyncJavaScript` calls a second is light. They arrive in order and are held back while the page is busy. If the device shows lag, two frames go per event.
- **Latency.** Taps arrive about every 100 ms, which adds up to about 100 ms to barge-in. If that matters, `setPreferredIOBufferDuration(0.02)` or `AVAudioSinkNode` is the lever.
- **Mic Mode.** Control Center's Mic Mode (Standard, Voice Isolation, Wide Spectrum) applies to voice-processing apps. Wide Spectrum weakens noise suppression and may affect barge-in. The mode is logged at open.

## 9. Later (not in this work)

- A call that keeps going while locked: native turn-taking and recognition (approach 2), with `UIBackgroundModes: audio`.
- On-device Apple recognition on the iPhone: live partial words, and no round trip to Flux.
- Keeping decoded audio across a route change, rather than cutting the sentence.
- A speaker and earpiece toggle. An Android native path if Android ever shows the problem.
- Gapless hand-off of the next sentence (today there is a small gap, which is also today's web behaviour).

## 10. Audit findings and where they landed

| Finding | Where |
|---|---|
| Native C1 / Web C2: page audio (the pulse) during the call, and WebKit taking over the session | §4.2.4 pulse, §4.2.5, §4.3.3, §6.3, §6.6 |
| Native C2: the premise has not been measured | §1, §6.0 spike gate (clarity and loudness) |
| Confirm N1: the reassert triggers itself | §4.2.5 (AND rule, rate limit, reducer input) |
| Confirm N2: restarts outside the hold set | §4.2.5, §4.2.6, §4.2.8, §4.2.9 |
| Confirm N3: a configuration change leaves the engine stopped | §4.2.6 |
| Confirm N4: an approval asked twice or paraphrased | §4.3.5 owed prompts |
| Confirm N5: the pulse does not come back | §4.3.5 |
| Confirm N6: `route` as barge-in | §4.1 (logging only), §4.3.5 bullet removed |
| Confirm N7: the session is left in voice chat | §4.2.2, §4.2.7 |
| Confirm partials: fixtures, watchdog answer, drain on begin, resume after lost | §4.1, §4.3.2, §4.3.5 |
| Confirm Minor M-1 to M-12 | §4.1 (play during hold), §4.3.1 (sample clock), §4.2.6 (inputs), §4.1/§4.3.2 (`inactive`), §4.2.2 step 7, step 5 (shared EQ), §4.2.2 (Bluetooth name), §4.2.4 (MP4, downmix), §4.3.5 (idle avatar, `lastSpeechAt`), §4.3.3 and §6.6 (page media) |
| Web C1: hold is not a real state | §4.3.5 |
| Native I1, I2: completion semantics, the end-of-clip rule | §4.2.4 Completion |
| Native I3 / Web I7: restart timing, stuck holds, lost, stale detection, warm-up | §4.2.6, §4.3.5 (`lost`, `resetDetection`, `firstSpokeAt`) |
| Native I4 / Web I6: the shared contract test | §4.1, §6.2 |
| Native I5: the microphone outliving the page | §4.2.7 |
| Native I6: threading | §4.2.1 |
| Native I7: setup order | §4.2.2 |
| Native I8: the streaming resampler | §4.2.3 |
| Native I9: the jitter buffer and underrun | §4.2.4 Jitter buffer |
| Native I10: gain cannot boost | §4.2.2 step 5, §8 |
| Native I11 / Web M5: AirPods quality, Bluetooth options | §2, §4.2.2 step 1 |
| Web I1: `this.stream` guards | §4.3.1 |
| Web I2: MediaSource on the iPhone | §4.3.4 |
| Web I3: held between clips, stall while paused | §4.1 `paused`, §4.3.4 |
| Web I4: `failed` compared with `cut` | §4.1, §4.3.4, §5 |
| Web I5: hello timing | §4.3.2 |
| Web I8: `useOutput` lifecycle | §4.3.4 Lifecycle |
| Web I9: MIME types | §4.1 Limits |
| Web I10: kill switch | §4.3.2, §7 |
| Native M1–M10, Web M1–M11 | §4.1 (session tokens, clip ids, one clip at a time, piece caps, the empty `last`), §4.2.8 (route source), §4.2.2 (fixed player format), §4.2.4 (decoder details), §4.1 (open is idempotent), §4.2.6 (duplicate lifecycle events), §4.2.10 (security, permission), §4.2.11 (log volume), §4.2.9 (media services), §8 (Mic Mode), §4.3.1 (sample-count timestamps), §4.3.2 (the denied note, try again), §4.3.5 (muted with held), §4.3.4 (group calls excluded), §6.6 (calibration, the extra device cases) |
