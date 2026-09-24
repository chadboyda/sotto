import AppKit

// CLI mode for the daemon's window chooser: print the default audio devices
// and exit before AppKit starts (fast, no UI, no permissions needed).
if CommandLine.arguments.contains("--audio-route") {
    print(AudioRoute.current().json)
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate(options: Options.parse(CommandLine.arguments))
app.delegate = delegate
app.setActivationPolicy(.accessory) // menu-bar app: no Dock icon, never steals focus
app.run()
