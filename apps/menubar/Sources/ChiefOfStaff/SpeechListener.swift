import AVFoundation
import Speech

/// Native listening with Apple's speech recogniser, on-device when the Mac
/// supports it. Partial transcripts stream out; a short pause or a hard cap
/// ends the utterance. No API key involved.
final class SpeechListener {
  var onPartial: (String) -> Void = { _ in }
  var onFinal: (String) -> Void = { _ in }
  var onError: (String) -> Void = { _ in }
  var maxSeconds: TimeInterval = 20
  var silence: TimeInterval = 1.6

  private let recognizer: SFSpeechRecognizer? = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
  private let engine = AVAudioEngine()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var silenceTimer: Timer?
  private var capTimer: Timer?
  private var latest = ""
  private(set) var listening = false

  func authorize(_ done: @escaping (Bool) -> Void) {
    SFSpeechRecognizer.requestAuthorization { status in
      guard status == .authorized else {
        DispatchQueue.main.async { done(false) }
        return
      }
      AVCaptureDevice.requestAccess(for: .audio) { ok in DispatchQueue.main.async { done(ok) } }
    }
  }

  func start() {
    guard !listening else { return }
    guard let recognizer, recognizer.isAvailable else {
      onError("Speech recognition is not available right now.")
      return
    }
    latest = ""
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
    request = req

    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in req.append(buffer) }
    engine.prepare()
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      onError("The microphone did not start: \(error.localizedDescription)")
      return
    }
    listening = true
    armCap()

    task = recognizer.recognitionTask(with: req) { [weak self] result, error in
      DispatchQueue.main.async {
        guard let self, self.listening else { return }
        if let result {
          self.latest = result.bestTranscription.formattedString
          self.onPartial(self.latest)
          self.armSilence()
          if result.isFinal { self.finish(deliver: true) }
        } else if let error {
          self.finish(deliver: true, errorMessage: error.localizedDescription)
        }
      }
    }
  }

  /// Stop and deliver what was heard.
  func stop() { finish(deliver: true) }

  /// Stop and throw away what was heard (Esc).
  func cancel() { finish(deliver: false) }

  private func armSilence() {
    silenceTimer?.invalidate()
    silenceTimer = Timer.scheduledTimer(withTimeInterval: silence, repeats: false) { [weak self] _ in self?.finish(deliver: true) }
  }

  private func armCap() {
    capTimer?.invalidate()
    capTimer = Timer.scheduledTimer(withTimeInterval: maxSeconds, repeats: false) { [weak self] _ in self?.finish(deliver: true) }
  }

  private func finish(deliver: Bool, errorMessage: String? = nil) {
    guard listening else { return }
    listening = false
    silenceTimer?.invalidate()
    capTimer?.invalidate()
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    request?.endAudio()
    task?.cancel()
    task = nil
    request = nil
    guard deliver else { return }
    if latest.isEmpty, let errorMessage { onError(errorMessage) } else { onFinal(latest) }
  }
}
