import XCTest
@testable import SottoAudio

/// Goertzel power ratio at `freq` (0...1 of total energy).
func toneShare(_ s: [Int16], rate: Double, freq: Double) -> Double {
    let w = 2 * Double.pi * freq / rate
    let coeff = 2 * cos(w)
    var q1 = 0.0, q2 = 0.0, total = 0.0
    for v in s { let x = Double(v); let q0 = coeff * q1 - q2 + x; q2 = q1; q1 = q0; total += x * x }
    let power = q1 * q1 + q2 * q2 - coeff * q1 * q2
    return total > 0 ? (2 * power / Double(s.count)) / total : 0
}

final class ResamplerTests: XCTestCase {
    func sine(rate: Double, freq: Double, seconds: Double, amp: Float = 0.5) -> [Float] {
        (0..<Int(rate * seconds)).map { amp * Float(sin(2 * Double.pi * freq * Double($0) / rate)) }
    }

    func testRatesTo24k() {
        for rate in [48_000.0, 44_100.0, 16_000.0, 24_000.0, 96_000.0] {
            let input = sine(rate: rate, freq: 1_000, seconds: 1)
            let r = Resampler(inputRate: rate)
            var out: [Int16] = []
            // Streamed in odd chunk sizes, as a capture callback would.
            var i = 0
            var k = 0
            while i < input.count {
                let n = min([441, 512, 160, 1024][k % 4], input.count - i)
                out += input[i..<i + n].withUnsafeBufferPointer { r.process($0) }
                i += n; k += 1
            }
            out += r.flush()
            XCTAssertEqual(Double(out.count), 24_000, accuracy: 240, "length for \(rate) (within 1%)")
            let mid = Array(out[2_400..<21_600])
            XCTAssertGreaterThan(toneShare(mid, rate: 24_000, freq: 1_000), 0.95, "1 kHz tone survives \(rate)")
            let peak = mid.map { abs(Int($0)) }.max() ?? 0
            XCTAssertEqual(Double(peak), 16_384, accuracy: 900, "level kept for \(rate)")
        }
    }

    func testLargeChunksLoseNothing() {
        // A capture drain that fell behind (or a whole WAV) hands the converter one large buffer.
        for (rate, chunk) in [(16_000.0, 3_200), (8_000.0, 4_800), (48_000.0, 4_800), (16_000.0, 16_000)] {
            let input = sine(rate: rate, freq: 440, seconds: 1)
            let r = Resampler(inputRate: rate)
            var out: [Int16] = []
            var i = 0
            while i < input.count {
                let n = min(chunk, input.count - i)
                out += input[i..<i + n].withUnsafeBufferPointer { r.process($0) }
                i += n
            }
            out += r.flush()
            XCTAssertEqual(Double(out.count), 24_000, accuracy: 240, "\(Int(rate)) Hz in \(chunk)-frame chunks")
        }
    }

    func testDownsamplingRemovesAliases() {
        // 15 kHz at 48 kHz is above the 12 kHz Nyquist of 24 kHz: it must be filtered, not folded to 9 kHz.
        let r = Resampler(inputRate: 48_000)
        let input = sine(rate: 48_000, freq: 15_000, seconds: 0.5)
        let out = input.withUnsafeBufferPointer { r.process($0) } + r.flush()
        // Skip the edges: the hard start/stop of the sine is a broadband click, not an alias.
        let peak = out.dropFirst(1000).dropLast(200).map { abs(Int($0)) }.max() ?? 0
        XCTAssertLessThan(peak, 100)
    }

    func testPassThroughIsExact() {
        let r = Resampler(inputRate: 24_000)
        let ints: [Int16] = [0, 1, -1, 32767, -32768, 1234, -4321]
        let floats = ints.map { Float($0) / 32768 }
        XCTAssertEqual(floats.withUnsafeBufferPointer { r.process($0) }, ints)
    }
}

final class WAVTests: XCTestCase {
    func testPCM16RoundTrip() throws {
        let s: [Int16] = (0..<1000).map { Int16(($0 * 97) % 60000 - 30000) }
        let d = WAV.encodePCM16(s, sampleRate: 24_000)
        XCTAssertEqual(d.count, 44 + 2000)
        let w = try WAV.decode(d)
        XCTAssertEqual(w.sampleRate, 24_000)
        XCTAssertEqual(w.channels, 1)
        XCTAssertEqual(w.samples.map(floatToInt16), s)
        XCTAssertEqual(try WAV.decode24k(d), s)
    }

    func build(format: UInt16, channels: UInt16, rate: UInt32, bits: UInt16, body: Data, extensible: Bool = false, extraChunk: Bool = false) -> Data {
        var d = Data()
        func p32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func p16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        let fmtLen: UInt32 = extensible ? 40 : 16
        d.append(contentsOf: Array("RIFF".utf8)); p32(0); d.append(contentsOf: Array("WAVE".utf8))
        if extraChunk { d.append(contentsOf: Array("LIST".utf8)); p32(3); d.append(contentsOf: [1, 2, 3, 0]) }
        d.append(contentsOf: Array("fmt ".utf8)); p32(fmtLen)
        p16(extensible ? 0xFFFE : format); p16(channels); p32(rate)
        p32(rate * UInt32(channels) * UInt32(bits / 8)); p16(channels * bits / 8); p16(bits)
        if extensible { p16(22); p16(bits); p32(0); p16(format); d.append(Data(count: 14)) }
        d.append(contentsOf: Array("data".utf8)); p32(UInt32(body.count)); d.append(body)
        return d
    }

    func testStereoFloatExtensible() throws {
        var body = Data()
        for (l, r) in [(Float(0.5), Float(-0.5)), (0.25, 0.75)] {
            withUnsafeBytes(of: l) { body.append(contentsOf: $0) }
            withUnsafeBytes(of: r) { body.append(contentsOf: $0) }
        }
        let w = try WAV.decode(build(format: 3, channels: 2, rate: 48_000, bits: 32, body: body, extensible: true, extraChunk: true))
        XCTAssertEqual(w.channels, 2)
        XCTAssertEqual(w.sampleRate, 48_000)
        XCTAssertEqual(w.samples, [0, 0.5])
    }

    func test24Bit() throws {
        let body = Data([0x00, 0x00, 0x40, 0x00, 0x00, 0xC0])  // +0.5, -0.5
        let w = try WAV.decode(build(format: 1, channels: 1, rate: 16_000, bits: 24, body: body))
        XCTAssertEqual(w.samples, [0.5, -0.5])
    }

    func testRejectsGarbage() {
        XCTAssertThrowsError(try WAV.decode(Data("hello".utf8)))
        XCTAssertThrowsError(try WAV.decode(build(format: 2, channels: 1, rate: 8000, bits: 4, body: Data(count: 10))))
    }

    func testRepoFixture() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../test/fixtures/ask-files.wav")
        let pcm = try WAV.decode24k(Data(contentsOf: url))
        XCTAssertGreaterThan(pcm.count, 24_000)
        XCTAssertGreaterThan(pcm.map { abs(Int($0)) }.max() ?? 0, 1_200)
    }
}

final class FramerTests: XCTestCase {
    func testFramesAndHostTime() {
        var f = Framer()
        XCTAssertTrue(f.append([Int16](repeating: 1, count: 300), hostNsOfFirst: 1_000_000_000).isEmpty)
        let out = f.append([Int16](repeating: 2, count: 700), hostNsOfFirst: 1_012_500_000)  // 300 samples = 12.5 ms later
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[0].samples.count, 480)
        XCTAssertEqual(out[0].hostNs, 1_000_000_000)
        XCTAssertEqual(out[1].hostNs, 1_020_000_000)
        XCTAssertEqual(out[0].samples[299], 1)
        XCTAssertEqual(out[0].samples[300], 2)
        XCTAssertEqual(f.pending, 40)
    }
}

final class SilenceDetectorTests: XCTestCase {
    func testDigitalSilence() {
        var d = SilenceDetector(thresholdFrames: 5)
        let zero = [Int16](repeating: 0, count: 480)
        var noise = zero; noise[10] = 3
        for _ in 0..<4 { XCTAssertNil(d.feed(zero, muted: false)) }
        XCTAssertEqual(d.feed(zero, muted: false), true)
        XCTAssertNil(d.feed(zero, muted: false))
        XCTAssertEqual(d.feed(noise, muted: false), false)
        // Muted frames never count.
        for _ in 0..<10 { XCTAssertNil(d.feed(zero, muted: true)) }
        XCTAssertFalse(d.silent)
        // Low-level noise is not digital silence.
        for _ in 0..<10 { XCTAssertNil(d.feed(noise, muted: false)) }
    }
}

final class AudioContractTests: XCTestCase {
    func testFrameSize() { XCTAssertEqual(PCMFrame(samples: Data(count: 960), hostTimeNs: 0, muted: false).samples.count, 960) }

    func testRealEngineRefusesInTests() {
        XCTAssertTrue(ProcessGuard.isTestProcess)
        let real = RealAudioIO(isTestProcess: true)
        XCTAssertThrowsError(try real.start(listenOnly: false)) { XCTAssertEqual($0 as? AudioIOError, .testMode) }
        XCTAssertThrowsError(try RealAudioIO().start(listenOnly: true)) { XCTAssertEqual($0 as? AudioIOError, .testMode) }
        XCTAssertNil(real.route)
        XCTAssertTrue(makeAudioIO(test: true, env: [:]) is FakeAudioIO)
        XCTAssertTrue(makeAudioIO(test: false, env: [:]) is FakeAudioIO, "an XCTest process never gets the real engine")
    }

    func testErrorNamesMatchDaemonDeniedRule() {
        let denied = try! NSRegularExpression(pattern: "NotAllowed|Permission|Security", options: [.caseInsensitive])
        func isDenied(_ e: AudioIOError) -> Bool { denied.firstMatch(in: e.name, range: NSRange(location: 0, length: e.name.utf16.count)) != nil }
        XCTAssertTrue(isDenied(.micDenied))
        XCTAssertTrue(isDenied(.micRestricted))
        XCTAssertFalse(isDenied(.noInputDevice))
        XCTAssertFalse(isDenied(.engine("x")))
    }
}
