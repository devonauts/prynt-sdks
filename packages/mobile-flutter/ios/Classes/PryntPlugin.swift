import Flutter
import Prynt   // the native iOS SDK

/// Flutter bridge → the native iOS SDK (Prynt). Add the native SDK as a dependency of this
/// plugin's podspec.
public class PryntPlugin: NSObject, FlutterPlugin {
    public static func register(with registrar: FlutterPluginRegistrar) {
        let channel = FlutterMethodChannel(name: "dev.prynt/sdk", binaryMessenger: registrar.messenger())
        registrar.addMethodCallDelegate(PryntPlugin(), channel: channel)
    }

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        if call.method.hasPrefix("replay") { handleReplay(call, result: result); return }
        guard call.method == "identify",
              let args = call.arguments as? [String: Any],
              let apiKey = args["apiKey"] as? String else {
            result(FlutterMethodNotImplemented); return
        }
        let endpoint = args["endpoint"] as? String ?? "https://api.pryntid.com"
        Task {
            do {
                let prynt = try Prynt(apiKey: apiKey, endpoint: endpoint)
                let r = try await prynt.identify(tag: args["tag"] as? [String: Any],
                                                 linkedId: args["linkedId"] as? String)
                result([
                    "requestId": r.requestId, "visitorId": r.visitorId, "visitorFound": r.visitorFound,
                    "confidence": ["score": r.confidence.score, "level": r.confidence.level],
                ])
            } catch {
                result(FlutterError(code: "identify_failed", message: "\(error)", details: nil))
            }
        }
    }

    /// Prynt Replay (native recorder) + the regions Dart reports (Flutter text fields, PryntMask), in logical points.
    private func handleReplay(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        let a = call.arguments as? [String: Any] ?? [:]
        switch call.method {
        case "replayStart":
            PryntReplay.shared.start(.init(publicKey: a["publicKey"] as? String ?? "", website: a["website"] as? String ?? "",
                                           endpoint: a["endpoint"] as? String ?? "https://api.pryntid.com",
                                           maskAllText: a["maskAllText"] as? Bool ?? false, consent: a["consent"] as? Bool ?? true))
        case "replayIdentify": PryntReplay.shared.identify(a["userId"] as? String ?? "")
        case "replaySetConsent": PryntReplay.shared.setConsent(a["given"] as? Bool ?? false)
        case "replayStop": PryntReplay.shared.stop()
        case "replayMasks":
            let rects = (a["rects"] as? [[Double]] ?? []).compactMap { r in
                r.count == 4 ? CGRect(x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1]) : nil }
            DispatchQueue.main.async { PryntReplay.shared.extraMasks = rects }
        default: result(FlutterMethodNotImplemented); return
        }
        result(nil)
    }
}
