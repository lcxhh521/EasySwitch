// EasySwitch menu bar. A separate native process on purpose: "back to native"
// must work even when the core service is down or broken.
import AppKit
import WebKit
import ServiceManagement

let corePort = 18765
let coreURL = URL(string: "http://127.0.0.1:\(corePort)")!

func isCoreHealth(_ data: Data?, _ response: URLResponse?) -> Bool {
  guard (response as? HTTPURLResponse)?.statusCode == 200, let data, data.count <= 65536,
        let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
  return (value["service"] as? String) == "easyswitch" && (value["ok"] as? Bool) == true
}

func infoString(_ key: String) -> String? {
  Bundle.main.object(forInfoDictionaryKey: key) as? String
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private var coreProcess: Process?
  private var coreInput: Pipe?
  private var startingCore = false
  private var quitting = false
  private var cliInstallProcess: Process?
  private var activeConnections: Int?
  private var returnToNativeRequested = false
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
    startCore()
    refreshHealth()
    timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refreshHealth() }
  }

  // MARK: Health

  private func refreshHealth() {
    var request = URLRequest(url: coreURL.appendingPathComponent("health"))
    request.timeoutInterval = 1.5
    URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
      let ok = isCoreHealth(data, response)
      DispatchQueue.main.async {
        self?.healthy = ok
        if ok { self?.refreshConnections() } else { self?.activeConnections = nil }
        self?.rebuildMenu()
      }
    }.resume()
  }

  private func refreshConnections() {
    var request = URLRequest(url: coreURL.appendingPathComponent("api/gateway/sessions"))
    request.setValue("1", forHTTPHeaderField: "x-easyswitch")
    request.timeoutInterval = 1.5
    URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
      let payload = data.flatMap { $0.count <= 524288 ? (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] : nil }
      let sessions = payload?["sessions"] as? [[String: Any]]
      DispatchQueue.main.async {
        guard let self, self.healthy else { return }
        self.activeConnections = (response as? HTTPURLResponse)?.statusCode == 200 ? sessions?.count : nil
        self.rebuildMenu()
      }
    }.resume()
  }

  /// MenubarOn / MenubarOff (with an @2x) from the app's Resources; nil when the app was built without them.
  private static func menubarImage(running: Bool) -> NSImage? {
    let name = running ? "MenubarOn" : "MenubarOff"
    guard let path = Bundle.main.path(forResource: name, ofType: "png"), let image = NSImage(contentsOfFile: path) else { return nil }
    if let big = Bundle.main.path(forResource: "\(name)@2x", ofType: "png"), let rep = NSImageRep(contentsOfFile: big) { image.addRepresentation(rep) }
    image.size = NSSize(width: 18, height: 18)
    image.isTemplate = true
    return image
  }

  // MARK: Menu

  private func rebuildMenu() {
    // The mark: the cloud with a prompt whose underscore is a switch; switched on (solid) while the core service runs, off (hollow) when it does not.
    // A template image, so the system colours it for light, dark and highlighted menu bars. The text is only a fallback.
    if let image = Self.menubarImage(running: healthy) {
      statusItem.button?.image = image
      statusItem.button?.title = ""
    } else {
      statusItem.button?.title = healthy ? "⇄ ●" : "⇄ ○"
    }
    statusItem.button?.toolTip = healthy ? "EasySwitch 运行中" : "EasySwitch 核心服务未运行"
    let menu = NSMenu()
    let status = NSMenuItem(title: healthy ? "核心服务：运行中（端口 \(corePort)）" : "核心服务：未运行", action: nil, keyEquivalent: "")
    status.isEnabled = false
    menu.addItem(status)
    let sessionsItem = NSMenuItem(title: activeConnections.map { "有效连接：\($0) 个" } ?? "有效连接：未读取", action: nil, keyEquivalent: "")
    sessionsItem.toolTip = "按网关签发记录统计，不代表客户端程序仍在运行。"
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
    let settings = NSMenu()
    let login = item("开机自动启动", #selector(toggleLoginItem), "")
    login.state = SMAppService.mainApp.status == .enabled ? .on : .off
    if SMAppService.mainApp.status == .requiresApproval { login.title = "开机自动启动（等待系统批准）"; login.state = .mixed }
    settings.addItem(login)
    settings.addItem(item("在系统设置查看登录项", #selector(openLoginSettings), ""))
    let install = item("安装 es 命令", #selector(installCli), "")
    install.isEnabled = cliInstallProcess == nil && bundleFile("EasySwitchInstallCLI") != nil
    settings.addItem(install)
    let settingsItem = NSMenuItem(title: "设置", action: nil, keyEquivalent: "")
    settingsItem.submenu = settings
    menu.addItem(settingsItem)
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

  private func bundleFile(_ key: String) -> URL? {
    guard let relative = infoString(key), !relative.hasPrefix("/"), !relative.split(separator: "/").contains(".."),
          let resources = Bundle.main.resourceURL else { return nil }
    let file = resources.appendingPathComponent(relative).standardizedFileURL
    guard file.path.hasPrefix(resources.standardizedFileURL.path + "/"), FileManager.default.fileExists(atPath: file.path) else { return nil }
    return file
  }

  @objc private func startCore() {
    guard !startingCore, coreProcess?.isRunning != true, !quitting else { return }
    startingCore = true
    // A service already started elsewhere is usable, but never becomes this application's owned process.
    var request = URLRequest(url: coreURL.appendingPathComponent("health"))
    request.timeoutInterval = 1.5
    URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
      DispatchQueue.main.async {
        guard let self else { return }
        self.startingCore = false
        guard !self.quitting else { return }
        if isCoreHealth(data, response) { self.refreshHealth(); return }
        self.launchOwnedCore()
      }
    }.resume()
  }

  private func launchOwnedCore() {
    guard coreProcess?.isRunning != true else { return }
    let node = bundleFile("EasySwitchRuntime") ?? infoString("EasySwitchNode").map { URL(fileURLWithPath: $0) }
    let supervisor = bundleFile("EasySwitchSupervisor") ?? infoString("EasySwitchRepo").map { URL(fileURLWithPath: $0).appendingPathComponent("core/src/app-supervisor.ts") }
    guard let node, let supervisor, FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: supervisor.path) else {
      problem("启动配置还没准备好", "安装包缺少核心服务或运行环境。请检查安装包后重试；开发模式仍可从终端启动。")
      return
    }
    let task = Process(), input = Pipe()
    task.executableURL = node
    task.arguments = [supervisor.path]
    task.currentDirectoryURL = supervisor.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    task.standardInput = input
    task.standardOutput = FileHandle.nullDevice
    task.standardError = FileHandle.nullDevice
    task.terminationHandler = { [weak self] ended in
      DispatchQueue.main.async {
        guard let self, self.coreProcess === ended else { return }
        self.coreProcess = nil
        try? self.coreInput?.fileHandleForWriting.close()
        self.coreInput = nil
        self.refreshHealth()
        if self.quitting {
          if ended.terminationStatus == 0 { NSApp.reply(toApplicationShouldTerminate: true) }
          else { self.quitting = false; NSApp.reply(toApplicationShouldTerminate: false); self.problem("退出清理尚未确认", "监督服务没有确认核心已完整退出。请检查运行状态后再退出；应用不会把它当作清理成功。") }
        } else if self.returnToNativeRequested {
          self.returnToNativeRequested = false
          self.alert(ended.terminationStatus == 0 ? "自有核心服务已退出" : "核心退出清理未确认", "请自行关闭之前打开的增强客户端窗口，再直接启动原程序使用其原生配置。这里没有按进程名或端口终止其他程序。")
        } else if ended.terminationStatus != 0 { self.problem("核心服务已停止", "连续启动失败或退出清理未能确认。请打开自检查看安装与运行环境后，再尝试启动。") }
      }
    }
    do { try task.run(); coreProcess = task; coreInput = input }
    catch { problem("暂时无法启动服务", "程序可能已移除或没有运行权限。请检查安装后重试。") }
  }

  @objc private func stopCore() {
    guard let process = coreProcess, process.isRunning else {
      problem("当前应用没有启动这项服务", "请从原来的终端或应用停止服务；这里不会按端口终止其他进程。")
      return
    }
    try? coreInput?.fileHandleForWriting.close()
    process.terminate()
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard coreProcess?.isRunning == true else { quitting = true; return .terminateNow }
    if quitting { return .terminateLater }
    quitting = true
    stopCore()
    DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
      guard let self, self.quitting, self.coreProcess?.isRunning == true else { return }
      self.quitting = false
      NSApp.reply(toApplicationShouldTerminate: false)
      self.problem("服务退出尚未确认", "应用已请求停止自己启动的服务。请检查运行状态后再退出，避免把未完成清理当作成功。")
    }
    return .terminateLater
  }

  func applicationWillTerminate(_ notification: Notification) {
    quitting = true
    timer?.invalidate()
    try? coreInput?.fileHandleForWriting.close()
    if coreProcess?.isRunning == true { coreProcess?.terminate() }
  }

  @objc private func toggleLoginItem() {
    do {
      if SMAppService.mainApp.status == .enabled || SMAppService.mainApp.status == .requiresApproval { try SMAppService.mainApp.unregister() }
      else { try SMAppService.mainApp.register() }
      rebuildMenu()
    } catch { problem("登录项没有修改成功", "请在系统设置的登录项页面检查许可。应用不会自动开启登录项。") }
  }

  @objc private func openLoginSettings() { SMAppService.openSystemSettingsLoginItems() }

  @objc private func installCli() {
    guard cliInstallProcess == nil, let node = bundleFile("EasySwitchRuntime"), let installer = bundleFile("EasySwitchInstallCLI") else { return }
    let task = Process(), output = Pipe()
    task.executableURL = node
    task.arguments = [installer.path, "--install"]
    task.standardOutput = output
    task.standardError = FileHandle.nullDevice
    task.terminationHandler = { [weak self] ended in
      let data = output.fileHandleForReading.readDataToEndOfFile()
      let result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      DispatchQueue.main.async {
        guard let self else { return }
        self.cliInstallProcess = nil
        self.rebuildMenu()
        let done = ended.terminationStatus == 0 && (result?["installed"] as? Bool) == true
        let message = done ? "已安装到用户命令目录。如果终端仍找不到 es，请把 ~/.local/bin 加到自己的 PATH；应用不会修改 shell 配置。" : "无法写入用户命令目录，或原来已有其他程序。可以复制下面的临时命令，在自己的终端里使用。"
        let alert = NSAlert()
        alert.messageText = done ? "es 命令已准备好" : "es 命令尚未安装"
        alert.informativeText = message
        alert.addButton(withTitle: "关闭")
        if let command = result?["fallbackCommand"] as? String, command.count < 16384 {
          alert.addButton(withTitle: "复制临时命令")
          if alert.runModal() == .alertSecondButtonReturn { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(command, forType: .string) }
        } else { alert.runModal() }
      }
    }
    do { try task.run(); cliInstallProcess = task; rebuildMenu() }
    catch { problem("es 命令尚未安装", "本地安装程序无法启动。请检查应用是否完整后重试。") }
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

  /// Only the owned gateway can be stopped here. Interactive terminals have no retained process handle.
  @objc private func backToNative() {
    guard coreProcess?.isRunning == true else {
      alert("请从原来的窗口回到原生", "当前应用没有持有核心服务的进程。请关闭增强客户端窗口，并从原来启动网关的位置停止服务，再直接启动原程序。这里不会按进程名或端口终止其他程序。")
      return
    }
    let confirm = NSAlert()
    confirm.messageText = "停止当前应用启动的核心服务？"
    confirm.informativeText = "正在通过它进行的请求会中断。增强客户端窗口请自行关闭；随后直接启动原程序即可使用原生配置。"
    confirm.addButton(withTitle: "停止自有服务")
    confirm.addButton(withTitle: "取消")
    if confirm.runModal() == .alertFirstButtonReturn { returnToNativeRequested = true; stopCore() }
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

  @objc private func quit() { NSApp.terminate(nil) }

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
