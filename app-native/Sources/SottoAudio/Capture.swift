// Uplink: device samples -> 24 kHz PCM16 -> 20 ms frames with host time (NATIVE.md §2.2, §5.3).
//
// render thread: CaptureRing.write (device-rate Float, lock-free)
// drain queue:   CapturePipeline.drain -> Resampler -> Framer -> MicFrameEmitter -> onMicFrame
import Foundation

/// Accumulates 24 kHz samples and cuts 480-sample frames stamped with the host time of their first sample.
public struct Framer {
    public static let frameSamples = 480
    private var buf: [Int16] = []
    private var startNs: UInt64 = 0

    public init() { buf.reserveCapacity(Framer.frameSamples * 4) }

    public var pending: Int { buf.count }

    /// `hostNsOfFirst` is the host time of `samples[0]`.
    public mutating func append(_ samples: [Int16], hostNsOfFirst: UInt64) -> [(samples: [Int16], hostNs: UInt64)] {
        guard !samples.isEmpty else { return [] }
        // Re-anchor on the newest information: the buffered tail sits just before `samples`.
        let back = UInt64(buf.count) * 1_000_000_000 / 24_000
        startNs = hostNsOfFirst >= back ? hostNsOfFirst - back : 0
        buf.append(contentsOf: samples)
        var out: [(samples: [Int16], hostNs: UInt64)] = []
        var off = 0
        while buf.count - off >= Framer.frameSamples {
            out.append((Array(buf[off..<off + Framer.frameSamples]), startNs))
            off += Framer.frameSamples
            startNs &+= 20_000_000
        }
        if off > 0 { buf.removeFirst(off) }
        return out
    }

    public mutating func reset() { buf.removeAll(keepingCapacity: true) }
}

/// Exact digital silence on an unmuted mic for `thresholdFrames` (3 s) = a blocked or dead input
/// (macOS delivers zeros when the mic is privacy-blocked). Real mics always carry some noise.
public struct SilenceDetector {
    public let thresholdFrames: Int
    private var zeroRun = 0
    public private(set) var silent = false

    public init(thresholdFrames: Int = 150) { self.thresholdFrames = thresholdFrames }

    /// Returns the new state when it changes, else nil. Muted frames are ignored.
    public mutating func feed(_ samples: [Int16], muted: Bool) -> Bool? {
        if muted { return nil }
        if samples.allSatisfy({ $0 == 0 }) {
            zeroRun += 1
            if !silent, zeroRun >= thresholdFrames { silent = true; return true }
        } else {
            zeroRun = 0
            if silent { silent = false; return false }
        }
        return nil
    }

    public mutating func reset() { zeroRun = 0; silent = false }
}

/// Final stage shared by the real and fake engines: mute (zeros + muted flag),
/// the digital-silence detector, the mic level, then `onMicFrame`.
final class MicFrameEmitter: @unchecked Sendable {
    var onMicFrame: ((PCMFrame) -> Void)?
    var onSilence: ((Bool) -> Void)?
    let muted = AtomicInt()
    private let level = AtomicInt()
    private let frames = AtomicInt()
    private var detector = SilenceDetector()
    private static let zeros = Data(count: Framer.frameSamples * 2)

    var micLevel: Float { level.float }
    var frameCount: Int { Int(frames.value) }

    /// Called on one serial queue.
    func emit(_ samples: [Int16], hostNs: UInt64) {
        let isMuted = muted.value != 0
        if let change = detector.feed(samples, muted: isMuted) { onSilence?(change) }
        let data: Data
        if isMuted {
            data = MicFrameEmitter.zeros
            level.storeFloat(0)
        } else {
            data = pcmData(samples)
            level.storeFloat(samples.withUnsafeBufferPointer { rms($0) })
        }
        frames.add(1)
        onMicFrame?(PCMFrame(samples: data, hostTimeNs: hostNs, muted: isMuted))
    }

    func resetDetector() { detector.reset() }
}

/// Lock-free SPSC ring of device-rate Float samples written by the capture render thread,
/// plus the host time of device sample 0 (re-anchored every callback) and a drop counter.
final class CaptureRing: @unchecked Sendable {
    let rate: Double
    private let buf: UnsafeMutablePointer<Float>
    private let cap: Int
    private let w = AtomicInt(), r = AtomicInt()
    private let anchorNs = AtomicInt()
    let drops: AtomicInt

    init(rate: Double, seconds: Double = 1, drops: AtomicInt = AtomicInt()) {
        self.rate = rate
        self.drops = drops
        var c = 1
        while c < Int(rate * seconds) { c <<= 1 }
        cap = c
        buf = .allocate(capacity: c); buf.initialize(repeating: 0, count: c)
    }
    deinit { buf.deallocate() }

    /// Render thread. `hostNs` = host time of `p[0]` (0 if unknown: keep the previous anchor).
    @inline(__always)
    func write(_ p: UnsafePointer<Float>, count n: Int, stride: Int = 1, hostNs: UInt64) {
        let wi = w.value
        if hostNs != 0 {
            anchorNs.store(Int64(bitPattern: hostNs &- UInt64(Double(wi) * 1e9 / rate)))
        }
        let free = cap - Int(wi - r.value)
        if n > free { drops.add(Int64(n)); return }  // drain stalled: drop this callback, keep latency low
        for k in 0..<n { buf[Int(wi + Int64(k)) & (cap - 1)] = p[k * stride] }
        w.store(wi + Int64(n))
    }

    /// Drain queue: everything available, and the host time of its first sample.
    func read() -> ([Float], UInt64)? {
        let ri = r.value
        let n = Int(w.value - ri)
        guard n > 0 else { return nil }
        var out = [Float](repeating: 0, count: n)
        for k in 0..<n { out[k] = buf[Int(ri + Int64(k)) & (cap - 1)] }
        r.store(ri + Int64(n))
        let host = UInt64(bitPattern: anchorNs.value) &+ UInt64(Double(ri) * 1e9 / rate)
        return (out, host)
    }
}

/// Owns one route's capture chain on a serial queue drained every 10 ms.
final class CapturePipeline: @unchecked Sendable {
    let ring: CaptureRing
    var rate: Double { ring.rate }
    private let resampler: Resampler
    private var framer = Framer()
    private let emitter: MicFrameEmitter
    private let queue: DispatchQueue
    private var timer: DispatchSourceTimer?

    init(rate: Double, emitter: MicFrameEmitter, queue: DispatchQueue, drops: AtomicInt = AtomicInt()) {
        ring = CaptureRing(rate: rate, drops: drops)
        resampler = Resampler(inputRate: rate)
        self.emitter = emitter
        self.queue = queue
    }

    func start() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + .milliseconds(10), repeating: .milliseconds(10), leeway: .milliseconds(2))
        t.setEventHandler { [weak self] in self?.drain() }
        timer = t
        t.resume()
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    private func drain() {
        guard let (floats, host) = ring.read() else { return }
        let out = floats.withUnsafeBufferPointer { resampler.process($0) }
        guard !out.isEmpty else { return }
        for f in framer.append(out, hostNsOfFirst: host) { emitter.emit(f.samples, hostNs: f.hostNs) }
    }
}
