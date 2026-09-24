// Launch requests and the trust checks around them (docs/NATIVE.md §1, §5.1-§5.2).
// Ported from app/Sources/Support.swift (parseUrlCommand, daemonRecordsPort)
// so the native app keeps exactly today's rules.
import Foundation

extension LaunchRequest {
    public static func validPort(_ s: String?) -> Int? {
        guard let s = s, let n = Int(s), n >= 1024, n <= 65535 else { return nil }
        return n
    }

    /// The one-time launch code: 16-128 hex characters.
    public static func validCode(_ s: String?) -> String? {
        guard let s = s, s.count >= 16, s.count <= 128,
              s.allSatisfy({ $0.isASCII && $0.isHexDigit }) else { return nil }
        return s
    }
}

/// How a window request reaches the app:
///   sotto://open?port=<n>&k=<launch code>&data=<data dir>
///   sotto://close?port=<n>
///   sotto://show
public enum UrlCommand: Equatable, Sendable {
    case open(LaunchRequest)
    case close(port: Int?)
    case show
}

public func parseUrlCommand(_ url: URL) -> UrlCommand? {
    guard url.scheme?.lowercased() == "sotto" else { return nil }
    let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
    var q: [String: String] = [:]
    for item in comps?.queryItems ?? [] { q[item.name] = item.value ?? "" }
    switch (url.host ?? "").lowercased() {
    case "open":
        guard let port = LaunchRequest.validPort(q["port"]) else { return nil }
        let data = q["data"].flatMap { $0.hasPrefix("/") ? $0 : nil }
        return .open(LaunchRequest(port: port, code: LaunchRequest.validCode(q["k"]), dataDir: data))
    case "close":
        return .close(port: LaunchRequest.validPort(q["port"]))
    case "show":
        return .show
    default:
        return nil
    }
}

/// Files in the data dir the app trusts: a regular file (not a symlink) owned
/// by this user, in a directory owned by this user.
public enum DataDirTrust {
    static func owned(_ path: String, _ type: FileAttributeType) -> Bool {
        // attributesOfItem does not follow a symlink in the last component.
        guard let a = try? FileManager.default.attributesOfItem(atPath: path) else { return false }
        return (a[.type] as? FileAttributeType) == type && (a[.ownerAccountID] as? NSNumber)?.uint32Value == getuid()
    }

    /// Contents of `<dir>/<name>` when both pass the ownership rule, else nil.
    public static func readOwnedFile(dataDir: String?, name: String) -> String? {
        guard let dir = dataDir, dir.hasPrefix("/") else { return nil }
        let file = (dir as NSString).appendingPathComponent(name)
        guard owned(dir, .typeDirectory), owned(file, .typeRegular),
              let text = try? String(contentsOfFile: file, encoding: .utf8) else { return nil }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The port this user's daemon records in `<data dir>/daemon.port`.
    public static func recordedPort(dataDir: String?) -> Int? {
        LaunchRequest.validPort(readOwnedFile(dataDir: dataDir, name: "daemon.port"))
    }

    /// `<data dir>/page.secret` (the daemon writes it 0600), only when owned by us.
    public static func pageSecret(dataDir: String?) -> String? {
        guard let s = readOwnedFile(dataDir: dataDir, name: "page.secret"), !s.isEmpty, s.count <= 256,
              s.allSatisfy({ $0.isASCII && !$0.isWhitespace }) else { return nil }
        return s
    }
}

/// Any web page can fire a sotto:// URL, so the port in an `open` request is
/// not trusted as is: accept it only when this user's daemon records that
/// port in <data dir>/daemon.port (see DataDirTrust).
public func daemonRecordsPort(dataDir: String?, port: Int) -> Bool {
    DataDirTrust.recordedPort(dataDir: dataDir) == port
}
