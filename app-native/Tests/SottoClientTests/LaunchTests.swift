import XCTest
@testable import SottoClient

final class LaunchTests: XCTestCase {
    let code = "0123456789abcdef0123456789abcdef"

    func testParseUrlCommand() {
        XCTAssertEqual(parseUrlCommand(URL(string: "sotto://open?port=47821&k=\(code)&data=/tmp/d")!),
                       .open(LaunchRequest(port: 47821, code: code, dataDir: "/tmp/d")))
        // Percent-encoded data dir (spaces) decodes.
        XCTAssertEqual(parseUrlCommand(URL(string: "sotto://open?port=47821&data=/Users/x/Library/Application%20Support/s")!),
                       .open(LaunchRequest(port: 47821, code: nil, dataDir: "/Users/x/Library/Application Support/s")))
        XCTAssertEqual(parseUrlCommand(URL(string: "SOTTO://OPEN?port=2000")!), .open(LaunchRequest(port: 2000, code: nil, dataDir: nil)))
        XCTAssertEqual(parseUrlCommand(URL(string: "sotto://close?port=47821")!), .close(port: 47821))
        XCTAssertEqual(parseUrlCommand(URL(string: "sotto://close")!), .close(port: nil))
        XCTAssertEqual(parseUrlCommand(URL(string: "sotto://show")!), .show)
        // Rejected: bad port, bad scheme, unknown verb.
        XCTAssertNil(parseUrlCommand(URL(string: "sotto://open?port=80")!))
        XCTAssertNil(parseUrlCommand(URL(string: "sotto://open?port=70000")!))
        XCTAssertNil(parseUrlCommand(URL(string: "sotto://open?port=abc")!))
        XCTAssertNil(parseUrlCommand(URL(string: "http://open?port=47821")!))
        XCTAssertNil(parseUrlCommand(URL(string: "sotto://evil?port=47821")!))
        // Bad code / relative data dir are dropped, not fatal.
        XCTAssertEqual(parseUrlCommand(URL(string: "sotto://open?port=47821&k=zz&data=relative")!),
                       .open(LaunchRequest(port: 47821, code: nil, dataDir: nil)))
        XCTAssertNil(LaunchRequest.validCode("abc"))
        XCTAssertNil(LaunchRequest.validCode(String(repeating: "a", count: 129)))
        XCTAssertNil(LaunchRequest.validCode("0123456789abcdefg"))
    }

    func tempDir() throws -> String {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("sotto-launch-\(UUID().uuidString)").path
        try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(atPath: d) }
        return d
    }

    func testOwnershipChecks() throws {
        let d = try tempDir()
        XCTAssertFalse(daemonRecordsPort(dataDir: d, port: 47821))  // no file
        try "47821\n".write(toFile: d + "/daemon.port", atomically: true, encoding: .utf8)
        XCTAssertTrue(daemonRecordsPort(dataDir: d, port: 47821))
        XCTAssertFalse(daemonRecordsPort(dataDir: d, port: 47822))
        XCTAssertFalse(daemonRecordsPort(dataDir: nil, port: 47821))
        XCTAssertFalse(daemonRecordsPort(dataDir: "relative/dir", port: 47821))
        XCTAssertEqual(DataDirTrust.recordedPort(dataDir: d), 47821)

        // A symlinked daemon.port is refused (someone could point it anywhere).
        let d2 = try tempDir()
        try FileManager.default.createSymbolicLink(atPath: d2 + "/daemon.port", withDestinationPath: d + "/daemon.port")
        XCTAssertFalse(daemonRecordsPort(dataDir: d2, port: 47821))
        // A symlinked data dir is refused too.
        let d3 = try tempDir() + "-link"
        try FileManager.default.createSymbolicLink(atPath: d3, withDestinationPath: d)
        addTeardownBlock { try? FileManager.default.removeItem(atPath: d3) }
        XCTAssertFalse(daemonRecordsPort(dataDir: d3, port: 47821))
        // A directory named daemon.port is refused.
        let d4 = try tempDir()
        try FileManager.default.createDirectory(atPath: d4 + "/daemon.port", withIntermediateDirectories: false)
        XCTAssertFalse(daemonRecordsPort(dataDir: d4, port: 47821))
    }

    func testPageSecret() throws {
        let d = try tempDir()
        XCTAssertNil(DataDirTrust.pageSecret(dataDir: d))
        try "abcdef0123\n".write(toFile: d + "/page.secret", atomically: true, encoding: .utf8)
        XCTAssertEqual(DataDirTrust.pageSecret(dataDir: d), "abcdef0123")
        try "has space\n".write(toFile: d + "/page.secret", atomically: true, encoding: .utf8)
        XCTAssertNil(DataDirTrust.pageSecret(dataDir: d))
        let d2 = try tempDir()
        try "abcdef0123".write(toFile: d + "/page.secret", atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(atPath: d2 + "/page.secret", withDestinationPath: d + "/page.secret")
        XCTAssertNil(DataDirTrust.pageSecret(dataDir: d2))
    }

    func testBootstrapRequestAndParse() {
        let r = Bootstrap.request(port: 47821, credential: .launchCode(code))
        XCTAssertEqual(r.url?.absoluteString, "http://127.0.0.1:47821/api/bootstrap")
        XCTAssertEqual(r.value(forHTTPHeaderField: "X-Sotto-Launch"), code)
        XCTAssertNil(r.value(forHTTPHeaderField: "X-Sotto-Boot"))
        XCTAssertNil(r.value(forHTTPHeaderField: "Origin"))
        XCTAssertEqual(Bootstrap.request(port: 2000, credential: .pageSecret("s")).value(forHTTPHeaderField: "X-Sotto-Boot"), "s")
        XCTAssertEqual(Bootstrap.parse(status: 403, body: Data()), .failure(.refused))
        XCTAssertEqual(Bootstrap.parse(status: 500, body: Data()), .failure(.http(500)))
        XCTAssertEqual(Bootstrap.parse(status: 200, body: Data("{}".utf8)), .failure(.badResponse))
        let ok = Bootstrap.parse(status: 200, body: Data(#"{"page_token":"t","page_secret":"s","version":"0.3.0","build":"b","status":{"state":"off"}}"#.utf8))
        XCTAssertEqual(ok, .success(BootstrapResult(pageToken: "t", pageSecret: "s", version: "0.3.0", build: "b", status: PageStatus(state: "off"))))
    }
}

final class BackoffTests: XCTestCase {
    func testStandardSchedule() {
        let s = ReconnectPolicy.standard.schedule()
        XCTAssertEqual(Array(s.prefix(6)), [0.05, 0.25, 0.5, 1, 2, 2])
        XCTAssertTrue(s.dropFirst(4).allSatisfy { $0 == 2 })
        XCTAssertLessThanOrEqual(s.reduce(0, +), 60)
        XCTAssertGreaterThan(s.reduce(0, +), 58)
        XCTAssertEqual(ReconnectPolicy.standard.delay(attempt: 0, elapsed: 0), 0.05)
        XCTAssertEqual(ReconnectPolicy.standard.delay(attempt: 40, elapsed: 10), 2)
        XCTAssertNil(ReconnectPolicy.standard.delay(attempt: 40, elapsed: 59))
    }

    func testNoRetryCodes() {
        XCTAssertFalse(ReconnectPolicy.retries(afterClose: 4001))
        XCTAssertFalse(ReconnectPolicy.retries(afterClose: 4002))
        for c in [1000, 1001, 1006, 4003, 4004, 4005] { XCTAssertTrue(ReconnectPolicy.retries(afterClose: c)) }
    }
}

final class CaptureTableTests: XCTestCase {
    func testCaptureForState() {
        let table: [(String?, Bool, AudioPump.Capture)] = [
            ("connecting", true, .full), ("live", true, .full), ("reconnecting", true, .full),
            ("sleeping", true, .listen),
            ("paused", true, .off), ("off", true, .off), ("closing", true, .off), ("waiting_page", true, .off),
            ("live", false, .off), (nil, true, .off), ("something_new", true, .off),
        ]
        for (state, up, want) in table {
            XCTAssertEqual(AudioPump.capture(for: state, linkUp: up), want, "\(String(describing: state)) up=\(up)")
        }
        XCTAssertEqual(AudioPump.uplinkStates, ["connecting", "live", "reconnecting", "sleeping"])
    }
}
