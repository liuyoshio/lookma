// One camera frame's hand, as the overlay page's MediaPipe hand landmarker sends it
// (docs/protocol.md, "hand"). HandCamera checks it once at the boundary; the gesture engine trusts it.
import CoreGraphics

/// MediaPipe's 21 hand landmarks, in its order.
enum HandJoint: Int, CaseIterable {
    case wrist
    case thumbCMC, thumbMCP, thumbIP, thumbTip
    case indexMCP, indexPIP, indexDIP, indexTip
    case middleMCP, middlePIP, middleDIP, middleTip
    case ringMCP, ringPIP, ringDIP, ringTip
    case littleMCP, littlePIP, littleDIP, littleTip
}

/// A hand's joints in the mirrored camera frame: x to the user's right, y down, both in frame
/// heights (x runs 0...aspect), so distances match in both axes. A joint of a hand partly out of
/// view can lie a little outside the frame; MediaPipe estimates it.
struct Hand {
    let points: [CGPoint] // 21, in HandJoint order
    subscript(_ j: HandJoint) -> CGPoint { points[j.rawValue] }
}

/// One processed camera frame. Every one comes, with a hand or without, so the engine's clock runs.
struct HandFrame {
    let t: Double      // seconds, strictly increasing
    let aspect: Double // the frame's width over its height
    let hand: Hand?
}
