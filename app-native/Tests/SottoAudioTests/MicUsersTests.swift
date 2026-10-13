import XCTest
@testable import SottoAudio

final class MicUsersTests: XCTestCase {
    /// A plain property query (no prompt): on macOS 14 it answers, and never lists this process.
    func testOthersAnswersAndExcludesThisProcess() {
        guard let apps = MicUsers.others() else { return XCTFail("process objects are available on macOS 14") }
        XCTAssertFalse(apps.contains("pid \(getpid())"))
        XCTAssertFalse(apps.contains(Bundle.main.bundleIdentifier ?? "-"))
    }
}
