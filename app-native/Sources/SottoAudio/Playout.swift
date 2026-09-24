// Downlink playout: the §2.4 jitter buffer over a lock-free SPSC frame ring, a sample
// player for previews / the echo test, and the mix the output unit renders.
//
// Threads: `push` runs on the link's queue (single producer), `render` on the audio
// render thread (single consumer), `flush` from anywhere. The render path does no
// allocation, locking, logging or Swift concurrency: preallocated storage + C atomics.
import Foundation

public final class JitterPlayout: @unchecked Sendable {
    public static let frameSamples = 480
    public static let sampleRate = 24_000
    static let samplesPerMs = 24

    public struct Config: Equatable, Sendable {
        public var targetMs = 60, minMs = 40, maxMs = 200
        /// Above this, quiet frames are dropped until the buffer is back at target.
        public var overrunMs = 300
        public var quietPeak = 1200
        /// Each underrun raises the target by `raiseMs`; each `decayMs` without one lowers it one step.
        public var raiseMs = 20, decayMs = 30_000
        /// A gap shorter than this between running dry and new audio counts as an underrun
        /// (longer ones are the end of a turn, not a starved stream).
        public var underrunGapMs = 1_000
        /// Waiting below target with no new frame for this long starts playout anyway (short tails).
        public var stallStartMs = 60
        /// Flush fade length (NATIVE.md: at most 5 ms).
        public var fadeMs = 5
        public init() {}
    }

    public let config: Config
    let capacity: Int
    private let mask: Int
    private let slots: UnsafeMutablePointer<Int16>
    private let peaks: UnsafeMutablePointer<Int32>
    private let seqs: UnsafeMutablePointer<UInt32>
    private let marks: UnsafeMutablePointer<UInt8>   // 1 = AFTER_FLUSH frame

    private let writeIdx = AtomicInt(), readIdx = AtomicInt(), flushReq = AtomicInt()
    // Stats, written by the render thread.
    private let aUnderruns = AtomicInt(), aOverruns = AtomicInt(), aFullDrops = AtomicInt()
    private let aBufferedSamples = AtomicInt(), aPlayoutSeq = AtomicInt(), aPlayoutHost = AtomicInt(), aTargetMs = AtomicInt()

    // Consumer (render thread) state.
    private var playing = false
    private var extraSteps = 0
    private var lastRaiseClock: Int64 = 0
    private var headOffset = 0
    private var clock: Int64 = 0
    private var starvedAt: Int64 = -1
    private var lastSeenWrite: Int64 = 0
    private var waitSince: Int64 = 0
    private var dropping = false
    private var lastOut: Float = 0
    private var fadeLevel: Float = 0
    private var fadeRemaining = 0

    public init(config: Config = Config(), capacityFrames: Int = 64) {
        self.config = config
        var cap = 1
        while cap < max(capacityFrames, 16) { cap <<= 1 }
        capacity = cap
        mask = cap - 1
        slots = .allocate(capacity: cap * JitterPlayout.frameSamples); slots.initialize(repeating: 0, count: cap * JitterPlayout.frameSamples)
        peaks = .allocate(capacity: cap); peaks.initialize(repeating: 0, count: cap)
        seqs = .allocate(capacity: cap); seqs.initialize(repeating: 0, count: cap)
        marks = .allocate(capacity: cap); marks.initialize(repeating: 0, count: cap)
        aTargetMs.store(Int64(config.targetMs))
    }

    deinit { slots.deallocate(); peaks.deallocate(); seqs.deallocate(); marks.deallocate() }

    private var targetFrames: Int {
        let ms = min(config.maxMs, max(config.minMs, config.targetMs + extraSteps * config.raiseMs))
        return max(1, ms / 20)
    }

    // MARK: producer

    /// Queue one 20 ms speaker frame (960 bytes; shorter is zero-padded). `afterFlush`
    /// drops everything queued before it. Returns false when the ring is full (frame dropped).
    @discardableResult
    public func push(_ pcm: Data, seq: UInt32, afterFlush: Bool) -> Bool {
        let w = writeIdx.value
        if Int(w - readIdx.value) >= capacity { aFullDrops.add(1); return false }
        let slot = Int(w) & mask
        let base = slots + slot * JitterPlayout.frameSamples
        let n = min(pcm.count / 2, JitterPlayout.frameSamples)
        pcm.withUnsafeBytes { raw in
            if n > 0 { memcpy(base, raw.baseAddress!, n * 2) }
        }
        if n < JitterPlayout.frameSamples { (base + n).update(repeating: 0, count: JitterPlayout.frameSamples - n) }
        peaks[slot] = Int32(peak(UnsafeBufferPointer(start: base, count: JitterPlayout.frameSamples)))
        seqs[slot] = seq
        marks[slot] = afterFlush ? 1 : 0
        writeIdx.store(w + 1)
        if afterFlush { flushReq.store(1) }
        return true
    }

    /// Drop everything queued now (with a ≤ 5 ms fade on the render thread). Any thread.
    public func flush() { flushReq.store(1) }

    // MARK: consumer (render thread)

    /// Render `count` samples at 24 kHz into `out` (overwrites). `hostNs` is the host time of `out[0]`.
    public func render(_ out: UnsafeMutablePointer<Float>, count: Int, hostNs: UInt64) {
        if flushReq.exchange(0) != 0 { applyFlush() }
        let fs = JitterPlayout.frameSamples
        var i = 0
        var r = readIdx.value
        while i < count {
            if fadeRemaining > 0 {
                let total = max(1, config.fadeMs * JitterPlayout.samplesPerMs)
                out[i] = fadeLevel * Float(fadeRemaining) / Float(total)
                fadeRemaining -= 1; i += 1; clock += 1
                continue
            }
            let w = writeIdx.value
            var avail = Int(w - r)
            if !playing {
                if avail > 0, starvedAt >= 0 {
                    if clock - starvedAt < Int64(config.underrunGapMs * JitterPlayout.samplesPerMs) {
                        aUnderruns.add(1)
                        extraSteps = min(extraSteps + 1, max(0, (config.maxMs - config.targetMs) / max(1, config.raiseMs)))
                        lastRaiseClock = clock
                    }
                    starvedAt = -1
                }
                if w != lastSeenWrite { lastSeenWrite = w; waitSince = clock }
                let stalled = avail > 0 && clock - waitSince >= Int64(config.stallStartMs * JitterPlayout.samplesPerMs)
                if avail >= targetFrames || stalled {
                    playing = true
                } else {
                    // Silence until the next frame boundary of the block (re-check then).
                    let n = min(count - i, fs)
                    (out + i).update(repeating: 0, count: n)
                    i += n; clock += Int64(n); lastOut = 0
                    continue
                }
            }
            if headOffset == 0 {
                if avail * 20 > config.overrunMs { dropping = true }
                if dropping {
                    while avail > targetFrames, Int(peaks[Int(r) & mask]) < config.quietPeak {
                        r += 1; avail -= 1; aOverruns.add(1)
                    }
                    if avail <= targetFrames { dropping = false }
                }
                if avail == 0 {
                    playing = false
                    starvedAt = clock
                    lastSeenWrite = w
                    waitSince = clock
                    continue
                }
                let slot = Int(r) & mask
                marks[slot] = 0
                aPlayoutSeq.store(Int64(seqs[slot]))
                aPlayoutHost.store(Int64(bitPattern: hostNs &+ UInt64(i) * 1_000_000_000 / UInt64(JitterPlayout.sampleRate)))
            }
            let n = min(count - i, fs - headOffset)
            let src = slots + (Int(r) & mask) * fs + headOffset
            for k in 0..<n { out[i + k] = Float(src[k]) / 32768 }
            lastOut = out[i + n - 1]
            headOffset += n; i += n; clock += Int64(n)
            if headOffset == fs { r += 1; headOffset = 0 }
        }
        readIdx.store(r)
        if extraSteps > 0, clock - lastRaiseClock >= Int64(config.decayMs * JitterPlayout.samplesPerMs) {
            extraSteps -= 1
            lastRaiseClock = clock
        }
        aTargetMs.store(Int64(targetFrames * 20))
        aBufferedSamples.store(max(0, (writeIdx.value - r) * Int64(fs) - Int64(headOffset)))
    }

    private func applyFlush() {
        var r = readIdx.value
        let w = writeIdx.value
        if headOffset > 0 { r += 1; headOffset = 0 }
        // Skip to the newest AFTER_FLUSH frame (two flushes can land between render
        // callbacks: stopping at the first would play the flushed-away audio between them),
        // or drop everything when none is queued.
        var target = w
        var k = w
        while k > r { k -= 1; if marks[Int(k) & mask] != 0 { target = k; break } }
        r = target
        readIdx.store(r)
        playing = false
        dropping = false
        starvedAt = -1
        lastSeenWrite = w
        waitSince = clock
        if lastOut != 0 { fadeLevel = lastOut; fadeRemaining = config.fadeMs * JitterPlayout.samplesPerMs }
        lastOut = 0
    }

    // MARK: stats (any thread)

    public var bufferedMs: Double { Double(aBufferedSamples.value) / Double(JitterPlayout.samplesPerMs) }
    public var targetMs: Int { Int(aTargetMs.value) }
    public var underruns: Int { Int(aUnderruns.value) }
    /// Quiet frames dropped for overrun plus frames dropped because the ring was full.
    public var overruns: Int { Int(aOverruns.value + aFullDrops.value) }
    public var playoutSeq: UInt32 { UInt32(truncatingIfNeeded: aPlayoutSeq.value) }
    public var playoutHostNs: UInt64 { UInt64(bitPattern: aPlayoutHost.value) }
}

/// SPSC Float ring at 24 kHz for `playSample` (voice previews, the echo test sample),
/// mixed over the jitter output. Producer: main queue. Consumer: render thread.
final class SampleRing: @unchecked Sendable {
    private let buf: UnsafeMutablePointer<Float>
    private let cap: Int
    /// `reset` publishes the write index to skip to; the consumer jumps there. Samples written
    /// after a reset are kept even when no output unit rendered in between.
    private let w = AtomicInt(), r = AtomicInt(), clearTo = AtomicInt()

    init(capacity: Int = 1 << 20) {
        var c = 1
        while c < capacity { c <<= 1 }
        cap = c
        buf = .allocate(capacity: c); buf.initialize(repeating: 0, count: c)
    }
    deinit { buf.deallocate() }

    /// Appends what fits; returns the count written.
    @discardableResult
    func write(_ s: [Int16]) -> Int {
        let wi = w.value
        let free = cap - Int(wi - r.value)
        let n = min(free, s.count)
        for k in 0..<n { buf[Int(wi + Int64(k)) & (cap - 1)] = Float(s[k]) / 32768 }
        w.store(wi + Int64(n))
        return n
    }

    var isEmpty: Bool { w.value <= max(r.value, clearTo.value) }
    /// Producer side (main queue): drop everything written so far.
    func reset() { clearTo.store(w.value) }

    /// Render thread: adds queued samples into `out`.
    func mix(into out: UnsafeMutablePointer<Float>, count: Int) {
        var ri = r.value
        let wi = w.value
        let c = clearTo.value
        if c > ri { ri = c }
        let n = min(count, Int(wi - ri))
        for k in 0..<n { out[k] += buf[Int(ri) & (cap - 1)]; ri += 1 }
        r.store(ri)
    }
}

/// What an output unit renders: jitter playout + sample player, clipped, metered.
public final class OutputPipeline: @unchecked Sendable {
    public let playout: JitterPlayout
    let samples = SampleRing()
    private let level = AtomicInt()

    public init(playout: JitterPlayout = JitterPlayout()) { self.playout = playout }

    /// Render thread.
    func render(_ out: UnsafeMutablePointer<Float>, count: Int, hostNs: UInt64) {
        playout.render(out, count: count, hostNs: hostNs)
        samples.mix(into: out, count: count)
        var acc: Float = 0
        for k in 0..<count {
            let v = max(-1, min(1, out[k]))
            out[k] = v
            acc += v * v
        }
        if count > 0 { level.storeFloat((acc / Float(count)).squareRoot()) }
    }

    var speakerLevel: Float { level.float }
}
