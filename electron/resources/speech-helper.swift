// Native macOS speech-to-text helper. Streams NDJSON lines to stdout:
//   {"partial":true,"text":"…"}   while recognizing
//   {"partial":false,"text":"…"}  final result, then exit 0
//   {"error":"…"}                 then exit 1
// Runs until the final result or a per-session stop marker. Launched by
// electron/speech.mjs as this background app bundle so macOS can resolve the
// microphone and speech purpose strings in its Info.plist.
//
// `--pcm-file PATH` (call mode): do NOT open the microphone. The call screen
// captures it through Chromium, whose echo canceller removes the bot's own
// voice (Apple's voice processing cannot initialise with a USB mic and
// separate speakers, error -10875), and the main process appends that audio
// to PATH as 16 kHz mono signed 16-bit PCM. This helper tails the file and
// recognizes it. That is what lets the microphone stay open while the bot
// speaks, so the owner can talk over it.
//
// `--endpoint-ms N` ends the audio stream after N milliseconds without a
// transcript change. SFSpeechRecognizer does not finalize a buffer-backed
// request on silence by itself; it only produces `isFinal` after endAudio().
// Composer dictation omits this flag and keeps its existing press-to-stop
// behavior, while call mode opts into silence endpointing.
import AVFoundation
import Foundation
import Speech

func emit(_ obj: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: obj),
    let line = String(data: data, encoding: .utf8)
  {
    print(line)
    fflush(stdout)
  }
}

func fail(_ message: String) -> Never {
  emit(["error": message])
  exit(1)
}

// macOS can authorize this helper while system Dictation is switched off, and
// then reports kLSRErrorDomain 201. Keep that apart from other recognition
// failures so the app points at the right setting (upstream #2033).
func failRecognition(_ error: Error) -> Never {
  let nsError = error as NSError
  if nsError.domain == "kLSRErrorDomain" && nsError.code == 201 {
    fail("dictation-disabled")
  }
  fail("recognition-error")
}

let endpointMs: Int = {
  let args = CommandLine.arguments
  guard
    let index = args.firstIndex(of: "--endpoint-ms"),
    index + 1 < args.count,
    let value = Int(args[index + 1])
  else { return 0 }
  return min(5_000, max(250, value))
}()

/// Used instead of `endpointMs` while the transcript's last word sounds
/// unfinished (a breath mid-sentence). Never shorter than `endpointMs`.
let endpointLongMs: Int = {
  let args = CommandLine.arguments
  guard
    let index = args.firstIndex(of: "--endpoint-long-ms"),
    index + 1 < args.count,
    let value = Int(args[index + 1])
  else { return max(endpointMs, 2_800) }
  return max(endpointMs, min(8_000, max(250, value)))
}()

/// Words a clause cannot end on. The very same list as `UNFINISHED_WORDS`
/// in src/lib/call-turns.ts; a test keeps the two together.
let unfinishedWords: Set<String> = [
  "and", "but", "because", "so", "or", "then", "also", "plus", "if", "which", "while", "though", "although", "since", "until", "unless",
  "the", "a", "an",
  "to", "of", "with", "at", "by", "from", "about", "into",
  "my", "your", "is", "are", "was",
  "um", "uh", "er", "erm", "hmm",
]

/// True when the line sounds like the speaker will go on. The same four
/// rules as `soundsUnfinished` in src/lib/call-turns.ts, and both run the
/// table in src/lib/unfinished-cases.json:
/// 1. trailing whitespace is ignored;
/// 2. a trailing comma, "…" or "..." means unfinished;
/// 3. a sentence end (. ? !, then any closing quote or bracket) means done;
/// 4. otherwise the last token (split on whitespace and commas, stripped of
///    leading and trailing punctuation) is unfinished when the WHOLE token
///    is a listed word.
func soundsUnfinished(_ text: String) -> Bool {
  let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
  if line.isEmpty { return false }
  if line.hasSuffix(",") || line.hasSuffix("…") || line.hasSuffix("...") { return true }
  var end = Substring(line)
  while let last = end.last, "\"'”’)]".contains(last) { end = end.dropLast() }
  if let last = end.last, ".?!".contains(last) { return false }
  let token = line.split(whereSeparator: { $0.isWhitespace || $0 == "," }).last.map(String.init) ?? ""
  let word = token.drop(while: { !($0.isLetter || $0.isNumber) })
  var core = Substring(word)
  while let last = core.last, !(last.isLetter || last.isNumber) { core = core.dropLast() }
  return unfinishedWords.contains(core.lowercased())
}

let stopFile: String? = {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: "--stop-file"), index + 1 < args.count else { return nil }
  return args[index + 1]
}()

let pcmFile: String? = {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: "--pcm-file"), index + 1 < args.count else { return nil }
  return args[index + 1]
}()

// `--hint WORD` (repeatable): names the recognizer should expect, such as the
// bot being called. Without it "Hey Sable" was heard as "Disable".
let hints: [String] = {
  let args = CommandLine.arguments
  return args.indices.compactMap { i in
    args[i] == "--hint" && i + 1 < args.count ? String(args[i + 1].prefix(64)) : nil
  }
}()

let finishFile: String? = {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: "--finish-file"), index + 1 < args.count else { return nil }
  return args[index + 1]
}()

// LaunchServices gives the helper the bundle identity TCC needs, but it also
// means the parent cannot terminate it by killing the `open -W` process. A
// per-session stop marker keeps intentional mute/hang-up deterministic.
var stopTimer: DispatchSourceTimer?
if let stopFile {
  let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
  timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
  timer.setEventHandler {
    if FileManager.default.fileExists(atPath: stopFile) { exit(0) }
  }
  stopTimer = timer
  timer.resume()
}

// Push-to-talk release must finalize recognition rather than cancel it. The
// handler is installed once the audio engine exists; the timer keeps polling
// if an unusually fast key release beats authorization/setup.
var finishHandler: (() -> Void)?
// Held so the fed-mode reader is not released while it runs.
var pcmReader: DispatchSourceTimer?
var finishTimer: DispatchSourceTimer?
if let finishFile {
  let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
  timer.schedule(deadline: .now() + .milliseconds(50), repeating: .milliseconds(50))
  timer.setEventHandler {
    guard FileManager.default.fileExists(atPath: finishFile), let finish = finishHandler else { return }
    timer.cancel()
    finish()
  }
  finishTimer = timer
  timer.resume()
}

/// SFSpeechRecognizer can keep revising/re-emitting a partial transcript
/// after the user stops talking. Only a changed transcript resets the timer.
final class SilenceEndpointer {
  private let queue = DispatchQueue(label: "com.murage.speech.endpoint")
  private let gap: TimeInterval
  private let longGap: TimeInterval
  private let finish: () -> Void
  private var timer: DispatchSourceTimer?
  private var lastText = ""
  private var lastChange = DispatchTime.now()
  private var finished = false
  /// True once the turn ended on the long window.
  private(set) var usedLong = false

  init(gapMs: Int, longGapMs: Int, finish: @escaping () -> Void) {
    gap = Double(gapMs) / 1_000
    longGap = Double(max(gapMs, longGapMs)) / 1_000
    self.finish = finish
  }

  func start() {
    let source = DispatchSource.makeTimerSource(queue: queue)
    source.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
    source.setEventHandler { [weak self] in self?.tick() }
    timer = source
    source.resume()
  }

  func saw(_ text: String) {
    queue.async {
      guard !self.finished, !text.isEmpty, text != self.lastText else { return }
      self.lastText = text
      self.lastChange = .now()
    }
  }

  private func tick() {
    // Never terminate an empty turn: a call may be quiet for as long as the
    // user needs before they begin speaking.
    guard !finished, !lastText.isEmpty else { return }
    let silentFor = Double(DispatchTime.now().uptimeNanoseconds - lastChange.uptimeNanoseconds) / 1_000_000_000
    let unfinished = soundsUnfinished(lastText)
    guard silentFor >= (unfinished ? longGap : gap) else { return }
    usedLong = unfinished && longGap > gap
    finished = true
    timer?.cancel()
    timer = nil
    finish()
  }
}

/// What this session has heard. Apple can reset the transcript to "" after a
/// pause (or close a segment) and carry on in the same utterance, and can end
/// with an empty final or an error. The words before a reset are kept in
/// `committedText`, the words since in `currentText`; what is emitted, and
/// what a recovered final delivers, is both.
private var committedText = ""
private var currentText = ""
/// Set when Apple marks the segment it just reported as closed.
private var segmentClosed = false

private func joinText(_ a: String, _ b: String) -> String {
  if a.isEmpty { return b }
  if b.isEmpty { return a }
  return a + " " + b
}

private func ruleWords(_ t: String) -> [String] {
  t.lowercased().split(whereSeparator: { $0.isWhitespace }).map { w in
    var s = String(w)
    while let last = s.last, ".,?!".contains(last) { s.removeLast() }
    return s
  }.filter { !$0.isEmpty }
}

/// THE shared segment rule (also speech.mjs and call-turns.ts `restates`):
/// `text` restates `kept` when it is the same words, or those words followed
/// by more. Whole words, ignoring case and trailing punctuation.
private func restates(_ kept: String, _ text: String) -> Bool {
  let k = ruleWords(kept)
  if k.isEmpty { return false }
  let t = ruleWords(text)
  return t.count >= k.count && zip(k, t).allSatisfy { $0 == $1 }
}

private var heardText: String { joinText(committedText, currentText) }

private func commitCurrent() {
  guard !currentText.isEmpty else { return }
  committedText = joinText(committedText, currentText)
  currentText = ""
}

private func handleRecognition(_ result: SFSpeechRecognitionResult?, _ error: Error?, _ endpointer: SilenceEndpointer?) {
  if let result = result {
    let raw = result.bestTranscription.formattedString
    if raw.isEmpty {
      // reset: the words so far are kept in front of whatever comes next
      commitCurrent()
    } else {
      // a closed segment's next text is a new one, unless it only revises it
      if segmentClosed && !currentText.isEmpty && !restates(currentText, raw) {
        commitCurrent()
      }
      segmentClosed = false
      // Apple re-sends the kept words at the start of its next text after an
      // empty result, sometimes a word at a time: the kept words are not said twice
      if restates(committedText, raw) {
        committedText = ""
      }
      currentText = raw
    }
    if #available(macOS 14, *), !result.isFinal, result.speechRecognitionMetadata != nil {
      segmentClosed = true
    }
    let text = heardText
    endpointer?.saw(text)
    var event: [String: Any] = ["partial": !result.isFinal, "text": text]
    // tell the call the owner already waited the long window for this line
    if result.isFinal, endpointer?.usedLong == true { event["longEndpoint"] = true }
    emit(event)
    if result.isFinal { exit(0) }
  }
  if let error = error {
    if !heardText.isEmpty {
      var event: [String: Any] = ["partial": false, "text": heardText, "recovered": true]
      if endpointer?.usedLong == true { event["longEndpoint"] = true }
      emit(event)
      exit(0)
    }
    failRecognition(error)
  }
}

SFSpeechRecognizer.requestAuthorization { status in
  guard status == .authorized else { fail("speech-not-authorized") }
  // Recognize in the user's language: a hardcoded en-US recognizer
  // transcribes everyone else into nonsense. First preference that has an
  // available recognizer wins, with en-US as the last resort.
  let candidates =
    Locale.preferredLanguages.map { Locale(identifier: $0) }
    + [Locale.current, Locale(identifier: "en-US")]
  guard
    let recognizer = candidates.lazy.compactMap({ SFSpeechRecognizer(locale: $0) })
      .first(where: { $0.isAvailable })
  else { fail("recognizer-unavailable") }

  let request = SFSpeechAudioBufferRecognitionRequest()
  request.shouldReportPartialResults = true
  // Apple's own sentence-final punctuation tells a finished sentence from a
  // breath, so the short window is only used when it really ended.
  if #available(macOS 13, *) { request.addsPunctuation = true }
  if !hints.isEmpty { request.contextualStrings = Array(hints.prefix(20)) }
  if recognizer.supportsOnDeviceRecognition {
    request.requiresOnDeviceRecognition = true
  }

  if let pcmFile {
    // Fed mode: tail the PCM file the main process writes.
    guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)
    else { fail("pcm-format") }
    guard let handle = FileHandle(forReadingAtPath: pcmFile) else { fail("pcm-file-missing") }
    var audioFinished = false
    var carry = Data()
    let finishAudio = {
      DispatchQueue.main.async {
        guard !audioFinished else { return }
        audioFinished = true
        request.endAudio()
      }
    }
    finishHandler = finishAudio
    var endpointer: SilenceEndpointer?
    if endpointMs > 0 {
      endpointer = SilenceEndpointer(gapMs: endpointMs, longGapMs: endpointLongMs) { finishAudio() }
      endpointer?.start()
    }
    let reader = DispatchSource.makeTimerSource(queue: .main)
    reader.schedule(deadline: .now(), repeating: .milliseconds(20))
    reader.setEventHandler {
      guard !audioFinished else { reader.cancel(); return }
      let chunk = handle.readDataToEndOfFile()
      guard !chunk.isEmpty else { return }
      carry.append(chunk)
      let frames = carry.count / 2
      guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { return }
      buffer.frameLength = AVAudioFrameCount(frames)
      carry.withUnsafeBytes { raw in
        if let dst = buffer.int16ChannelData?[0], let src = raw.baseAddress {
          memcpy(dst, src, frames * 2)
        }
      }
      carry.removeFirst(frames * 2)
      request.append(buffer)
    }
    reader.resume()
    pcmReader = reader
    recognizer.recognitionTask(with: request) { result, error in
      handleRecognition(result, error, endpointer)
    }
    return
  }

  let engine = AVAudioEngine()
  let node = engine.inputNode
  var audioFinished = false
  let finishAudio = {
    DispatchQueue.main.async {
      guard !audioFinished else { return }
      audioFinished = true
      engine.stop()
      node.removeTap(onBus: 0)
      request.endAudio()
    }
  }
  finishHandler = finishAudio
  var endpointer: SilenceEndpointer?
  if endpointMs > 0 {
    endpointer = SilenceEndpointer(gapMs: endpointMs, longGapMs: endpointLongMs) {
      // Stop capture before ending the request: appending another audio
      // buffer after endAudio() can make the recognition task fail instead
      // of delivering its final transcript.
      finishAudio()
    }
    endpointer?.start()
  }
  node.installTap(onBus: 0, bufferSize: 1024, format: node.outputFormat(forBus: 0)) { buffer, _ in
    request.append(buffer)
  }
  do {
    engine.prepare()
    try engine.start()
  } catch { fail("mic-failed") }

  recognizer.recognitionTask(with: request) { result, error in
    handleRecognition(result, error, endpointer)
  }
}

RunLoop.main.run()
