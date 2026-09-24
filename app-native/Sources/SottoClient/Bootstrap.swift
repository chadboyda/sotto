// GET /api/bootstrap (docs/NATIVE.md §1 "Token source", §5.2).
import Foundation

public struct BootstrapResult: Equatable, Sendable {
    public var pageToken: String
    public var pageSecret: String?
    public var version: String?
    public var build: String?
    public var status: PageStatus?
}

public enum BootstrapError: Error, Equatable, Sendable {
    /// 403: the launch code or page secret was refused (stale secret: re-read page.secret).
    case refused
    case http(Int)
    case unreachable(String)
    case badResponse

    public var code: String {
        switch self {
        case .refused: return "bad_secret"
        case .http(let s): return "http_\(s)"
        case .unreachable: return "unreachable"
        case .badResponse: return "bad_response"
        }
    }
}

public enum BootCredential: Equatable, Sendable {
    case launchCode(String)
    case pageSecret(String)
}

public enum Bootstrap {
    /// An ephemeral session: no cookies, no cache, no proxies (loopback only).
    static func makeSession() -> URLSession {
        let c = URLSessionConfiguration.ephemeral
        c.connectionProxyDictionary = [:]
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.urlCache = nil
        c.httpCookieStorage = nil
        c.timeoutIntervalForRequest = 5
        return URLSession(configuration: c)
    }

    public static func request(port: Int, credential: BootCredential) -> URLRequest {
        var r = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/bootstrap")!)
        r.httpMethod = "GET"
        r.timeoutInterval = 5
        switch credential {
        case .launchCode(let k): r.setValue(k, forHTTPHeaderField: "X-Sotto-Launch")
        case .pageSecret(let s): r.setValue(s, forHTTPHeaderField: "X-Sotto-Boot")
        }
        // No Origin header: URLSession never adds one.
        return r
    }

    public static func parse(status: Int, body: Data) -> Result<BootstrapResult, BootstrapError> {
        if status == 403 { return .failure(.refused) }
        guard status == 200 else { return .failure(.http(status)) }
        guard let raw = try? JSONDecoder().decode([String: JSONValue].self, from: body),
              let token = raw["page_token"]?.stringValue, !token.isEmpty else { return .failure(.badResponse) }
        return .success(BootstrapResult(pageToken: token, pageSecret: raw["page_secret"]?.stringValue,
                                        version: raw["version"]?.stringValue, build: raw["build"]?.stringValue,
                                        status: raw["status"]?.decode(PageStatus.self)))
    }

    public static func fetch(port: Int, credential: BootCredential, session: URLSession? = nil,
                             completion: @escaping @Sendable (Result<BootstrapResult, BootstrapError>) -> Void) {
        let s = session ?? makeSession()
        let task = s.dataTask(with: request(port: port, credential: credential)) { data, resp, err in
            if let err { completion(.failure(.unreachable((err as NSError).localizedDescription))); return }
            guard let http = resp as? HTTPURLResponse else { completion(.failure(.badResponse)); return }
            completion(parse(status: http.statusCode, body: data ?? Data()))
        }
        task.resume()
        if session == nil { s.finishTasksAndInvalidate() }
    }
}
