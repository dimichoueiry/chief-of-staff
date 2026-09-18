import AVFoundation
import Speech

/// Listens in the background for "<name> <command>" (see WakePhrase).
///
/// Recognition runs on the Mac only: if this Mac can't recognise speech on-device, it doesn't run
/// at all, so nothing the microphone hears while waiting is ever sent anywhere. It never asks for
/// permissions itself; it runs once Microphone and Speech Recognition are on. It hands the
/// microphone to SpeechListener for a normal listen and is started again afterwards.
final class WakeListener {
  var onCommand: (WakeCommand) -> Void = { _ in }

  private(set) var running = false
  /// Why it isn't listening when it should be, for the menu.
  private(set) var problem: String?

  private var phrase = WakePhrase(name: "Darius")
  private let engine = AVAudioEngine()
  private var recognizer: SFSpeechRecognizer?
  private let lock = NSLock()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var startedAt = Date()
  private var heardAt = Date()
  private var firedAt = Date.distantPast
  private var quickFailures = 0
  private var timer: Timer?
  private var configObserver: NSObjectProtocol?

  static var permitted: Bool {
    SFSpeechRecognizer.authorizationStatus() == .authorized && AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
  }

  func start(name: String) {
    if WakePhrase(name: name).name != phrase.name {
      phrase = WakePhrase(name: name)
      if running { beginTask() } // the new name's hints
    }
    guard !running else { return }
    guard Self.permitted else {
      problem = MicSpeechCopy.problem(
        microphoneGranted: AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
        speechGranted: SFSpeechRecognizer.authorizationStatus() == .authorized
      ) ?? "Microphone or Speech Recognition is off"
      return
    }
    let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    guard let recognizer, recognizer.supportsOnDeviceRecognition else {
      problem = "this Mac can't recognise speech on-device for your language"
      return
    }
    self.recognizer = recognizer

    let input = engine.inputNode
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 2048, format: input.outputFormat(forBus: 0)) { [weak self] buffer, _ in
      self?.currentRequest()?.append(buffer)
    }
    engine.prepare()
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      problem = "the microphone didn't start: \(error.localizedDescription)"
      Log.write("wake: \(problem!)")
      return
    }
    running = true
    problem = nil
    quickFailures = 0
    beginTask()
    timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.check() }
    // Headphones plugged in or the input changed: the engine stops, so start over on the new device.
    configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
      guard let self, self.running else { return }
      let name = self.phrase.name
      self.stop()
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.start(name: name) }
    }
    Log.write("wake: listening for \(phrase.name)")
  }

  func stop() {
    guard running else { return }
    running = false
    timer?.invalidate()
    timer = nil
    if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
    configObserver = nil
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    currentRequest()?.endAudio()
    task?.cancel()
    task = nil
    lock.lock()
    request = nil
    lock.unlock()
  }

  // MARK: recognition

  private func currentRequest() -> SFSpeechAudioBufferRecognitionRequest? {
    lock.lock()
    defer { lock.unlock() }
    return request
  }

  /// A fresh request: after a command (so the same words don't fire twice), and regularly, so the transcript stays short.
  private func beginTask() {
    guard let recognizer else { return }
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    req.requiresOnDeviceRecognition = true
    req.contextualStrings = phrase.hints
    req.taskHint = .search
    lock.lock()
    let old = request
    request = req
    lock.unlock()
    old?.endAudio()
    let oldTask = task
    startedAt = Date()
    task = recognizer.recognitionTask(with: req) { [weak self] result, error in
      DispatchQueue.main.async { self?.handle(req, result, error) }
    }
    oldTask?.cancel()
  }

  private func handle(_ req: SFSpeechAudioBufferRecognitionRequest, _ result: SFSpeechRecognitionResult?, _ error: Error?) {
    guard running, req === currentRequest() else { return }
    if let result {
      quickFailures = 0
      heardAt = Date()
      if let command = phrase.find(in: result.bestTranscription.formattedString), Date().timeIntervalSince(firedAt) > 1.5 {
        firedAt = Date()
        Log.write("wake: heard \(command.rawValue)")
        beginTask()
        onCommand(command)
        return
      }
      if result.isFinal { beginTask() }
    } else if error != nil {
      // A quiet room ends tasks too. Start again; if they keep failing at once, wait a little between tries.
      quickFailures = Date().timeIntervalSince(startedAt) < 1 ? quickFailures + 1 : 0
      let wait = quickFailures >= 3 ? 5.0 : 0.1
      DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
        guard let self, self.running, req === self.currentRequest() else { return }
        self.beginTask()
      }
    }
  }

  /// Every few seconds: restart the engine if macOS stopped it (sleep, a device change), and start a fresh
  /// task after half a minute, in a quiet moment so a phrase isn't cut in two.
  private func check() {
    guard running else { return }
    if !engine.isRunning {
      let name = phrase.name
      stop()
      start(name: name)
      return
    }
    if Date().timeIntervalSince(startedAt) > 30, Date().timeIntervalSince(heardAt) > 1.5 { beginTask() }
  }
}
