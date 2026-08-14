// Native macOS speech-to-text helper. Streams NDJSON lines to stdout:
//   {"partial":true,"text":"…"}   while recognizing
//   {"partial":false,"text":"…"}  final result, then exit 0
//   {"error":"…"}                 then exit 1
// Runs until the final result or SIGTERM. Spawned by electron/speech.mjs
// from the MAIN process so mic + speech TCC prompts attribute to the app.
//
// `--endpoint-ms N` turns on silence endpointing: after N milliseconds with
// no new words, the utterance is ended and a final result is delivered.
// Without the flag the helper behaves exactly as before — it listens until
// it is stopped — because the composer's press-to-dictate depends on that.
//
// This is not optional cleverness. SFSpeechRecognizer does NOT finalize on
// silence when it is fed from an audio buffer: `isFinal` arrives when the
// audio stream ENDS, and the stream only ends when something calls
// endAudio(). Anything that wants turn-taking has to detect the pause
// itself, which is what Endpointer below does.
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

/// Ends the utterance once the words stop changing — the endpointing the
/// recognizer does not do for a buffer request.
final class Endpointer {
  private let queue = DispatchQueue(label: "com.openmausbot.speech.endpoint")
  private let request: SFSpeechAudioBufferRecognitionRequest
  private let gap: TimeInterval
  private var timer: DispatchSourceTimer?
  private var lastText = ""
  private var lastChange = Date()
  private var ended = false

  init(request: SFSpeechAudioBufferRecognitionRequest, gapMs: Int) {
    self.request = request
    self.gap = Double(gapMs) / 1000
  }

  func start() {
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now() + .milliseconds(150), repeating: .milliseconds(150))
    t.setEventHandler { [weak self] in self?.tick() }
    timer = t
    t.resume()
  }

  /// Called with every partial. Only a CHANGE counts as speech — the
  /// recognizer keeps re-emitting the same string while you are silent.
  func saw(_ text: String) {
    queue.async {
      guard text != self.lastText else { return }
      self.lastText = text
      self.lastChange = Date()
    }
  }

  private func tick() {
    // nothing said yet: keep waiting rather than ending an empty turn the
    // moment the microphone opens
    guard !ended, !lastText.isEmpty else { return }
    guard Date().timeIntervalSince(lastChange) >= gap else { return }
    ended = true
    timer?.cancel()
    timer = nil
    request.endAudio()  // this is what makes isFinal arrive
  }
}

let endpointMs: Int = {
  let args = CommandLine.arguments
  guard let i = args.firstIndex(of: "--endpoint-ms"), i + 1 < args.count, let value = Int(args[i + 1])
  else { return 0 }
  return max(0, value)
}()

var endpointer: Endpointer?

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
  if recognizer.supportsOnDeviceRecognition {
    request.requiresOnDeviceRecognition = true
  }

  if endpointMs > 0 {
    let e = Endpointer(request: request, gapMs: endpointMs)
    endpointer = e
    e.start()
  }

  let engine = AVAudioEngine()
  let node = engine.inputNode
  node.installTap(onBus: 0, bufferSize: 1024, format: node.outputFormat(forBus: 0)) { buffer, _ in
    request.append(buffer)
  }
  do {
    engine.prepare()
    try engine.start()
  } catch { fail("mic-failed") }

  recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
      let text = result.bestTranscription.formattedString
      endpointer?.saw(text)
      emit(["partial": !result.isFinal, "text": text])
      if result.isFinal { exit(0) }
    }
    if error != nil { fail("recognition-error") }
  }
}

RunLoop.main.run()
