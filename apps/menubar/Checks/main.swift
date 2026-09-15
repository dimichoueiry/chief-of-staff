// Checks for Endpointing, WakePhrase and Placement, compiled with swiftc alongside the source files (tests/menubar-endpointing.test.ts).
import Foundation

var failures = 0
func check(_ label: String, _ ok: Bool) {
  print(ok ? "ok   \(label)" : "FAIL \(label)")
  if !ok { failures += 1 }
}

let t0 = Date(timeIntervalSince1970: 1_000_000)
func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }

// A thinking pause mid-sentence, with no new words for 1.6 s but the voice still going: not the end.
do {
  var e = Endpointing(pause: 2.5, now: at(0))
  e.recognized("what should I work on", at: at(1))
  e.voice(at: at(2.4))
  check("keeps listening 1.6 s after the last word while voice continues", !e.shouldEnd(at: at(2.6)))
  check("keeps listening through a 2 s thinking pause", !e.shouldEnd(at: at(4.3)))
  check("ends after 2.5 s of real quiet", e.shouldEnd(at: at(4.9)))
}

// Trailing off on a connector gets longer.
do {
  var e = Endpointing(pause: 2.5, now: at(0))
  e.recognized("I want to finish the landing page and", at: at(1))
  check("waits past the normal pause after a trailing 'and'", !e.shouldEnd(at: at(3.6)))
  check("still ends after the longer pause", e.shouldEnd(at: at(5.1)))
  check("a trailing comma counts", Endpointing.trailsOff("so first,"))
  check("a finished sentence doesn't", !Endpointing.trailsOff("Open the pricing board."))
  check("um counts", Endpointing.trailsOff("the thing is um"))
  check("a question ending in a preposition is finished", !Endpointing.trailsOff("what should I work on"))
}

// Voice-like noise with no new words holds the mic only a little longer.
do {
  var e = Endpointing(pause: 2.5, now: at(0))
  e.recognized("remind me friday", at: at(1))
  for s in stride(from: 1.0, through: 9.0, by: 0.2) { e.voice(at: at(s)) }
  check("noise alone doesn't hold it open past pause + stall", e.shouldEnd(at: at(6.1)))
  check("but not before", !e.shouldEnd(at: at(5.9)))
}

// Nothing said at all, and the hard cap.
do {
  let e = Endpointing(pause: 2.5, now: at(0))
  check("no words: waits for the no-speech timeout", !e.shouldEnd(at: at(11)))
  check("no words: gives up at 12 s", e.shouldEnd(at: at(12)))
  var long = Endpointing(pause: 2.5, now: at(0))
  for s in stride(from: 1.0, through: 130, by: 1) { long.recognized("word \(Int(s))", at: at(s)) }
  check("a long monologue isn't cut before two minutes", !long.shouldEnd(at: at(119)))
  check("the two-minute cap ends it", long.shouldEnd(at: at(120)))
}

// Words across recogniser stretches are kept.
do {
  var e = Endpointing(pause: 2.5, now: at(0))
  e.recognized("Let's talk about", at: at(1))
  e.recognized("Let's talk about the pricing", at: at(2))
  e.stretchEnded()
  e.recognized("for fampy", at: at(4))
  check("a closed stretch plus the next one", e.text == "Let's talk about the pricing for fampy")

  var r = Endpointing(pause: 2.5, now: at(0))
  r.recognized("I think we should launch the pro tier", at: at(1))
  r.recognized("next week", at: at(3))
  check("a recogniser that starts over keeps the earlier words", r.text == "I think we should launch the pro tier next week")

  var v = Endpointing(pause: 2.5, now: at(0))
  v.recognized("I want to", at: at(1))
  v.recognized("I wanna", at: at(1.2))
  check("a revision replaces, never duplicates", v.text == "I wanna")
}

// The wake phrase: the name and a command, as the recogniser writes them, misheard or not.
do {
  let darius = WakePhrase(name: "Darius")
  let said: [(String, WakeCommand?)] = [
    ("Darius wake up", .wake),
    ("Darius, wake up.", .wake),
    ("hey Darius", .wake),
    ("Okay Darius", .wake),
    ("Darius are you there?", .wake),
    ("Darias wake up", .wake),
    ("Dorius wakeup", .wake),
    ("Marius wake up", .wake),
    ("Dare us wake up", .wake),
    ("Darius listen", .listen),
    ("Darius, stop", .listen),
    ("Darius please listen to me", .listen),
    ("…and the second thing on your calendar is the Darius hold on", .listen),
    ("Darius sleep", .sleep),
    ("Darius go to sleep", .sleep),
    ("Darius, that’s all", .sleep),
    ("Darius's goodnight", .sleep),
    ("Darius wake up actually Darius sleep", .sleep),
    // Not for it:
    ("Darius", nil),
    ("I had lunch with Darius yesterday", nil),
    ("Darius said he would call", nil),
    ("we tried various stop points", nil),
    ("the arias were lovely, wake up early", nil),
    ("wake up", nil),
    ("listen to this", nil),
    ("hey there", nil),
    ("", nil),
  ]
  for (text, want) in said {
    check("\"\(text)\" → \(want.map(\.rawValue) ?? "nothing")", darius.find(in: text) == want)
  }
  check("another name works the same", WakePhrase(name: "Nova").find(in: "Nova sleep") == .sleep && WakePhrase(name: "Nova").find(in: "Darius sleep") == nil)
  check("hints teach the recogniser the name", darius.hints.contains("Darius wake up"))
}

// Where the pill's window goes when it's dragged or summoned.
do {
  let screen = CGRect(x: 0, y: 0, width: 1512, height: 944) // a laptop's visible area
  let size = CGSize(width: 700, height: 200)
  let home = Placement.frame(saved: nil, size: size, screens: [screen], fallback: screen)
  check("not moved: bottom-centre", home.midX == 756 && home.minY == 14)

  let corner = Placement.frame(saved: CGPoint(x: 1300, y: 700), size: size, screens: [screen], fallback: screen)
  check("a saved spot is used as is when it fits", corner.midX == 1300 && corner.minY == 700)

  let high = Placement.clamp(CGRect(x: 400, y: 900, width: 700, height: 200), into: screen)
  check("never off the top: the chat above the bar stays visible", high.maxY == 944 && high.minY == 744)
  let low = Placement.clamp(CGRect(x: 400, y: -80, width: 700, height: 200), into: screen)
  check("never off the bottom: the bar stays visible", low.minY == 0)
  let left = Placement.clamp(CGRect(x: -600, y: 100, width: 700, height: 200), into: screen)
  check("the wide window may hang off a side, but its middle stays on screen", left.midX == Placement.sideReach && left.minX < 0)
  let right = Placement.clamp(CGRect(x: 1400, y: 100, width: 700, height: 200), into: screen)
  check("same on the right", right.midX == 1512 - Placement.sideReach)
  let tall = Placement.clamp(CGRect(x: 400, y: 0, width: 700, height: 2000), into: screen)
  check("taller than the screen: cut to fit", tall.height == 944 && tall.minY == 0)

  let external = CGRect(x: 1512, y: 0, width: 2560, height: 1415)
  let there = Placement.frame(saved: CGPoint(x: 2500, y: 300), size: size, screens: [screen, external], fallback: screen)
  check("left on another display: it comes back there", there.midX == 2500 && there.minY == 300)
  let unplugged = Placement.frame(saved: CGPoint(x: 2500, y: 300), size: size, screens: [screen], fallback: screen)
  check("that display unplugged: home on this one", unplugged.midX == 756 && unplugged.minY == 14)
}

print(failures == 0 ? "all checks passed" : "\(failures) failed")
exit(failures == 0 ? 0 : 1)
