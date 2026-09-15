// Prints calendar events as JSON, read through EventKit so every account added
// to macOS Calendar (Google, iCloud, Exchange) comes back from one source.
//
// Usage: cos-calendar [FROM] [TO]     dates as YYYY-MM-DD, TO inclusive
//   no arguments   today
//   FROM only      that one day
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

let parser = DateFormatter()
parser.dateFormat = "yyyy-MM-dd"
parser.timeZone = TimeZone.current
parser.locale = Locale(identifier: "en_US_POSIX")

func day(_ index: Int) -> Date? {
  guard CommandLine.arguments.count > index else { return nil }
  guard let d = parser.date(from: CommandLine.arguments[index]) else {
    FileHandle.standardError.write("bad date \(CommandLine.arguments[index]); use YYYY-MM-DD\n".data(using: .utf8)!)
    exit(64)
  }
  return d
}

let cal = Calendar.current
let from = cal.startOfDay(for: day(1) ?? Date())
let lastDay = cal.startOfDay(for: day(2) ?? from)
guard lastDay >= from else {
  FileHandle.standardError.write("TO is before FROM\n".data(using: .utf8)!)
  exit(64)
}
let end = cal.date(byAdding: .day, value: 1, to: lastDay)!

// EventKit only searches up to four years per predicate; walk the range in yearly windows.
var events: [EKEvent] = []
var windowStart = from
while windowStart < end {
  let windowEnd = min(cal.date(byAdding: .year, value: 1, to: windowStart)!, end)
  events += store.events(matching: store.predicateForEvents(withStart: windowStart, end: windowEnd, calendars: nil))
  windowStart = windowEnd
}

var seen = Set<String>()
let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime]
var out: [[String: Any]] = []
for e in events.sorted(by: { $0.startDate < $1.startDate }) {
  // An event that spans a window boundary is returned twice.
  let key = "\(e.calendarItemIdentifier)|\(e.startDate.timeIntervalSince1970)"
  if seen.contains(key) { continue }
  seen.insert(key)
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
