// AudioPump: bridges the audio engine and the link (docs/NATIVE.md §2.2-§2.5, §4.3).
//
// SottoClient does not import SottoAudio, so the engine side is closures: the
// app (Controller) wires `hooks` to AudioIO and feeds `pushMic` from
// AudioIO.onMicFrame. The pump owns the protocol rules:
//   - capture demand from status.state (full / listen / off) and the link,
//   - mic frames: per-connection seq from 0, MUTED zeros, FAKE flag, 960 bytes only,
//   - speaker frames to playback in socket order, AFTER_FLUSH passed through,
//   - audio_flush -> flush, handled on the link queue before any later frame,
//   - audio_stats about once a second while connected.
import Foundation

public final class AudioPump: @unchecked Sendable {
    /// What the engine should be doing.
    public enum Capture: String, Equatable, Sendable {
        /// Mic + playout (connecting, live, reconnecting).
        case full
        /// Mic only (sleeping: frames feed the daemon's wake VAD).
        case listen
        /// Release the input device (paused, off, closing, waiting_page, link gone).
        case off
    }

    public struct Hooks {
        /// Start/stop the engine. Called on the link's callback queue (main by default), only on change.
        public var setCapture: (Capture) -> Void
        /// One speaker frame (PCM16LE 24 kHz, 960 bytes). Called on the link queue, in order.
        public var play: (_ pcm: Data, _ seq: UInt32, _ afterFlush: Bool) -> Void
        /// Drop everything queued for playout now. Called on the link queue.
        public var flush: (_ reason: String) -> Void
        /// Current playout stats (`micSeq` is filled in by the pump); nil skips this tick.
        public var stats: () -> AudioStatsMessage?
        public init(setCapture: @escaping (Capture) -> Void,
                    play: @escaping (Data, UInt32, Bool) -> Void,
                    flush: @escaping (String) -> Void,
                    stats: @escaping () -> AudioStatsMessage?) {
            self.setCapture = setCapture; self.play = play; self.flush = flush; self.stats = stats
        }
    }

    public struct Counters: Equatable, Sendable {
        public var micFrames = 0, micMuted = 0, micBadSize = 0, micGated = 0, speakerFrames = 0, flushes = 0, statsSent = 0
    }

    /// States in which the app streams the mic (docs/NATIVE.md §2.2).
    public static let uplinkStates: Set<String> = ["connecting", "live", "reconnecting", "sleeping"]

    /// Pure: what the engine should do for a daemon state while the link is `linkUp` (or recently lost).
    public static func capture(for state: String?, linkUp: Bool) -> Capture {
        guard linkUp, let s = state else { return .off }
        switch s {
        case "connecting", "live", "reconnecting": return .full
        case "sleeping": return .listen
        default: return .off
        }
    }

    public let link: LinkClient
    public let fake: Bool
    public var statsInterval: Double = 1

    private let hooks: Hooks
    private let lock = NSLock()
    // Guarded by `lock` (touched from the audio queue and the link queue).
    private var seq: UInt32 = 0
    private var uplink = false
    private var statusMuted = false
    private var _localMute = false
    private var _counters = Counters()
    // Link-queue state.
    private var daemonState: String?
    private var linkUp = false
    private var capture: Capture = .off
    private var statsTimer: DispatchSourceTimer?

    public init(link: LinkClient, fake: Bool, hooks: Hooks) {
        self.link = link
        self.fake = fake
        self.hooks = hooks
        link.onSpeakerFrame = { [weak self] f in self?.speaker(f) }
        link.addMessageTap { [weak self] m in self?.message(m) }
        link.addStateTap { [weak self] s in self?.linkState(s) }
    }

    deinit { statsTimer?.cancel() }

    /// Local mute (the app's own state, set before the daemon confirms): frames go out as MUTED zeros.
    public var localMute: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _localMute }
        set { lock.lock(); _localMute = newValue; lock.unlock() }
    }

    public var counters: Counters { lock.lock(); defer { lock.unlock() }; return _counters }
    public var currentCapture: Capture { link.queue.sync { capture } }
    public var micSeq: UInt32 { lock.lock(); defer { lock.unlock() }; return seq }

    /// One 20 ms capture frame from the engine (any thread; does not block on the network).
    public func pushMic(samples: Data, hostTimeNs: UInt64, muted: Bool) {
        lock.lock()
        guard uplink else { _counters.micGated += 1; lock.unlock(); return }
        guard samples.count == NativeProtocol.frameBytes else { _counters.micBadSize += 1; lock.unlock(); return }
        let zero = muted || statusMuted || _localMute
        var flags: FrameFlags = fake ? [.fake] : []
        if zero { flags.insert(.muted); _counters.micMuted += 1 }
        let s = seq
        seq &+= 1
        _counters.micFrames += 1
        lock.unlock()
        let pcm = zero ? Data(count: NativeProtocol.frameBytes) : samples
        link.sendMicFrame(WireFrame(kind: .mic, flags: flags, seq: s, timestampNs: hostTimeNs, pcm: pcm))
    }

    // MARK: link queue

    private func speaker(_ f: WireFrame) {
        lock.lock(); _counters.speakerFrames += 1; lock.unlock()
        hooks.play(f.pcm, f.seq, f.flags.contains(.afterFlush))
    }

    private func message(_ m: ServerMessage) {
        switch m {
        case .welcome(_, _, let status, _):
            lock.lock(); seq = 0; lock.unlock()   // seq is per connection
            linkUp = true
            apply(status)
            startStats()
        case .status(let s):
            apply(s)
        case .audioFlush(let reason):
            lock.lock(); _counters.flushes += 1; lock.unlock()
            hooks.flush(reason)
        case .command(let c) where c.command == "close_window":
            // Voice off: stop audio now; the status that follows says "off" too.
            daemonState = "off"
            update()
        default:
            break
        }
    }

    private func apply(_ s: PageStatus?) {
        guard let s else { return }
        daemonState = s.state
        lock.lock(); statusMuted = s.live?.muted == true; lock.unlock()
        update()
    }

    private func linkState(_ s: LinkState) {
        switch s {
        case .connected:
            linkUp = true
        case .backoff, .bootstrapping, .connecting:
            // Brief loss (daemon self-update, 4005): keep the engine as it was so the
            // daemon's 10 s grace can resume the same session, but stop uplink.
            stopStats()
            lock.lock(); uplink = false; lock.unlock()
            return
        case .idle, .failed:
            linkUp = false
            stopStats()
        }
        update()
    }

    private func update() {
        let c = AudioPump.capture(for: daemonState, linkUp: linkUp)
        lock.lock()
        uplink = linkUp && link.isConnectedOnQueue && AudioPump.uplinkStates.contains(daemonState ?? "")
        lock.unlock()
        guard c != capture else { return }
        capture = c
        let cb = hooks.setCapture
        link.config.callbackQueue.async { cb(c) }
    }

    private func startStats() {
        stopStats()
        let t = DispatchSource.makeTimerSource(queue: link.queue)
        t.schedule(deadline: .now() + statsInterval, repeating: statsInterval)
        t.setEventHandler { [weak self] in
            guard let self, var s = self.hooks.stats() else { return }
            s.micSeq = self.micSeq
            self.link.sendOnQueue(.audioStats(s))
            self.lock.lock(); self._counters.statsSent += 1; self.lock.unlock()
        }
        t.resume()
        statsTimer = t
    }

    private func stopStats() { statsTimer?.cancel(); statsTimer = nil }
}
