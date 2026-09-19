import AVFoundation
import Speech

/// Native listening with Apple's speech recogniser, on-device when the Mac
/// supports it. Partial transcripts stream out. When you're done is decided by
/// Endpointing from the microphone level and the words, not by the recogniser:
/// if it closes a stretch on its own after a pause, listening carries on with a
/// fresh request and the earlier words are kept. No API key involved.
final class SpeechListener {
  var onPartial: (String) -> Void = { _ in }
  var onFinal: (String) -> Void = { _ in }
  var onLivePhrase: (String, String, Int) -> Void = { _, _, _ in }
  private(set) var liveSession: String?
  private var liveSequence = 0
  var onError: (String) -> Void = { _ in }
  /// Done listening, however it ended: the microphone is free again.
  var onIdle: () -> Void = {}

  /// Seconds of quiet that end what you're saying, unless ~/.cos/voice.json sets listenPause (`cos voice pause`).
  static let defaultPause: TimeInterval = 2.5

  private enum State { case idle, listening, settling }
  private var state = State.idle
  var listening: Bool { state != .idle }

  private let recognizer: SFSpeechRecognizer? = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
  private let engine = AVAudioEngine()
  /// The tap runs on the audio thread and feeds whichever request is current.
  private let lock = NSLock()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var ticker: Timer?
  private var settleTimer: Timer?
  private var endpoint = Endpointing(pause: SpeechListener.defaultPause)
  private var errors = 0
  private var lastError: String?
  /// Audio thread only.
  private var noiseFloor: Float?

  func authorize(_ done: @escaping (Bool) -> Void) {
    SFSpeechRecognizer.requestAuthorization { status in
      guard status == .authorized else {
        DispatchQueue.main.async { done(false) }
        return
      }
      AVCaptureDevice.requestAccess(for: .audio) { ok in DispatchQueue.main.async { done(ok) } }
    }
  }

  func start(liveSession: String? = nil) {
    guard state == .idle else { return }
    guard let recognizer, recognizer.isAvailable else {
      onError("Speech recognition is not available right now.")
      onIdle()
      return
    }
    self.liveSession = liveSession
    liveSequence = 0
    endpoint = Endpointing(pause: Self.savedPause() ?? Self.defaultPause)
    errors = 0
    lastError = nil
    noiseFloor = nil
    state = .listening
    beginStretch()

    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in self?.feed(buffer) }
    engine.prepare()
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      state = .idle
      teardown()
      onError("The microphone did not start: \(error.localizedDescription)")
      onIdle()
      return
    }
    ticker = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in self?.tick() }
  }

  /// Stop and deliver what was heard, after a moment for the last words to arrive (double-tap Control).
  func stop() { finish(deliver: true, settle: true) }

  /// Stop and throw away what was heard (Esc).
  func cancel() {
    if state == .settling {
      state = .idle
      settleTimer?.invalidate()
      settleTimer = nil
      teardown()
      onIdle()
    } else { finish(deliver: false) }
  }

  // MARK: recognition

  private func currentRequest() -> SFSpeechAudioBufferRecognitionRequest? {
    lock.lock()
    defer { lock.unlock() }
    return request
  }

  /// A fresh request and task for the audio from now on.
  private func beginStretch() {
    guard let recognizer else { return }
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    req.taskHint = .dictation
    req.addsPunctuation = true
    if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
    lock.lock()
    let oldRequest = request
    request = req
    lock.unlock()
    oldRequest?.endAudio()
    let oldTask = task
    task = recognizer.recognitionTask(with: req) { [weak self] result, error in
      DispatchQueue.main.async { self?.handle(req, result, error) }
    }
    oldTask?.cancel()
  }

  private func handle(_ req: SFSpeechAudioBufferRecognitionRequest, _ result: SFSpeechRecognitionResult?, _ error: Error?) {
    guard state != .idle, req === currentRequest() else { return } // a stretch we already moved past
    if let result {
      endpoint.recognized(result.bestTranscription.formattedString, at: Date())
      onPartial(endpoint.text)
      // What was heard can end the listen ("Darius sleep"): then there's nothing more to do here.
      guard state != .idle, result.isFinal else { return }
      if state == .settling {
        deliver()
      } else {
        // The recogniser closed this stretch after a pause. You may not be done: keep listening.
        endpoint.stretchEnded()
        beginStretch()
      }
    } else if let error {
      if state == .settling {
        deliver()
        return
      }
      errors += 1
      lastError = error.localizedDescription
      if errors > 5 {
        if liveSession != nil {
          onError("Live microphone stopped: \(error.localizedDescription)")
          cancel()
          return
        }
        finish(deliver: true)
        return
      }
      endpoint.stretchEnded()
      beginStretch()
    }
  }

  // MARK: audio

  private func feed(_ buffer: AVAudioPCMBuffer) {
    currentRequest()?.append(buffer)
    let db = Self.level(buffer)
    // The quietest recent level is the room; speech stands well above it. The floor creeps up slowly so steady noise isn't voice.
    let floor = noiseFloor.map { db < $0 ? db : min($0 + 0.03, db) } ?? db
    noiseFloor = floor
    if db > max(floor + 12, -55) {
      DispatchQueue.main.async { [weak self] in
        guard let self, self.state == .listening else { return }
        self.endpoint.voice(at: Date())
      }
    }
  }

  static func level(_ buffer: AVAudioPCMBuffer) -> Float {
    guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return -100 }
    let n = Int(buffer.frameLength)
    var sum: Float = 0
    for i in 0..<n { sum += samples[i] * samples[i] }
    return 20 * log10(max((sum / Float(n)).squareRoot(), 1e-7))
  }

  // MARK: ending

  private func tick() {
    if state == .listening, let session = liveSession {
      guard endpoint.livePhraseReady(at: Date()) else { return }
      let text = endpoint.text
      liveSequence += 1
      endpoint = Endpointing(pause: Self.defaultPause)
      // Replace only the recognition request. The audio engine and mic tap keep running.
      beginStretch()
      onLivePhrase(text, session, liveSequence)
      return
    }
    guard state == .listening, endpoint.shouldEnd(at: Date()) else { return }
    finish(deliver: true)
  }

  private func finish(deliver shouldDeliver: Bool, settle: Bool = false) {
    guard state == .listening else { return }
    ticker?.invalidate()
    ticker = nil
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    currentRequest()?.endAudio()
    guard shouldDeliver else {
      state = .idle
      teardown()
      onIdle()
      return
    }
    if settle {
      state = .settling
      settleTimer = Timer.scheduledTimer(withTimeInterval: 0.8, repeats: false) { [weak self] _ in self?.deliver() }
    } else {
      state = .settling
      deliver()
    }
  }

  private func deliver() {
    guard state == .settling else { return }
    state = .idle
    settleTimer?.invalidate()
    settleTimer = nil
    let text = endpoint.text
    teardown()
    if text.isEmpty, let lastError { onError(lastError) } else { onFinal(text) }
    onIdle()
  }

  private func teardown() {
    task?.cancel()
    task = nil
    lock.lock()
    request = nil
    lock.unlock()
  }

  /// `cos voice pause <seconds>` writes listenPause to ~/.cos/voice.json; read at the start of each listen.
  static func savedPause() -> TimeInterval? {
    let url = ShellConfig.home.appendingPathComponent("voice.json")
    guard let data = try? Data(contentsOf: url),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let seconds = object["listenPause"] as? Double
    else { return nil }
    return min(10, max(1, seconds))
  }
}
