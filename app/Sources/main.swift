import AppKit

// CLI mode for the daemon's window chooser: print the default audio devices
// and exit before AppKit starts (fast, no UI, no permissions needed).
if CommandLine.arguments.contains("--audio-route") {
    print(AudioRoute.current().json)
    exit(0)
}
// Tests: the native-mic capture plan for a made-up route (NativeMic.swift).
if let i = CommandLine.arguments.firstIndex(of: "--mic-plan-eval"), i + 1 < CommandLine.arguments.count {
    print(MicPlan.evaluate(json: CommandLine.arguments[i + 1]))
    exit(0)
}
// Diagnostics: the plan the app would use right now (no capture).
if CommandLine.arguments.contains("--mic-plan") {
    let pref = (ProcessInfo.processInfo.environment["SOTTO_APP_MIC"] ?? Prefs.store.string(forKey: MicController.prefKey) ?? "auto").lowercased()
    let plan = MicPlan.decide(pref: pref, output: Devices.output(), inputs: Devices.inputs(), defaultInput: Devices.defaultDevice(input: true), requested: nil)
    print(jsonString(["route": AudioRoute.current().dictionary, "plan": plan?.dictionary ?? NSNull()]))
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate(options: Options.parse(CommandLine.arguments))
app.delegate = delegate
app.setActivationPolicy(.accessory) // menu-bar app: no Dock icon, never steals focus
EditMenu.install() // Cmd+V etc. in the page (the API key field)
app.run()
