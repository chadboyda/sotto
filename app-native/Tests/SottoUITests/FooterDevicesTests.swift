// The footer's microphone and speaker controls (FooterDevices.swift): what the picker
// lists, the fallback when a chosen device goes away, and the footer's layout (40 pt
// targets, nothing overlapping or clipped at 360 pt, no zone moving when the picker opens).
import XCTest
import SwiftUI
import AppKit
@testable import SottoUI

@MainActor
final class FooterDevicesTests: XCTestCase {
    let mics = [DeviceChoice(id: "builtin", name: "MacBook Pro Microphone"), DeviceChoice(id: "usb", name: "USB Mic")]
    let outs = [DeviceChoice(id: "spk", name: "MacBook Pro Speakers"), DeviceChoice(id: "pods", name: "AirPods Pro", bluetooth: true, headphones: true)]

    func testMenuListsSystemDefaultFirstWithTheCheck() {
        let a = DeviceMenu.items(devices: mics, selected: nil, defaultName: "MacBook Pro Microphone")
        XCTAssertEqual(a.map(\.label), ["System default (MacBook Pro Microphone)", "MacBook Pro Microphone", "USB Mic"])
        XCTAssertEqual(a.map(\.checked), [true, false, false])
        let b = DeviceMenu.items(devices: mics, selected: "usb", defaultName: nil)
        XCTAssertEqual(b.first?.label, "System default")
        XCTAssertEqual(b.map(\.checked), [false, false, true])
        // A saved device that is not there: System default is what is in use.
        XCTAssertEqual(DeviceMenu.items(devices: mics, selected: "gone", defaultName: nil).map(\.checked), [true, false, false])
    }

    func testLostDeviceFallsBackOnlyWhenTheChoiceIsGone() {
        XCTAssertFalse(DeviceMenu.lost(selected: nil, devices: mics), "System default is never lost")
        XCTAssertFalse(DeviceMenu.lost(selected: "usb", devices: mics))
        XCTAssertTrue(DeviceMenu.lost(selected: "pods", devices: mics))
        XCTAssertFalse(DeviceMenu.lost(selected: "pods", devices: []), "an unread list loses nothing")
    }

    func testLabelsAndSymbols() {
        XCTAssertEqual(DeviceMenu.label("input", active: mics[0]), "Microphone: MacBook Pro Microphone")
        XCTAssertEqual(DeviceMenu.label("output", active: nil), "Speaker: none")
        XCTAssertEqual(DeviceMenu.symbol("input", active: mics[0]), "mic")
        XCTAssertEqual(DeviceMenu.symbol("output", active: outs[0]), "speaker.wave.2")
        XCTAssertEqual(DeviceMenu.symbol("output", active: outs[1]), "headphones")
    }

    func testChoosingFromThePickerIsTheSettingsChoice() {
        let m = StateModel()
        let s = SettingsModel(state: m)
        var saved: [String?] = []
        s.hooks.selectInput = { saved.append($0) }
        s.inputDevices = mics
        s.chooseInput("usb")
        XCTAssertEqual(s.selectedInput, "usb")
        s.chooseInput(nil)
        XCTAssertNil(s.selectedInput)
        XCTAssertEqual(saved, ["usb", nil], "the same hook (defaults key, audio preference) as Settings")
    }

    final class Box { var frames: [String: CGRect] = [:] }

    func frames(size: CGSize, picker: String? = nil, voice: String = "marin") -> [String: CGRect] {
        let m = UISnapshot.model(UISnapshot.states.first { $0.name == "05-listening" }!)
        m.apply(object: UISnapshot.status("live", voice: voice))
        let s = SettingsModel(state: m)
        s.inputDevices = mics; s.outputDevices = outs
        s.activeInput = mics[0]; s.activeOutput = outs[1]
        s.defaultInputName = mics[0].name; s.defaultOutputName = outs[0].name
        m.settingsModel = s
        m.openSettings = {}
        m.devicePicker = picker
        let box = Box()
        let root = PanelView(model: m, stillAt: 780_000_000)
            .onPreferenceChange(PanelFrames.self) { v in MainActor.assumeIsolated { box.frames = v } }
            .frame(width: size.width, height: size.height)
        let host = NSHostingView(rootView: root)
        host.frame = CGRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: CGRect(x: -20_000, y: -20_000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        for _ in 0..<3 { host.layoutSubtreeIfNeeded(); RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
        window.close()
        _ = s
        return box.frames
    }

    func testFooterFitsWithFortyPointTargets() throws {
        for w in [360, 400, 420, 640] as [CGFloat] {
            let f = frames(size: CGSize(width: w, height: 640))
            let footer = try XCTUnwrap(f["footer"]), chip = try XCTUnwrap(f["persona-chip"])
            let mic = try XCTUnwrap(f["mic-button"]), spk = try XCTUnwrap(f["speaker-button"])
            for (n, b) in [("mic", mic), ("speaker", spk)] {
                XCTAssertEqual(b.width, 40, accuracy: 0.5, "\(n) at \(w): a 40 pt target")
                XCTAssertEqual(b.height, 40, accuracy: 0.5, "\(n) at \(w): a 40 pt target")
                XCTAssertGreaterThanOrEqual(b.minY, footer.minY - 0.5)
                XCTAssertLessThanOrEqual(b.maxY, footer.maxY + 0.5)
                XCTAssertLessThanOrEqual(b.maxX, w - 8, "\(n) at \(w): inside the panel")
            }
            XCTAssertLessThanOrEqual(chip.maxX, mic.minX + 0.5, "at \(w): the chip runs into the mic button (\(chip) / \(mic))")
            XCTAssertLessThanOrEqual(mic.maxX, spk.minX + 0.5)
            XCTAssertGreaterThanOrEqual(chip.minX, 0)
        }
    }

    func testPickerOpensOverThePanelWithoutMovingAnything() throws {
        for size in [CGSize(width: 360, height: 420), CGSize(width: 420, height: 640)] {
            let closed = frames(size: size)
            let open = frames(size: size, picker: "input")
            let p = try XCTUnwrap(open["device-picker"], "the picker shows at \(size)")
            XCTAssertNil(closed["device-picker"])
            XCTAssertGreaterThanOrEqual(p.minX, 0)
            XCTAssertLessThanOrEqual(p.maxX, size.width + 0.5)
            XCTAssertGreaterThanOrEqual(p.minY, 0)
            XCTAssertLessThanOrEqual(p.maxY, try XCTUnwrap(open["footer"]).minY + 0.5, "above the footer at \(size)")
            for k in ["captions", "claude", "footer", "mic-button", "speaker-button", "persona-chip"] {
                XCTAssertEqual(open[k], closed[k], "\(k) moved when the picker opened at \(size)")
            }
        }
    }
}
