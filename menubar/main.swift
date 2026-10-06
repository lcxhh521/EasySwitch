// EasySwitch menu bar. A separate native process on purpose: "back to native"
// must work even when the core service is down or broken.
import AppKit
import WebKit

let corePort = 18765
let coreURL = URL(string: "http://127.0.0.1:\(corePort)")!
// Codex sessions carry the provider override, Claude Code sessions the --settings env marker.
let sessionPattern = "model_providers.easyswitch|EASYSWITCH_SESSION"

func infoString(_ key: String) -> String? {
  Bundle.main.object(forInfoDictionaryKey: key) as? String
}

@discardableResult
func shell(_ launchPath: String, _ args: [String]) -> (status: Int32, output: String) {
  let task = Process()
  task.executableURL = URL(fileURLWithPath: launchPath)
  task.arguments = args
  let pipe = Pipe()
  task.standardOutput = pipe
  task.standardError = pipe
  do { try task.run() } catch { return (-1, "\(error)") }
  task.waitUntilExit()
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  return (task.terminationStatus, String(decoding: data, as: UTF8.self))
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private var coreProcess: Process?
  private var healthy = false
  private var window: NSWindow?
  private var timer: Timer?
  /// Right click (or a stopped core) shows this native menu; it never needs the core.
  private var menu = NSMenu()
  private var popover: NSPopover?

  func applicationDidFinishLaunching(_ notification: Notification) {
    statusItem.button?.target = self
    statusItem.button?.action = #selector(statusClicked(_:))
    statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
    refreshHealth()
    timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refreshHealth() }
  }

  // MARK: Health

  private func refreshHealth() {
    var request = URLRequest(url: coreURL.appendingPathComponent("health"))
    request.timeoutInterval = 1.5
    URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
      let ok = (response as? HTTPURLResponse)?.statusCode == 200 && data != nil
      DispatchQueue.main.async {
        self?.healthy = ok
        self?.rebuildMenu()
      }
    }.resume()
  }

  // MARK: Menu

  private func rebuildMenu() {
    statusItem.button?.title = healthy ? "⇄ ●" : "⇄ ○"
    statusItem.button?.toolTip = healthy ? "EasySwitch 运行中" : "EasySwitch 核心服务未运行"
    let menu = NSMenu()
    let status = NSMenuItem(title: healthy ? "核心服务：运行中（端口 \(corePort)）" : "核心服务：未运行", action: nil, keyEquivalent: "")
    status.isEnabled = false
    menu.addItem(status)
    let sessions = augmentedSessionPids().count
    let sessionsItem = NSMenuItem(title: "增强会话：\(sessions) 个运行中", action: nil, keyEquivalent: "")
    sessionsItem.isEnabled = false
    menu.addItem(sessionsItem)
    menu.addItem(.separator())
    if healthy {
      menu.addItem(item("打开控制台", #selector(openConsole), "o"))
      menu.addItem(item("启动 ChatGPT增强会话", #selector(launchCodex), "l"))
      menu.addItem(item("启动 Claude Code 增强会话", #selector(launchClaude), "k"))
      menu.addItem(item("停止核心服务", #selector(stopCore), ""))
    } else {
      menu.addItem(item("启动核心服务", #selector(startCore), "s"))
    }
    menu.addItem(.separator())
    menu.addItem(item("全部退回原生", #selector(backToNative), "r"))
    menu.addItem(item("检查原生配置", #selector(checkNative), ""))
    menu.addItem(.separator())
    menu.addItem(item("退出 EasySwitch", #selector(quit), "q"))
    self.menu = menu
  }

  // MARK: Status item: panel on left click, native menu on right click or when the core is down

  @objc private func statusClicked(_ sender: NSStatusBarButton) {
    let right = NSApp.currentEvent?.type == .rightMouseUp
    if right || !healthy {
      popover?.performClose(nil)
      statusItem.menu = menu
      statusItem.button?.performClick(nil)
      statusItem.menu = nil
      return
    }
    if let popover, popover.isShown {
      popover.performClose(nil)
      return
    }
    let panel = popover ?? makePopover()
    popover = panel
    (panel.contentViewController?.view as? WKWebView)?.load(URLRequest(url: URL(string: "http://127.0.0.1:\(corePort)/?panel=1")!))
    panel.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minY)
    NSApp.activate(ignoringOtherApps: true)
  }

  private func makePopover() -> NSPopover {
    let config = WKWebViewConfiguration()
    config.userContentController.add(self, name: "easyswitch")
    let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 460, height: 300), configuration: config)
    web.setValue(false, forKey: "drawsBackground")
    let controller = NSViewController()
    controller.view = web
    let panel = NSPopover()
    panel.contentViewController = controller
    panel.contentSize = NSSize(width: 460, height: 300)
    panel.behavior = .transient
    return panel
  }

  /// Messages from the panel page; the actions themselves stay native.
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let action = message.body as? String else { return }
    popover?.performClose(nil)
    switch action {
    case "openConsole": openConsole()
    case "backToNative": backToNative()
    case "quit": quit()
    default: break
    }
  }

  private func item(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
    let menuItem = NSMenuItem(title: title, action: action, keyEquivalent: key)
    menuItem.target = self
    return menuItem
  }

  // MARK: Core lifecycle

  @objc private func startCore() {
    guard let repo = infoString("EasySwitchRepo"), let node = infoString("EasySwitchNode") else {
      problem("启动配置还没准备好", "安装时没有保存程序位置。请打开控制台查看安装说明，重新安装后再试。")
      return
    }
    let task = Process()
    task.executableURL = URL(fileURLWithPath: node)
    task.arguments = ["\(repo)/core/src/main.ts"]
    task.currentDirectoryURL = URL(fileURLWithPath: repo)
    let logDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/EasySwitch")
    try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
    let logURL = logDir.appendingPathComponent("core.log")
    if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
    if let handle = try? FileHandle(forWritingTo: logURL) {
      handle.seekToEndOfFile()
      task.standardOutput = handle
      task.standardError = handle
    }
    do {
      try task.run()
      coreProcess = task
    } catch {
      problem("暂时无法启动服务", "本地程序可能已移除，或没有运行权限。请打开控制台检查安装位置后重试。")
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.refreshHealth() }
  }

  @objc private func stopCore() {
    if let process = coreProcess, process.isRunning {
      process.terminate()
    } else {
      // Started elsewhere (for example from a terminal): stop whoever listens on our port.
      let (_, out) = shell("/usr/sbin/lsof", ["-t", "-iTCP:\(corePort)", "-sTCP:LISTEN"])
      for pid in out.split(separator: "\n").compactMap({ Int32($0) }) { kill(pid, SIGTERM) }
    }
    coreProcess = nil
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.refreshHealth() }
  }

  // MARK: Actions

  @objc private func openConsole() {
    if window == nil {
      let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 760))
      let win = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
      win.title = "EasySwitch"
      win.contentView = web
      win.isReleasedWhenClosed = false
      win.center()
      window = win
    }
    (window?.contentView as? WKWebView)?.load(URLRequest(url: coreURL))
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  @objc private func launchCodex() { launch("codex") }
  @objc private func launchClaude() { launch("claude") }

  private func launch(_ harness: String) {
    var request = URLRequest(url: coreURL.appendingPathComponent("api/launch/\(harness)"))
    request.httpMethod = "POST"
    request.setValue("1", forHTTPHeaderField: "x-easyswitch")
    URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
      let code = (response as? HTTPURLResponse)?.statusCode ?? 0
      let payload = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
      let issue = payload?["uiError"] as? [String: Any]
      let message = issue?["message"] as? String ?? "本地服务或启动程序暂时不可用。请打开控制台检查连接和安装状态后重试。"
      DispatchQueue.main.async {
        if code != 200 { self?.problem("没能启动增强会话", message) }
        self?.refreshHealth()
      }
    }.resume()
  }

  private func augmentedSessionPids() -> [Int32] {
    let (_, out) = shell("/usr/bin/pgrep", ["-f", sessionPattern])
    return out.split(separator: "\n").compactMap { Int32($0) }.filter { $0 != getpid() }
  }

  /// Ends every augmented session and stops the core. Native configuration was
  /// never changed, so there is nothing to restore; we verify that instead.
  @objc private func backToNative() {
    let pids = augmentedSessionPids()
    for pid in pids { kill(pid, SIGTERM) }
    stopCore()
    let report = nativeReport()
    alert("已全部退回原生", "结束了 \(pids.count) 个增强会话，核心服务已停止。\n\n\(report)")
  }

  @objc private func checkNative() {
    alert("原生配置检查", nativeReport())
  }

  private func nativeReport() -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let files = [("ChatGPT", "\(home)/.codex/config.toml"), ("Claude Code", "\(home)/.claude/settings.json")]
    return files.map { name, path in
      guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return "\(name)：配置文件不存在" }
      let clean = text.range(of: "easyswitch", options: .caseInsensitive) == nil
      return "\(name)：\(clean ? "无 EasySwitch 痕迹 ✓" : "发现 EasySwitch 痕迹 ✗")"
    }.joined(separator: "\n")
  }

  @objc private func quit() {
    if let process = coreProcess, process.isRunning { process.terminate() }
    NSApp.terminate(nil)
  }

  private func problem(_ title: String, _ text: String) {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = text
    a.addButton(withTitle: "打开控制台")
    a.addButton(withTitle: "稍后处理")
    NSApp.activate(ignoringOtherApps: true)
    if a.runModal() == .alertFirstButtonReturn { openConsole() }
  }

  private func alert(_ title: String, _ text: String) {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = text
    NSApp.activate(ignoringOtherApps: true)
    a.runModal()
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
