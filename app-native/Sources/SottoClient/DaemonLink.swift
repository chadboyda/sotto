// Daemon link surface (docs/NATIVE.md §1). STUB: builder B4 implements LinkClient.
import Foundation

public enum LinkState: Equatable, Sendable { case idle, bootstrapping, connecting, connected, backoff(seconds: Double), failed(String) }

/// Where to find the daemon: from sotto://open?port=&k=&data= (launch code) or a remembered data dir (page secret).
public struct LaunchRequest: Equatable, Sendable {
    public var port: Int
    public var code: String?
    public var dataDir: String?
    public init(port: Int, code: String?, dataDir: String?) { self.port = port; self.code = code; self.dataDir = dataDir }
}

public protocol DaemonLink: AnyObject {
    var onState: ((LinkState) -> Void)? { get set }
    var onMessage: ((ServerMessage) -> Void)? { get set }
    var onSpeakerFrame: ((WireFrame) -> Void)? { get set }
    /// Bootstrap (GET /api/bootstrap) then open the WebSocket and send hello. Reconnects by itself.
    func connect(_ launch: LaunchRequest)
    func send(_ message: ClientMessage)
    /// Called from a non-main thread at 50 Hz; must not block.
    func sendMicFrame(_ frame: WireFrame)
    /// GET /api/voice-preview?voice= with the page token; WAV bytes.
    func fetchVoicePreview(_ voice: String) async throws -> Data
    func close()
}
