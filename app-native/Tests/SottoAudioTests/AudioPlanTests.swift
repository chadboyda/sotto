import XCTest
@testable import SottoAudio

final class AudioPlanTests: XCTestCase {
    let builtInMic = AudioDevice(id: "mic-builtin", name: "MacBook Pro Microphone", bluetooth: false, headphones: false, transport: .builtIn)
    let airpodsMic = AudioDevice(id: "mic-airpods", name: "AirPods Pro", bluetooth: true, headphones: false, transport: .bluetooth)
    let usbMic = AudioDevice(id: "mic-usb", name: "Yeti", bluetooth: false, headphones: false, transport: .usb)
    let loopback = AudioDevice(id: "mic-virtual", name: "BlackHole 2ch", bluetooth: false, headphones: false, transport: .virtual)

    func out(_ t: AudioTransport, hdpn: Bool = false, name: String = "Out") -> AudioDevice {
        AudioDevice(id: "out-\(t.rawValue)-\(hdpn)", name: name, bluetooth: t == .bluetooth,
                    headphones: AudioPlan.isHeadphones(transport: t, dataSourceHdpn: hdpn, name: name), transport: t)
    }

    func testModeTable() {
        let cases: [(AudioDevice?, EchoCancellation, Bool, AudioMode, String)] = [
            (out(.builtIn), .automatic, false, .vpio, "speakers"),
            (out(.hdmi), .automatic, false, .vpio, "speakers"),
            (out(.airPlay), .automatic, false, .vpio, "speakers"),
            (out(.unknown), .automatic, false, .vpio, "speakers"),
            (out(.usb, name: "USB Audio DAC"), .automatic, false, .vpio, "speakers"),
            (nil, .automatic, false, .vpio, "no_output"),
            (out(.bluetooth, name: "AirPods Pro"), .automatic, false, .split, "headphones"),
            (out(.builtIn, hdpn: true), .automatic, false, .split, "headphones"),
            (out(.usb, name: "Jabra USB Headset"), .automatic, false, .split, "headphones"),
            (out(.usb, name: "Sony Headphones"), .automatic, false, .split, "headphones"),
            (out(.bluetooth), .always, false, .vpio, "pref_always"),
            (out(.builtIn), .never, false, .split, "pref_never"),
            (out(.builtIn), .automatic, true, .listen, "sleeping"),
            (out(.bluetooth), .always, true, .listen, "sleeping"),
        ]
        for (o, pref, listen, mode, reason) in cases {
            let p = AudioPlan.decide(output: o, input: builtInMic, pref: pref, listenOnly: listen)
            XCTAssertEqual(p.mode, mode, "\(o?.name ?? "nil") \(pref) listen=\(listen)")
            XCTAssertEqual(p.reason, reason)
            XCTAssertEqual(p.echoCancellation, mode == .vpio)
        }
        XCTAssertEqual(AudioPlan.decide(output: out(.builtIn), input: builtInMic, pref: .always, test: true).mode, .fake)
        XCTAssertNil(AudioPlan.decide(output: out(.builtIn), input: builtInMic, pref: .automatic, listenOnly: true).output)
    }

    func testBluetoothMicNeverChosenAutomatically() {
        let inputs = [airpodsMic, usbMic, builtInMic]
        XCTAssertEqual(AudioPlan.pickInput(inputs: inputs, defaultInput: airpodsMic.id, preferred: nil), builtInMic)
        XCTAssertEqual(AudioPlan.pickInput(inputs: [airpodsMic, usbMic], defaultInput: airpodsMic.id, preferred: nil), usbMic)
        XCTAssertEqual(AudioPlan.pickInput(inputs: [airpodsMic, loopback, usbMic], defaultInput: airpodsMic.id, preferred: nil), usbMic)
        // Nothing else: the Bluetooth mic is the only way to hear the user.
        XCTAssertEqual(AudioPlan.pickInput(inputs: [airpodsMic], defaultInput: airpodsMic.id, preferred: nil), airpodsMic)
    }

    func testMicRule() {
        let inputs = [builtInMic, usbMic, airpodsMic]
        XCTAssertEqual(AudioPlan.pickInput(inputs: inputs, defaultInput: usbMic.id, preferred: nil), usbMic, "system default when not Bluetooth")
        XCTAssertEqual(AudioPlan.pickInput(inputs: inputs, defaultInput: usbMic.id, preferred: builtInMic.id), builtInMic, "saved device wins")
        XCTAssertEqual(AudioPlan.pickInput(inputs: inputs, defaultInput: usbMic.id, preferred: "gone"), usbMic, "missing saved device falls back")
        XCTAssertEqual(AudioPlan.pickInput(inputs: inputs, defaultInput: nil, preferred: nil), builtInMic, "no default: first real device")
        XCTAssertEqual(AudioPlan.pickInput(inputs: inputs, defaultInput: nil, preferred: airpodsMic.id), airpodsMic, "an explicit Bluetooth choice is honored")
        XCTAssertNil(AudioPlan.pickInput(inputs: [], defaultInput: nil, preferred: nil))
    }

    func testOutputRule() {
        let a = out(.builtIn), b = out(.bluetooth)
        XCTAssertEqual(AudioPlan.pickOutput(outputs: [a, b], defaultOutput: b.id, preferred: nil), b)
        XCTAssertEqual(AudioPlan.pickOutput(outputs: [a, b], defaultOutput: b.id, preferred: a.id), a)
        XCTAssertEqual(AudioPlan.pickOutput(outputs: [a, b], defaultOutput: "x", preferred: "y"), a)
    }

    func testRouteInfo() {
        let r = AudioPlan.decide(output: out(.bluetooth), input: builtInMic, pref: .automatic).route
        XCTAssertEqual(r.mode, .split)
        XCTAssertFalse(r.echoCancellation)
        XCTAssertEqual(r.input, builtInMic)
    }
}
