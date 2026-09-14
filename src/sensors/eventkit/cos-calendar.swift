// Prints today's calendar events as JSON, read through EventKit so every
// account added to macOS Calendar (Google, iCloud, Exchange) comes back from
// one source. Usage: cos-calendar [YYYY-MM-DD]
import EventKit
import Foundation

let store = EKEventStore()
let gate = DispatchSemaphore(value: 0)
var granted = false
if #available(macOS 14.0, *) {
  store.requestFullAccessToEvents { ok, _ in granted = ok; gate.signal() }
} else {
  store.requestAccess(to: .event) { ok, _ in granted = ok; gate.signal() }
}
gate.wait()
guard granted else {
  FileHandle.standardError.write("calendar access denied\n".data(using: .utf8)!)
  exit(2)
}

var day = Date()
if CommandLine.arguments.count > 1 {
  let f = DateFormatter()
  f.dateFormat = "yyyy-MM-dd"
  f.timeZone = TimeZone.current
  if let d = f.date(from: CommandLine.arguments[1]) { day = d }
}
let cal = Calendar.current
let start = cal.startOfDay(for: day)
let end = cal.date(byAdding: .day, value: 1, to: start)!
let events = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: nil))

let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime]
var out: [[String: Any]] = []
for e in events.sorted(by: { $0.startDate < $1.startDate }) {
  out.append([
    "title": e.title ?? "",
    "start": iso.string(from: e.startDate),
    "end": iso.string(from: e.endDate),
    "allDay": e.isAllDay,
    "calendar": e.calendar.title,
    "location": e.location ?? "",
  ])
}
let data = try JSONSerialization.data(withJSONObject: out)
print(String(data: data, encoding: .utf8)!)
