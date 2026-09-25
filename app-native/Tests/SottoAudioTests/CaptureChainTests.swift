import XCTest
@testable import SottoAudio

/// The capture chain as RealAudioIO runs it (CaptureRing -> CapturePipeline -> Resampler -> Framer ->
/// MicFrameEmitter), fed synthetic device-rate audio: no devices, nothing played.
/// A Bluetooth headset mic in call mode (HFP) runs at 16 or 8 kHz; the chain must turn that into
/// 24 kHz frames at the right pitch and length, including after a mid-session rate change (rebuild).
final class CaptureChainTests: XCTestCase {
    static let f0 = 200.0

    /// A voice-like harmonic tone: 200 Hz fundamental with 400 and 600 Hz partials.
    func harmonic(rate: Double, seconds: Double) -> [Float] {
        (0..<Int(rate * seconds)).map { i in
            let t = Double(i) / rate
            return Float(0.4 * sin(2 * .pi * Self.f0 * t) + 0.2 * sin(2 * .pi * 2 * Self.f0 * t) + 0.1 * sin(2 * .pi * 3 * Self.f0 * t))
        }
    }

    /// Runs `input` through a pipeline built for `builtRate`, written in 10 ms render callbacks stamped
    /// with host times consistent with `trueRate`. Returns the emitted frames.
    func capture(_ input: [Float], builtRate: Double, trueRate: Double, emitter: MicFrameEmitter, baseNs: UInt64 = 1_000_000_000) -> [PCMFrame] {
        var frames: [PCMFrame] = []
        let lock = NSLock()
        emitter.onMicFrame = { f in lock.lock(); frames.append(f); lock.unlock() }
        let queue = DispatchQueue(label: "test.capture")
        let pipe = CapturePipeline(rate: builtRate, emitter: emitter, queue: queue)
        pipe.start()
        let chunk = Int(trueRate / 100)
        input.withUnsafeBufferPointer { p in
            var i = 0
            while i < p.count {
                let n = min(chunk, p.count - i)
                pipe.ring.write(p.baseAddress! + i, count: n, hostNs: baseNs + UInt64(Double(i) / trueRate * 1e9))
                i += n
                if i % (chunk * 20) == 0 { usleep(20_000) }  // let the 10 ms drain keep up, like a live device
            }
        }
        // Everything written; wait for the drain to catch up.
        let expected = Int(Double(input.count) / builtRate * 50) - 2
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            lock.lock(); let n = frames.count; lock.unlock()
            if n >= expected { break }
            usleep(10_000)
        }
        usleep(30_000)
        pipe.stop()
        queue.sync {}
        XCTAssertEqual(pipe.ring.drops.value, 0)
        lock.lock(); defer { lock.unlock() }
        return frames
    }

    func samples(_ frames: [PCMFrame]) -> [Int16] { frames.flatMap { int16Array($0.samples) } }

    func assertVoice(_ frames: [PCMFrame], seconds: Double, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        // Duration: 50 frames (480 samples at 24 kHz) per second, minus the converter's tail.
        XCTAssertEqual(Double(frames.count), seconds * 50, accuracy: 2, "\(label): frame count (duration)", file: file, line: line)
        let s = samples(frames)
        guard s.count > 4_800 else { return XCTFail("\(label): too short", file: file, line: line) }
        let mid = Array(s[2_400..<(s.count - 1_200)])
        // Pitch: the fundamental stays at 200 Hz (a wrong rate moves it by the rate ratio).
        XCTAssertGreaterThan(toneShare(mid, rate: 24_000, freq: Self.f0), 0.6, "\(label): 200 Hz fundamental", file: file, line: line)
        XCTAssertLessThan(toneShare(mid, rate: 24_000, freq: Self.f0 * 16 / 24), 0.05, "\(label): not slowed down", file: file, line: line)
        XCTAssertLessThan(toneShare(mid, rate: 24_000, freq: Self.f0 * 3), 0.1, "\(label): not sped up", file: file, line: line)
        // Zero crossings of the whole signal: 2 per fundamental period (the partials add none here).
        var crossings = 0
        for k in 1..<mid.count where (mid[k - 1] < 0) != (mid[k] < 0) { crossings += 1 }
        let hz = Double(crossings) / 2 / (Double(mid.count) / 24_000)
        XCTAssertEqual(hz, Self.f0, accuracy: 8, "\(label): zero-crossing pitch", file: file, line: line)
    }

    /// A rebuild hands over from the running chain to the new one (RealAudioIO.rebuild): the old
    /// one keeps emitting while the new stream is digital zeros (a Bluetooth profile switch), and
    /// stops the moment the new one carries audio. No gap, no frame twice.
    func testHandOverKeepsTheOldChainUntilTheNewOneIsLive() {
        let emitter = MicFrameEmitter()
        var frames: [Int16] = []
        let lock = NSLock()
        emitter.onMicFrame = { f in lock.lock(); frames.append(contentsOf: int16Array(f.samples)); lock.unlock() }
        let queue = DispatchQueue(label: "test.handover")
        let old = CapturePipeline(rate: 24_000, emitter: emitter, queue: queue)
        let new = CapturePipeline(rate: 24_000, emitter: emitter, queue: queue)
        new.onLive = { old.retire() }
        old.start(); new.start()
        let oldChunk = [Float](repeating: 0.25, count: 240), zeros = [Float](repeating: 0, count: 240), newChunk = [Float](repeating: -0.5, count: 240)
        func write(_ pipe: CapturePipeline, _ c: [Float]) { c.withUnsafeBufferPointer { pipe.ring.write($0.baseAddress!, count: c.count, hostNs: 0) } }
        // 200 ms: old audio, the new stream still zeros (switching).
        for _ in 0..<20 { write(old, oldChunk); write(new, zeros); usleep(10_000) }
        // The new stream comes alive; the old one would keep going but is retired.
        for _ in 0..<20 { write(old, oldChunk); write(new, newChunk); usleep(10_000) }
        usleep(50_000)
        old.stop(); new.stop(); queue.sync {}
        lock.lock(); let got = frames; lock.unlock()
        let oldValue = Int16(0.25 * 32767), newValue = Int16(-0.5 * 32767)
        let firstNew = got.firstIndex(where: { abs(Int($0) - Int(newValue)) < 400 })
        XCTAssertNotNil(firstNew, "the new chain's audio arrives")
        XCTAssertGreaterThan(got.filter { abs(Int($0) - Int(oldValue)) < 200 }.count, 24_000 / 10, "the old chain covered the switch")
        if let i = firstNew { XCTAssertFalse(got[..<i].contains(0), "the new chain's zeros were not interleaved with the old audio") }
        if let i = firstNew {
            XCTAssertFalse(got[i...].contains { abs(Int($0) - Int(oldValue)) < 200 }, "nothing from the old chain after the hand-over")
        }
    }

    func testHeadsetRates16kAnd8kBecome24kAtTheRightPitchAndLength() {
        for rate in [16_000.0, 8_000.0, 48_000.0] {
            let frames = capture(harmonic(rate: rate, seconds: 1), builtRate: rate, trueRate: rate, emitter: MicFrameEmitter())
            assertVoice(frames, seconds: 1, "\(Int(rate)) Hz")
            // Host times advance 20 ms per frame from the first sample's time.
            if frames.count > 10 {
                XCTAssertEqual(Double(frames[10].hostTimeNs - frames[0].hostTimeNs), 200_000_000, accuracy: 2_000_000, "\(Int(rate)) Hz: frame clock")
            }
        }
    }

    func testRateChangeMidSessionRebuildsAtTheNewRate() {
        // RealAudioIO rebuilds the chain (new ring + resampler, same emitter) when the input rate
        // moves, e.g. AirPods switching from 48 kHz to the 16 kHz call profile.
        let emitter = MicFrameEmitter()
        let before = capture(harmonic(rate: 48_000, seconds: 1), builtRate: 48_000, trueRate: 48_000, emitter: emitter)
        assertVoice(before, seconds: 1, "48 kHz before the change")
        let after = capture(harmonic(rate: 16_000, seconds: 1), builtRate: 16_000, trueRate: 16_000, emitter: emitter, baseNs: 3_000_000_000)
        assertVoice(after, seconds: 1, "16 kHz after the change")
        XCTAssertGreaterThanOrEqual(after.first?.hostTimeNs ?? 0, 3_000_000_000)
    }

    func testAStaleRateIsDetectableShortAndPitchShifted() {
        // The failure the rebuild prevents: 16 kHz audio through a chain still built for 48 kHz comes
        // out a third as long and three times too high. (Guards the assertions above.)
        let frames = capture(harmonic(rate: 16_000, seconds: 1), builtRate: 48_000, trueRate: 16_000, emitter: MicFrameEmitter())
        XCTAssertLessThan(frames.count, 20)
        let s = samples(frames)
        XCTAssertGreaterThan(toneShare(Array(s.dropFirst(1_200)), rate: 24_000, freq: Self.f0 * 3), 0.5)
    }
}
