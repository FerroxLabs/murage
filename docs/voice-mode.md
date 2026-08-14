# Voice in OpenMausBot

Decision doc, 2026-08-14. How bots speak, and how you hold a conversation with
one. Based on a survey of hosted and local TTS, streaming STT, and turn
detection, measured against what this codebase already has.

## TL;DR architecture

```
Renderer (src/)                          Harness (server/)
├── lib/tts/local.ts   Kokoro-82M ──┐    ├── tts/speech-text.ts  markdown → speakable
│     WebGPU / WASM, no key         │    ├── tts/elevenlabs.ts   ─┐ hosted, key-holding
├── lib/tts/index.ts   speaker      ├───▶├── tts/cartesia.ts     ─┘
│     queue · prefetch · barge-in   │    └── tts/index.ts        registry + fallback
└── components/CallView.tsx         │
      Apple STT endpointing ────────┘    POST /api/tts/prepare → utterances
                                          POST /api/tts/speak   → audio bytes (or 409)
```

- **Two tiers, one SPI.** `server/tts/types.ts` mirrors the driver SPI in
  `contracts.ts`: adding a voice is one file plus a line in the registry, and an
  unknown provider from a newer build degrades to the local voice instead of
  going silent.
- **Splitting text into utterances happens on the harness**, not the renderer.
  Both tiers need the same split, and the spoken-register transform is the piece
  most likely to be tuned against real transcripts — the same reasoning that
  puts `approvalKey` server-side.
- **Turn detection costs nothing.** `SFSpeechRecognizer`'s `result.isFinal`
  *is* endpointing, and it already streams to the renderer.

## Where each tier runs, and why it is not a coin flip

| | Runs on | Reason |
| --- | --- | --- |
| **Kokoro (local)** | renderer | No key to protect. And `electron-builder.yml` ships the app with `!**/node_modules/**`, so anything the main process or the compiled server imports has to survive that exclusion — the renderer's deps are bundled by Vite into `dist/`, shipped whole as `Resources/ui`. This is the one dependency that must not walk into the packaging trap that already breaks local computer use. |
| **ElevenLabs / Cartesia** | harness | The key must never reach the renderer. `GET /api/config` returns configured-or-not booleans and nothing else, and that invariant is worth more than a saved round trip. |

`speak()` throws `ClientSideVoice` when the active provider runs in the
renderer, and the route turns that into a 409 the client understands as "this
one is yours". The decision lives in exactly one place, so the two sides can
never disagree about who is speaking.

## Provider choices

**Kokoro-82M** is the default and the reason voice is not a paid feature. An
82M-parameter StyleTTS2-class model, Apache-2.0, that topped TTS Arena and
scores level with hosted APIs on UTMOS. Its known weakness is a flat emotional
range — which is exactly right for a digest read in the kitchen, and exactly why
call mode is worth a hosted key when you want each bot to sound like someone.

Rejected on the way:

| Option | Verdict |
| --- | --- |
| macOS / Windows OS voices | ✗ audibly synthetic; would cheapen the feature on first launch |
| Piper | ✗ same complaint, one tier up |
| Chatterbox (Resemble, MIT) | ✗ better than ElevenLabs in their own blind study, but Turbo wants 8GB+ VRAM — the same reason `computer-server` was rejected for computer use. A fine opt-in later, never the default. |
| ElevenLabs Agents / OpenAI Realtime | ✗ see below |
| **Kokoro + BYO hosted** | ✓ free default, paid personality |

The hosted pair is deliberate rather than redundant: Cartesia is the latency and
cost tier (lowest published TTFB, roughly a fifth the price), ElevenLabs is the
realism tier. Both take a dated API version and versioned model ids, so both are
config-overridable (`tts.options.model`, `tts.options.version`) — when a provider
rolls either forward, a user keeps working instead of waiting for a release.

## Why not a turnkey voice-agent platform

ElevenLabs Agents accepts a custom LLM over an OpenAI-compatible endpoint, so in
principle it could own the whole loop. Two blockers:

1. Its `cascade_timeout_seconds` maxes at **15 seconds**. Agent turns here
   routinely exceed that; it would fail over on every real turn.
2. It wants to own turn-taking, interruption and tool calls — which is precisely
   what the harness owns, along with permissions and recursion limits.

Same verdict on native speech-to-speech (OpenAI Realtime, Gemini Live): they
replace the brain, and the brain being Claude Code on your own machine *is* the
product.

## Call mode

**Half-duplex, on purpose.** The dictation helper is `SFSpeechRecognizer` on raw
`AVAudioEngine` input with no acoustic echo cancellation. A microphone left open
through playback transcribes the bot's own voice back into the conversation and
the two of them talk forever. So the mic is live only when the bot is not
speaking, and interrupting is a tap, the Space bar, or Escape. Full-duplex
barge-in needs AEC on the capture path — a real follow-up, not a footnote.

**Narration is what makes it bearable.** An agent turn is 5–60 seconds of tool
calls, and silence that long reads as a dropped call. Every activity chip the
harness narrates is read aloud as it happens, so waiting sounds like listening to
someone work. The phrase is computed once, server-side, into `tool.spoken` at
fold time — so the chip you see and the phrase you hear cannot drift apart.

**Approvals are spoken.** A `request.opened` card is read out and answered with
"yes"/"no". Anything that is not clearly a decision is refused and re-asked:
consent must never be inferred from a sentence that merely contained the word
"sure".

**Latency, honestly.** Endpointing is 300–700ms and TTS time-to-first-byte is
40–250ms, against an agent turn of 5–60s. The agent dominates by 50–100x, so the
hosted-vs-local choice is a quality decision, not a latency one. The way to make
a call feel conversational is to put the bot you call on a fast model and let it
delegate real work to specialists over `ask_bot` — no new machinery required.

## Known gaps

- **ort/model weights are fetched on first use.** transformers.js pulls the ONNX
  runtime and the ~26MB q8 weights from the network once, then caches them in the
  browser Cache API — offline forever after. Bundling both into `extraResources`
  would make the very first run offline too; it is a packaging task, not a design
  change.
- **Calls are macOS-only**, because dictation is. The Windows PowerShell speech
  helper would extend it; the voice half already works everywhere.
- **Rooms don't speak yet.** Per-bot voices exist (`bot.voice`), so a room where
  each member sounds like themselves is wiring, not design.
- **No spend meter.** A hosted voice bills per character. Auto-speak is off by
  default for that reason, but the app should eventually show what it has spent.

## Rollout order

1. Speak button on any message + per-bot auto-speak (this PR).
2. Call mode: endpointing, narration, spoken approvals, mascot (this PR).
3. Bundle ort + weights so the first run is offline too.
4. Rooms on a call — distinct voice per member.
5. AEC on the capture path, for true voice barge-in.
