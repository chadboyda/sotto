// Native link protocol constants and the binary audio frame codec.
// Mirrors daemon/native-proto.js; docs/NATIVE.md §1-§2 is the contract.
import Foundation

public enum NativeProtocol {
    public static let version = 1
    public static let path = "/api/native"
    public static let subprotocol = "sotto-native.v1"
    public static let sampleRate = 24_000
    public static let frameMs = 20
    public static let frameSamples = 480
    public static let frameBytes = 960
    public static let headerBytes = 16
    public static let maxMessageBytes = 1 << 20
}

public enum FrameKind: UInt8, Sendable { case mic = 1, speaker = 2 }

public struct FrameFlags: OptionSet, Sendable {
    public let rawValue: UInt8
    public init(rawValue: UInt8) { self.rawValue = rawValue }
    /// mic: payload is zeros because the user is muted.
    public static let muted = FrameFlags(rawValue: 0x01)
    /// mic: synthetic input (fixture / fake audio).
    public static let fake = FrameFlags(rawValue: 0x02)
    /// speaker: first frame after an audio_flush.
    public static let afterFlush = FrameFlags(rawValue: 0x01)
}

/// u8 kind | u8 flags | u16 reserved | u32 seq LE | u64 timestamp ns LE | PCM16LE mono 24 kHz
public struct WireFrame: Equatable, Sendable {
    public var kind: FrameKind
    public var flags: FrameFlags
    public var seq: UInt32
    public var timestampNs: UInt64
    public var pcm: Data

    public init(kind: FrameKind, flags: FrameFlags = [], seq: UInt32, timestampNs: UInt64, pcm: Data) {
        self.kind = kind; self.flags = flags; self.seq = seq; self.timestampNs = timestampNs; self.pcm = pcm
    }

    public func encode() -> Data {
        var d = Data(capacity: NativeProtocol.headerBytes + pcm.count)
        d.append(kind.rawValue)
        d.append(flags.rawValue)
        d.append(contentsOf: [0, 0])
        withUnsafeBytes(of: seq.littleEndian) { d.append(contentsOf: $0) }
        withUnsafeBytes(of: timestampNs.littleEndian) { d.append(contentsOf: $0) }
        d.append(pcm)
        return d
    }

    public static func decode(_ data: Data) -> WireFrame? {
        let b = [UInt8](data)
        guard b.count >= NativeProtocol.headerBytes, (b.count - NativeProtocol.headerBytes) % 2 == 0,
              let kind = FrameKind(rawValue: b[0]) else { return nil }
        var seq: UInt32 = 0
        for i in 0..<4 { seq |= UInt32(b[4 + i]) << (8 * UInt32(i)) }
        var ts: UInt64 = 0
        for i in 0..<8 { ts |= UInt64(b[8 + i]) << (8 * UInt64(i)) }
        return WireFrame(kind: kind, flags: FrameFlags(rawValue: b[1]), seq: seq, timestampNs: ts,
                         pcm: Data(b[NativeProtocol.headerBytes...]))
    }
}
