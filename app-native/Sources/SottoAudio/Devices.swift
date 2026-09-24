// CoreAudio device enumeration and change listeners. Reading properties opens no device.
import CoreAudio
import Foundation

struct CADevice {
    var objectID: AudioDeviceID
    var device: AudioDevice
}

enum CoreAudioDevices {
    private static let system = AudioObjectID(kAudioObjectSystemObject)

    static func addr(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    static func allIDs() -> [AudioDeviceID] {
        var a = addr(kAudioHardwarePropertyDevices)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(system, &a, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(system, &a, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    static func defaultID(input: Bool) -> AudioDeviceID? {
        var a = addr(input ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice)
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        return AudioObjectGetPropertyData(system, &a, 0, nil, &size, &id) == noErr && id != 0 ? id : nil
    }

    static func string(_ d: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
        var a = addr(sel)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(d, &a, 0, nil, &size, &value) == noErr, let v = value else { return nil }
        return v.takeRetainedValue() as String
    }

    static func u32(_ d: AudioObjectID, _ sel: AudioObjectPropertySelector, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> UInt32? {
        var a = addr(sel, scope)
        var v: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(d, &a, 0, nil, &size, &v) == noErr ? v : nil
    }

    static func channels(_ d: AudioObjectID, input: Bool) -> Int {
        var a = addr(kAudioDevicePropertyStreamConfiguration, input ? kAudioObjectPropertyScopeInput : kAudioObjectPropertyScopeOutput)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(d, &a, 0, nil, &size) == noErr, size > 0 else { return 0 }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(d, &a, 0, nil, &size, raw) == noErr else { return 0 }
        return UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self)).reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    static func transport(_ raw: UInt32) -> AudioTransport {
        switch raw {
        case kAudioDeviceTransportTypeBuiltIn: return .builtIn
        case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return .bluetooth
        case kAudioDeviceTransportTypeUSB: return .usb
        case kAudioDeviceTransportTypeHDMI: return .hdmi
        case kAudioDeviceTransportTypeDisplayPort: return .displayPort
        case kAudioDeviceTransportTypeAirPlay: return .airPlay
        case kAudioDeviceTransportTypeThunderbolt: return .thunderbolt
        case kAudioDeviceTransportTypePCI: return .pci
        case kAudioDeviceTransportTypeVirtual: return .virtual
        case kAudioDeviceTransportTypeAggregate: return .aggregate
        default: return .unknown
        }
    }

    /// 'hdpn': the built-in output's data source when headphones are plugged in.
    static func jackHeadphones(_ d: AudioObjectID) -> Bool {
        u32(d, kAudioDevicePropertyDataSource, scope: kAudioObjectPropertyScopeOutput) == 0x6864_706E
    }

    private static func isPrivateAggregate(_ name: String) -> Bool {
        name.hasPrefix("CADefaultDeviceAggregate") || name.hasPrefix("VPAUAggregateAudioDevice")
    }

    static func list(input: Bool) -> [CADevice] {
        allIDs().compactMap { id in
            guard channels(id, input: input) > 0, let name = string(id, kAudioObjectPropertyName), !isPrivateAggregate(name) else { return nil }
            let t = transport(u32(id, kAudioDevicePropertyTransportType) ?? 0)
            let hp = input ? false : AudioPlan.isHeadphones(transport: t, dataSourceHdpn: t == .builtIn && jackHeadphones(id), name: name)
            let uid = string(id, kAudioDevicePropertyDeviceUID) ?? name
            return CADevice(objectID: id, device: AudioDevice(id: uid, name: name, bluetooth: t == .bluetooth, headphones: hp, transport: t))
        }
    }

    static func defaultUID(input: Bool) -> String? {
        defaultID(input: input).flatMap { string($0, kAudioDevicePropertyDeviceUID) }
    }

    static func objectID(uid: String, input: Bool) -> AudioDeviceID? {
        list(input: input).first(where: { $0.device.id == uid })?.objectID
    }

    static func isAlive(_ d: AudioDeviceID) -> Bool { (u32(d, kAudioDevicePropertyDeviceIsAlive) ?? 0) != 0 }

    static func nominalRate(_ d: AudioDeviceID) -> Double? {
        var a = addr(kAudioDevicePropertyNominalSampleRate)
        var v: Float64 = 0
        var size = UInt32(MemoryLayout<Float64>.size)
        return AudioObjectGetPropertyData(d, &a, 0, nil, &size, &v) == noErr && v > 0 ? v : nil
    }
}

/// Property listeners (device list, defaults, alive, data source) delivering on the main queue.
final class DeviceWatcher {
    private var installed: [(AudioObjectID, AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = []
    private let onChange: () -> Void

    init(onChange: @escaping () -> Void) { self.onChange = onChange }

    func watch(devices: [AudioDeviceID]) {
        unwatch()
        let system = AudioObjectID(kAudioObjectSystemObject)
        add(system, CoreAudioDevices.addr(kAudioHardwarePropertyDevices))
        add(system, CoreAudioDevices.addr(kAudioHardwarePropertyDefaultInputDevice))
        add(system, CoreAudioDevices.addr(kAudioHardwarePropertyDefaultOutputDevice))
        for d in Set(devices) {
            add(d, CoreAudioDevices.addr(kAudioDevicePropertyDeviceIsAlive))
            add(d, CoreAudioDevices.addr(kAudioDevicePropertyDataSource, kAudioObjectPropertyScopeOutput))
            add(d, CoreAudioDevices.addr(kAudioDevicePropertyNominalSampleRate))
        }
    }

    private func add(_ obj: AudioObjectID, _ a: AudioObjectPropertyAddress) {
        var addr = a
        let cb: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.onChange() }
        if AudioObjectAddPropertyListenerBlock(obj, &addr, DispatchQueue.main, cb) == noErr { installed.append((obj, a, cb)) }
    }

    func unwatch() {
        for (obj, a, cb) in installed {
            var addr = a
            AudioObjectRemovePropertyListenerBlock(obj, &addr, DispatchQueue.main, cb)
        }
        installed.removeAll()
    }

    deinit { unwatch() }
}

public enum AudioSelfTest {
    /// `--selftest audio-devices` (manual only): the device lists, defaults and the automatic
    /// plan, as JSON. Reads CoreAudio properties only; never opens a device or the mic.
    public static func devicesJSON() -> String {
        let ins = CoreAudioDevices.list(input: true).map(\.device)
        let outs = CoreAudioDevices.list(input: false).map(\.device)
        let defIn = CoreAudioDevices.defaultUID(input: true), defOut = CoreAudioDevices.defaultUID(input: false)
        let input = AudioPlan.pickInput(inputs: ins, defaultInput: defIn, preferred: nil)
        let output = AudioPlan.pickOutput(outputs: outs, defaultOutput: defOut, preferred: nil)
        let plan = AudioPlan.decide(output: output, input: input, pref: .automatic)
        func dev(_ d: AudioDevice?) -> Any {
            guard let d = d else { return NSNull() }
            return ["id": d.id, "name": d.name, "bluetooth": d.bluetooth, "headphones": d.headphones, "transport": d.transport.rawValue]
        }
        let obj: [String: Any] = [
            "inputs": ins.map(dev), "outputs": outs.map(dev),
            "default_input": defIn ?? NSNull(), "default_output": defOut ?? NSNull(),
            "plan": ["mode": plan.mode.rawValue, "reason": plan.reason, "input": dev(plan.input), "output": dev(plan.output)],
            "mic_permission": MicPermission.current().rawValue,
        ]
        guard let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), let s = String(data: d, encoding: .utf8) else { return "{}" }
        return s
    }
}
