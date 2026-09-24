import XCTest
@testable import SottoUI
@testable import SottoClient

@MainActor
final class StateModelContractTests: XCTestCase {
    func testStatusReplaces() {
        let m = StateModel()
        let s = PageStatus(state: "live")
        m.apply(.status(s))
        XCTAssertEqual(m.status?.state, "live")
    }
}
