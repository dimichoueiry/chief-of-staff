import Foundation
import UserNotifications

/// The heartbeat's messages as the app's own notifications, the way a message from a person
/// arrives: its question as the title, what it would do as the body. Clicking one opens the pill
/// on that chat. The server keeps them numbered; this asks for new ones every few seconds.
/// Without permission to notify, it says so when it asks, and the server falls back to macOS's
/// generic notification.
final class Notices: NSObject, UNUserNotificationCenterDelegate {
  private let server: ServerManager
  private var seq: Int?
  private var allowed = false
  /// A notification was clicked: the id of the chat it belongs to.
  var onOpen: ((String) -> Void)?

  init(server: ServerManager) { self.server = server }

  func start() {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, error in
      DispatchQueue.main.async { self?.allowed = granted }
      if let error { Log.write("notifications: \(error.localizedDescription)") }
      else if !granted { Log.write("notifications: not allowed; macOS's generic ones are used instead") }
    }
    Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.poll() }
    poll()
  }

  private func poll() {
    var parts = URLComponents(url: server.config.baseURL.appendingPathComponent("api/notices"), resolvingAgainstBaseURL: false)!
    parts.queryItems = [URLQueryItem(name: "shows", value: allowed ? "1" : "0")] + (seq.map { [URLQueryItem(name: "after", value: String($0))] } ?? [])
    guard let url = parts.url else { return }
    URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
      guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
      DispatchQueue.main.async { self?.received(obj) }
    }.resume()
  }

  private func received(_ obj: [String: Any]) {
    let first = seq == nil
    if let s = obj["seq"] as? Int { seq = s }
    // The first answer only says where the count is: what was said before the app opened isn't news.
    guard !first, allowed, let list = obj["notices"] as? [[String: Any]] else { return }
    for n in list {
      guard let id = n["id"] as? String, let title = n["title"] as? String else { continue }
      let content = UNMutableNotificationContent()
      content.title = title
      content.body = n["body"] as? String ?? ""
      content.sound = .default
      content.userInfo = ["conversation": n["conversation"] as? String ?? ""]
      UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { error in
        if let error { Log.write("notifications: couldn't show one: \(error.localizedDescription)") }
      }
    }
  }

  // Shown even while the app is the active one (a menubar app often is).
  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    done([.banner, .sound, .list])
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
    let id = response.notification.request.content.userInfo["conversation"] as? String ?? ""
    DispatchQueue.main.async { [weak self] in self?.onOpen?(id) }
    done()
  }
}
