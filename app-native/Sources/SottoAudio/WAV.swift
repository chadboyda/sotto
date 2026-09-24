// WAV read/write and the 24 kHz resampler (NATIVE.md §5.3).
import AVFoundation
import Foundation

public enum WAV {
    public struct Decoded: Equatable {
        /// Mono samples in -1...1 (channels averaged).
        public var samples: [Float]
        public var sampleRate: Double
        public var channels: Int
    }

    public enum Failure: Error, Equatable { case notWav, unsupportedFormat(Int, Int), noData }

    /// Reads RIFF/WAVE: PCM 8/16/24/32-bit, IEEE float 32/64, WAVE_FORMAT_EXTENSIBLE; any rate and channel count.
    public static func decode(_ d: Data) throws -> Decoded {
        let b = [UInt8](d)
        guard b.count >= 12, String(bytes: b[0..<4], encoding: .ascii) == "RIFF", String(bytes: b[8..<12], encoding: .ascii) == "WAVE" else { throw Failure.notWav }
        func u16(_ o: Int) -> Int { Int(b[o]) | Int(b[o + 1]) << 8 }
        func u32(_ o: Int) -> Int { u16(o) | u16(o + 2) << 16 }
        var o = 12
        var format = 0, channels = 0, rate = 0, bits = 0
        var dataRange: Range<Int>?
        while o + 8 <= b.count {
            let id = String(bytes: b[o..<o + 4], encoding: .ascii) ?? ""
            let len = u32(o + 4)
            let body = o + 8
            if id == "fmt ", body + 16 <= b.count {
                format = u16(body); channels = u16(body + 2); rate = u32(body + 4); bits = u16(body + 14)
                if format == 0xFFFE, len >= 26, body + 26 <= b.count { format = u16(body + 24) }
            } else if id == "data" {
                dataRange = body..<min(b.count, body + len)
            }
            o = body + len + (len & 1)
        }
        guard let range = dataRange, channels > 0, rate > 0 else { throw Failure.noData }
        let bytesPer = bits / 8
        guard (format == 1 && [1, 2, 3, 4].contains(bytesPer)) || (format == 3 && [4, 8].contains(bytesPer)) else {
            throw Failure.unsupportedFormat(format, bits)
        }
        let frameBytes = bytesPer * channels
        let n = range.count / frameBytes
        var out = [Float](repeating: 0, count: n)
        b.withUnsafeBufferPointer { raw in
            let base = raw.baseAddress! + range.lowerBound
            for i in 0..<n {
                var acc: Float = 0
                for c in 0..<channels {
                    let p = base + i * frameBytes + c * bytesPer
                    acc += sample(p, bytesPer: bytesPer, float: format == 3)
                }
                out[i] = acc / Float(channels)
            }
        }
        return Decoded(samples: out, sampleRate: Double(rate), channels: channels)
    }

    private static func sample(_ p: UnsafePointer<UInt8>, bytesPer: Int, float: Bool) -> Float {
        let raw = UnsafeRawPointer(p)
        if float {
            return bytesPer == 4 ? raw.loadUnaligned(as: Float.self) : Float(raw.loadUnaligned(as: Double.self))
        }
        switch bytesPer {
        case 1: return (Float(p[0]) - 128) / 128
        case 2: return Float(raw.loadUnaligned(as: Int16.self)) / 32768
        case 3:
            let v = Int32(p[0]) | Int32(p[1]) << 8 | Int32(Int8(bitPattern: p[2])) << 16
            return Float(v) / 8_388_608
        default: return Float(raw.loadUnaligned(as: Int32.self)) / 2_147_483_648
        }
    }

    /// Any WAV to 24 kHz mono PCM16 (the wire format).
    public static func decode24k(_ d: Data) throws -> [Int16] {
        let w = try decode(d)
        let r = Resampler(inputRate: w.sampleRate)
        var out = w.samples.withUnsafeBufferPointer { r.process($0) }
        out += r.flush()
        return out
    }

    /// 16-bit PCM mono WAV (44-byte header).
    public static func encodePCM16(_ samples: [Int16], sampleRate: Int = 24_000) -> Data {
        var d = Data(capacity: 44 + samples.count * 2)
        func put32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func put16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        let dataBytes = UInt32(samples.count * 2)
        d.append(contentsOf: Array("RIFF".utf8)); put32(36 + dataBytes); d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); put32(16); put16(1); put16(1)
        put32(UInt32(sampleRate)); put32(UInt32(sampleRate * 2)); put16(2); put16(16)
        d.append(contentsOf: Array("data".utf8)); put32(dataBytes)
        samples.withUnsafeBufferPointer { d.append(UnsafeBufferPointer(start: UnsafeRawPointer($0.baseAddress!).assumingMemoryBound(to: UInt8.self), count: $0.count * 2)) }
        return d
    }
}

/// Streaming mono Float32 at any rate -> PCM16 mono 24 kHz. One persistent AVAudioConverter per
/// route (keeps filter state across chunks); a straight copy when the input is already 24 kHz.
/// Not for the render thread (it allocates); the capture drain queue runs it.
public final class Resampler {
    public static let outputRate: Double = 24_000
    public let inputRate: Double
    private let converter: AVAudioConverter?
    private let inFormat: AVAudioFormat
    private let outFormat: AVAudioFormat

    public init(inputRate: Double) {
        self.inputRate = inputRate
        inFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: inputRate, channels: 1, interleaved: false)!
        outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Resampler.outputRate, channels: 1, interleaved: true)!
        if inputRate == Resampler.outputRate {
            converter = nil
        } else {
            let c = AVAudioConverter(from: inFormat, to: outFormat)
            c?.sampleRateConverterQuality = AVAudioQuality.high.rawValue
            c?.primeMethod = .none
            converter = c
        }
    }

    public func process(_ input: UnsafeBufferPointer<Float>) -> [Int16] {
        guard !input.isEmpty else { return [] }
        guard let conv = converter else { return input.map(floatToInt16) }
        guard let inBuf = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: AVAudioFrameCount(input.count)) else { return [] }
        inBuf.frameLength = AVAudioFrameCount(input.count)
        inBuf.floatChannelData![0].update(from: input.baseAddress!, count: input.count)
        return run(conv, input: inBuf, end: false)
    }

    /// Drains the converter's tail (end of stream) and resets it for reuse.
    public func flush() -> [Int16] {
        guard let conv = converter else { return [] }
        let out = run(conv, input: nil, end: true)
        conv.reset()
        return out
    }

    private func run(_ conv: AVAudioConverter, input: AVAudioPCMBuffer?, end: Bool) -> [Int16] {
        let n = Int(input?.frameLength ?? 0)
        let cap = AVAudioFrameCount(Double(n) * Resampler.outputRate / inputRate) + 512
        var out: [Int16] = []
        var fed = false
        while true {
            guard let outBuf = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap) else { break }
            var err: NSError?
            let status = conv.convert(to: outBuf, error: &err) { _, st in
                if let b = input, !fed { fed = true; st.pointee = .haveData; return b }
                st.pointee = end ? .endOfStream : .noDataNow
                return nil
            }
            if outBuf.frameLength > 0 {
                out.append(contentsOf: UnsafeBufferPointer(start: outBuf.int16ChannelData![0], count: Int(outBuf.frameLength)))
            }
            if status != .haveData || err != nil { break }
        }
        return out
    }
}
