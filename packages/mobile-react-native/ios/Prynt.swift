import Foundation
import Prynt   // the native iOS SDK

/// RN bridge → native iOS SDK (Prynt). Add the native SDK as a dependency of this module's podspec.
@objc(Prynt)
class PryntBridge: NSObject {
    @objc(identify:endpoint:tag:linkedId:resolver:rejecter:)
    func identify(_ apiKey: String, endpoint: String, tag: [String: Any]?, linkedId: String?,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                let prynt = try Prynt(apiKey: apiKey, endpoint: endpoint)
                let r = try await prynt.identify(tag: tag, linkedId: linkedId)
                resolve([
                    "requestId": r.requestId, "visitorId": r.visitorId, "visitorFound": r.visitorFound,
                    "confidence": ["score": r.confidence.score, "level": r.confidence.level],
                ])
            } catch {
                reject("identify_failed", "\(error)", error)
            }
        }
    }

    // Prynt Replay (native iOS recorder): screenshots with inputs masked on the device, taps as clicks.
    @objc(replayStart:website:endpoint:maskAllText:consent:)
    func replayStart(_ publicKey: String, website: String, endpoint: String, maskAllText: Bool, consent: Bool) {
        PryntReplay.shared.start(.init(publicKey: publicKey, website: website, endpoint: endpoint,
                                       maskAllText: maskAllText, consent: consent))
    }
    @objc(replayIdentify:) func replayIdentify(_ userId: String) { PryntReplay.shared.identify(userId) }
    @objc(replaySetConsent:) func replaySetConsent(_ given: Bool) { PryntReplay.shared.setConsent(given) }
    @objc func replayStop() { PryntReplay.shared.stop() }
}
