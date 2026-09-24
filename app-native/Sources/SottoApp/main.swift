// Sotto app entry (docs/NATIVE.md §5.1).
// Modes: normal (menu bar + floating panel), --test (fake audio, hidden
// panel, test defaults, no hotkeys or status item), --selftest <name> [json]
// (pure checks, JSON out), --version, --exit-after <s>.
import AppKit
import SottoClient

let options = Options.parse(CommandLine.arguments)
if options.version {
    print("{\"version\":\"\(AppController.appVersion)\",\"protocol\":\(NativeProtocol.version)}")
    exit(0)
}
if let name = options.selftest {
    if name == "link" {
        print(SelfTest.link(port: options.request?.port, dataDir: options.request?.dataDir))
        exit(0)
    }
    if let out = SelfTest.run(name, options.selftestArg) {
        print(out)
        exit(0)
    }
    FileHandle.standardError.write(Data("unknown selftest \(name)\n".utf8))
    exit(2)
}

// One instance per bundle id. LaunchServices already routes a sotto:// URL to
// the running instance (LSMultipleInstancesProhibited); this covers a direct
// exec of the installed bundle: forward its request as a URL and exit. Test
// runs never forward (their bundle id may equal the user's app).
if !options.testMode, let id = Bundle.main.bundleIdentifier,
   let other = NSRunningApplication.runningApplications(withBundleIdentifier: id)
       .first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
    if let r = options.request, let bundleURL = other.bundleURL {
        var q = URLComponents(string: "sotto://open")!
        q.queryItems = [URLQueryItem(name: "port", value: String(r.port))]
            + (r.code.map { [URLQueryItem(name: "k", value: $0)] } ?? [])
            + (r.dataDir.map { [URLQueryItem(name: "data", value: $0)] } ?? [])
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = false
        let done = DispatchSemaphore(value: 0)
        NSWorkspace.shared.open([q.url!], withApplicationAt: bundleURL, configuration: cfg) { _, _ in done.signal() }
        _ = done.wait(timeout: .now() + 5)
    }
    exit(0)
}

let app = NSApplication.shared
let delegate = MainActor.assumeIsolated { AppController(options: options) }
app.delegate = delegate
app.setActivationPolicy(.accessory) // menu-bar app: no Dock icon, never steals focus
MainActor.assumeIsolated { EditMenu.install() }
app.run()
