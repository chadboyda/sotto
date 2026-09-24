import XCTest
@testable import SottoAudio

func frame(_ value: Int16, count: Int = 480) -> Data { pcmData([Int16](repeating: value, count: count)) }

extension JitterPlayout {
    /// Render `n` samples and return them as Int16.
    func take(_ n: Int, hostNs: UInt64 = 0) -> [Int16] {
        var buf = [Float](repeating: 0, count: n)
        buf.withUnsafeMutableBufferPointer { render($0.baseAddress!, count: n, hostNs: hostNs) }
        return buf.map(floatToInt16)
    }
    func takeFrames(_ n: Int) -> [[Int16]] { (0..<n).map { _ in take(480) } }
}

final class JitterPlayoutTests: XCTestCase {
    func testStartsAtTarget() {
        let j = JitterPlayout()
        XCTAssertEqual(j.targetMs, 60)
        j.push(frame(1000), seq: 0, afterFlush: false)
        j.push(frame(1001), seq: 1, afterFlush: false)
        XCTAssertEqual(j.take(480), [Int16](repeating: 0, count: 480), "below target: silence")
        j.push(frame(1002), seq: 2, afterFlush: false)
        XCTAssertEqual(j.take(480).first, 1000, "target reached: playout starts")
        XCTAssertEqual(j.playoutSeq, 0)
        XCTAssertEqual(j.take(480).first, 1001)
        XCTAssertEqual(j.playoutSeq, 1)
        XCTAssertEqual(j.bufferedMs, 20, accuracy: 0.01)
    }

    func testPartialRendersKeepOrder() {
        let j = JitterPlayout()
        let ramp = (0..<(480 * 4)).map { Int16($0 % 30000) }
        for f in 0..<4 { j.push(pcmData(Array(ramp[f * 480..<(f + 1) * 480])), seq: UInt32(f), afterFlush: false) }
        var got: [Int16] = []
        for n in [7, 128, 333, 512, 1, 939] { got += j.take(n) }
        XCTAssertEqual(got, ramp)
    }

    func testPlayoutHostTime() {
        let j = JitterPlayout()
        for s in 0..<4 { j.push(frame(500), seq: UInt32(s), afterFlush: false) }
        _ = j.take(240, hostNs: 1_000_000_000)
        XCTAssertEqual(j.playoutHostNs, 1_000_000_000)
        _ = j.take(480, hostNs: 2_000_000_000)  // frame 1 starts 240 samples (10 ms) into this block
        XCTAssertEqual(j.playoutSeq, 1)
        XCTAssertEqual(j.playoutHostNs, 2_010_000_000)
    }

    func testUnderrunRaisesTargetThenDecays() {
        var c = JitterPlayout.Config()
        c.decayMs = 1_000
        let j = JitterPlayout(config: c)
        for s in 0..<3 { j.push(frame(2000), seq: UInt32(s), afterFlush: false) }
        _ = j.takeFrames(3)
        XCTAssertEqual(j.take(480), [Int16](repeating: 0, count: 480), "ran dry: silence")
        XCTAssertEqual(j.underruns, 0, "not counted until audio resumes")
        j.push(frame(2000), seq: 3, afterFlush: false)
        _ = j.take(480)
        XCTAssertEqual(j.underruns, 1, "resumed within 1 s: a starved stream")
        XCTAssertEqual(j.targetMs, 80)
        // Waits for the raised target (4 frames).
        for s in 4..<6 { j.push(frame(2000), seq: UInt32(s), afterFlush: false) }
        XCTAssertEqual(j.take(480).first, 0)
        j.push(frame(2000), seq: 6, afterFlush: false)
        XCTAssertEqual(j.take(480).first, 2000)
        // Decay after decayMs without another underrun.
        _ = j.take(24 * 1_100)
        XCTAssertEqual(j.targetMs, 60)
    }

    func testEndOfTurnIsNotAnUnderrun() {
        let j = JitterPlayout()
        for s in 0..<3 { j.push(frame(2000), seq: UInt32(s), afterFlush: false) }
        _ = j.takeFrames(3)
        _ = j.take(24 * 1_500)  // 1.5 s of silence between turns
        for s in 3..<6 { j.push(frame(2000), seq: UInt32(s), afterFlush: false) }
        XCTAssertEqual(j.take(480).first, 2000)
        XCTAssertEqual(j.underruns, 0)
        XCTAssertEqual(j.targetMs, 60)
    }

    func testTargetClampedToMax() {
        let j = JitterPlayout()
        for i in 0..<20 {
            // One frame, played after the stall timeout, then a short gap: a starved stream every time.
            j.push(frame(2000), seq: UInt32(i), afterFlush: false)
            _ = j.take(480 * 12)
        }
        j.push(frame(2000), seq: 99, afterFlush: false)
        _ = j.take(480)
        XCTAssertEqual(j.underruns, 20)
        XCTAssertEqual(j.targetMs, 200, "raised 20 ms per underrun, clamped at 200")
    }

    func testOverrunDropsOnlyQuietFrames() {
        let j = JitterPlayout()
        // 20 frames = 400 ms > 300 ms: alternate quiet (peak 100) and loud (peak 5000).
        for s in 0..<20 { j.push(frame(s % 2 == 0 ? 100 : 5000), seq: UInt32(s), afterFlush: false) }
        var played: [UInt32] = []
        var loud = 0
        for _ in 0..<20 {
            let f = j.take(480)
            if f.first == 5000 { loud += 1 }
            played.append(j.playoutSeq)
            if j.bufferedMs == 0 { break }
        }
        XCTAssertEqual(loud, 10, "every loud frame is played")
        XCTAssertGreaterThan(j.overruns, 0)
        XCTAssertLessThan(j.overruns, 10)
    }

    func testOverrunNeverDropsSpeech() {
        let j = JitterPlayout()
        for s in 0..<25 { j.push(frame(4000), seq: UInt32(s), afterFlush: false) }
        var n = 0
        while j.take(480).first == 4000 { n += 1 }
        XCTAssertEqual(n, 25)
        XCTAssertEqual(j.overruns, 0)
    }

    func testFlushDropsAtOnceWithShortFade() {
        let j = JitterPlayout()
        for s in 0..<10 { j.push(frame(10000), seq: UInt32(s), afterFlush: false) }
        _ = j.take(100)
        j.flush()
        let out = j.take(480)
        XCTAssertEqual(out[0], 10000, "fade starts at the last level")
        XCTAssertLessThan(abs(Int(out[60])), 10000)
        XCTAssertEqual(Array(out[120...]), [Int16](repeating: 0, count: 360), "silent within 5 ms")
        XCTAssertTrue(out[0..<120].allSatisfy { abs(Int($0)) <= 10000 })
        XCTAssertEqual(j.bufferedMs, 0)
        XCTAssertEqual(j.take(480), [Int16](repeating: 0, count: 480))
    }

    func testAfterFlushFrameReplacesQueue() {
        let j = JitterPlayout()
        for s in 0..<6 { j.push(frame(1111), seq: UInt32(s), afterFlush: false) }
        _ = j.take(480)
        j.flush()
        j.push(frame(2222), seq: 0, afterFlush: true)
        j.push(frame(2223), seq: 1, afterFlush: false)
        j.push(frame(2224), seq: 2, afterFlush: false)
        var got: [Int16] = []
        for _ in 0..<5 { got.append(j.take(480)[200]) }
        XCTAssertFalse(got.contains(1111), "nothing from before the flush")
        XCTAssertEqual(got.filter { $0 >= 2222 }, [2222, 2223, 2224])
    }

    func testAfterFlushFlagAloneFlushes() {
        let j = JitterPlayout()
        for s in 0..<6 { j.push(frame(1111), seq: UInt32(s), afterFlush: false) }
        _ = j.take(480)
        for s in 0..<3 { j.push(frame(3333), seq: UInt32(s), afterFlush: s == 0) }
        var got: [Int16] = []
        for _ in 0..<4 { got.append(j.take(480)[300]) }
        XCTAssertFalse(got.contains(1111))
        XCTAssertEqual(got.filter { $0 == 3333 }.count, 3)
    }

    func testShortTailStartsAfterStall() {
        let j = JitterPlayout()
        j.push(frame(700), seq: 0, afterFlush: false)
        var heard = false
        for _ in 0..<6 where !heard { heard = j.take(480).contains(700) }
        XCTAssertTrue(heard, "a lone final frame is played after the stall timeout")
    }

    func testRingFullDropsNewest() {
        let j = JitterPlayout(capacityFrames: 16)
        var ok = 0
        for s in 0..<20 where j.push(frame(1), seq: UInt32(s), afterFlush: false) { ok += 1 }
        XCTAssertEqual(ok, 16)
        XCTAssertEqual(j.overruns, 4)
    }

    func testShortFrameZeroPadded() {
        let j = JitterPlayout()
        j.push(frame(900, count: 100), seq: 0, afterFlush: false)
        j.push(frame(900), seq: 1, afterFlush: false)
        j.push(frame(900), seq: 2, afterFlush: false)
        let f = j.take(480)
        XCTAssertEqual(f[99], 900)
        XCTAssertEqual(f[100], 0)
    }

    func testTwoAfterFlushFramesSkipToTheNewest() {
        // Two voices' flushes land between render callbacks: nothing between them may play.
        let j = JitterPlayout()
        for s in 0..<3 { j.push(frame(1111), seq: UInt32(s), afterFlush: false) }
        _ = j.take(480)
        j.push(frame(2222), seq: 10, afterFlush: true)
        j.push(frame(2222), seq: 11, afterFlush: false)
        j.push(frame(3333), seq: 20, afterFlush: true)
        for s in 21..<24 { j.push(frame(3333), seq: UInt32(s), afterFlush: false) }
        var heard: [Int16] = []
        for _ in 0..<8 { heard += j.take(480) }
        XCTAssertFalse(heard.contains(2222), "audio between the two flushes is dropped")
        XCTAssertTrue(heard.contains(3333))
    }

    func testSampleResetKeepsLaterSamplesWithoutARenderInBetween() {
        // A preview stopped while no output unit renders, then a new sample: the new one plays.
        let ring = SampleRing(capacity: 4096)
        ring.write([Int16](repeating: 1000, count: 100))
        ring.reset()
        XCTAssertTrue(ring.isEmpty)
        ring.write([Int16](repeating: 2000, count: 50))
        XCTAssertFalse(ring.isEmpty)
        var out = [Float](repeating: 0, count: 200)
        out.withUnsafeMutableBufferPointer { ring.mix(into: $0.baseAddress!, count: 200) }
        let got = out.map(floatToInt16)
        XCTAssertEqual(got[0], 2000)
        XCTAssertEqual(got[49], 2000)
        XCTAssertEqual(got[50], 0)
        XCTAssertTrue(ring.isEmpty)
    }
}
