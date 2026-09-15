// Plays one audio file and exits the moment it has played out.
//
// afplay keeps running (and its audio output open) about a second after a file's last
// sample, so every sentence ended with a second of dead air and the turn chime and mic
// came late. This ends with the sound. Killing it stops the sound at once.
//
// Usage: cos-play <file>   exit 0 when played, 1 if it can't play, 2 on bad usage.
import AVFoundation
import Foundation

final class Finish: NSObject, AVAudioPlayerDelegate {
  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    usleep(30_000) // the last buffer still leaving the device
    exit(flag ? 0 : 1)
  }

  func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
    exit(1)
  }
}

guard CommandLine.arguments.count == 2 else { exit(2) }
guard let player = try? AVAudioPlayer(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])) else { exit(1) }
let finish = Finish()
player.delegate = finish
player.prepareToPlay()
guard player.play() else { exit(1) }
RunLoop.main.run()
