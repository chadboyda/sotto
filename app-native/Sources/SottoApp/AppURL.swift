// sotto:// URL commands (SPEC §6.16, docs/NATIVE.md §5.1). The parsing and
// the daemon ownership check live in SottoClient (Launch.swift:
// parseUrlCommand, daemonRecordsPort); this is the app's thin use of them
// plus the `--selftest url` probe.
import Foundation
import SottoClient

enum AppURL {
    static func validPort(_ s: String?) -> Int? { LaunchRequest.validPort(s) }
    static func validCode(_ s: String?) -> String? { LaunchRequest.validCode(s) }

    /// `--selftest url '{"url":"sotto://…"}'` → the parsed command (never the code itself).
    static func evaluate(json: String) -> String {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
              let s = obj["url"] as? String, let url = URL(string: s) else { return jsonString(["cmd": NSNull()]) }
        switch parseUrlCommand(url) {
        case .open(let r)?:
            var out: [String: Any] = ["cmd": "open", "port": r.port, "has_code": r.code != nil, "data": orNull(r.dataDir)]
            out["owned"] = daemonRecordsPort(dataDir: r.dataDir, port: r.port)
            return jsonString(out)
        case .close(let p)?: return jsonString(["cmd": "close", "port": orNull(p)])
        case .show?: return jsonString(["cmd": "show"])
        case nil: return jsonString(["cmd": NSNull()])
        }
    }
}
