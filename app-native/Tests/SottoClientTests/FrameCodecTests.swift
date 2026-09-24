import XCTest
@testable import SottoClient

final class FrameCodecTests: XCTestCase {
    // Golden vector shared with test/daemon/native-proto.test.js.
    let golden = "0103000007000000efcdab896745230101007fff"

    func testEncodeMatchesGolden() {
        let f = WireFrame(kind: .mic, flags: [.muted, .fake], seq: 7, timestampNs: 0x0123456789abcdef, pcm: Data([0x01, 0x00, 0x7f, 0xff]))
        XCTAssertEqual(f.encode().map { String(format: "%02x", $0) }.joined(), golden)
    }

    func testDecodeRoundTrip() {
        let bytes = stride(from: 0, to: golden.count, by: 2).map { i -> UInt8 in
            let s = golden.index(golden.startIndex, offsetBy: i)
            return UInt8(golden[s..<golden.index(s, offsetBy: 2)], radix: 16)!
        }
        let f = WireFrame.decode(Data(bytes))
        XCTAssertEqual(f?.kind, .mic)
        XCTAssertEqual(f?.seq, 7)
        XCTAssertEqual(f?.timestampNs, 0x0123456789abcdef)
        XCTAssertEqual(f?.pcm, Data([0x01, 0x00, 0x7f, 0xff]))
        XCTAssertNil(WireFrame.decode(Data(count: 15)))
        XCTAssertNil(WireFrame.decode(Data(count: 17)))
    }
}
