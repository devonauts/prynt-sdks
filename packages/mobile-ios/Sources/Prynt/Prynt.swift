import Foundation
import UIKit

/// Prynt iOS SDK — stable device identity + integrity signals, verified server-side.
///
/// ```swift
/// let prynt = try Prynt(apiKey: "pk_live_…", endpoint: "https://api.pryntid.com")
/// let result = try await prynt.identify()
/// print(result.visitorId, result.confidence.level)
/// ```
public struct PryntConfig {
    public var apiKey: String
    public var endpoint: String
    public var timeout: TimeInterval
    public var extendedResult: Bool
    public init(apiKey: String, endpoint: String = "https://api.pryntid.com",
                timeout: TimeInterval = 6, extendedResult: Bool = true) {
        self.apiKey = apiKey; self.endpoint = endpoint; self.timeout = timeout
        self.extendedResult = extendedResult
    }
}

public struct Confidence: Decodable { public let score: Double; public let level: String }

public struct IdentifyResult: Decodable {
    public let requestId: String
    public let visitorId: String
    public let visitorFound: Bool
    public let confidence: Confidence
    public let smartSignals: [String: JSONValue]?
}

public enum PryntError: Error { case invalidKey, badResponse(Int, String), network(Error) }

public final class Prynt {
    private let config: PryntConfig

    public init(apiKey: String, endpoint: String = "https://api.pryntid.com") throws {
        guard apiKey.hasPrefix("pk_") else { throw PryntError.invalidKey }
        self.config = PryntConfig(apiKey: apiKey, endpoint: endpoint)
    }

    public init(config: PryntConfig) throws {
        guard config.apiKey.hasPrefix("pk_") else { throw PryntError.invalidKey }
        self.config = config
    }

    /// Identify this device. Collects device + integrity signals, includes a Keychain-persisted
    /// id (survives reinstall) and an App Attest token when available, and resolves server-side.
    public func identify(tag: [String: Any]? = nil, linkedId: String? = nil) async throws -> IdentifyResult {
        let deviceId = Persist.deviceId()                    // stable across reinstall (Keychain)
        var signals = DeviceSignals.collect()
        signals["platform"] = "ios"
        signals["jailbreakTells"] = Integrity.jailbreakTells()
        signals["fridaTells"] = Integrity.fridaTells()
        signals["integrityTells"] = Integrity.integrityTells()
        let attestation = await Attest.token(challenge: deviceId)
        if let attestation { signals["attestation"] = attestation }

        let fingerprint = DeviceSignals.fingerprint(signals)
        var body: [String: Any] = [
            "publicKey": config.apiKey,
            "sdkVersion": Prynt.version,
            "platform": "ios",
            "extendedResult": config.extendedResult,
            "fingerprint": fingerprint,
            "signals": signals,
            "identityHints": ["cookie": deviceId],           // reuse the server's storage reconciliation
        ]
        if let tag { body["tag"] = tag }
        if let linkedId { body["linkedId"] = linkedId }

        return try await post(body)
    }

    public static let version = "1.0.0"

    private func post(_ body: [String: Any]) async throws -> IdentifyResult {
        let url = URL(string: config.endpoint.trimmingSlash() + "/v1/identify")!
        var req = URLRequest(url: url, timeoutInterval: config.timeout)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else {
                throw PryntError.badResponse(status, String(data: data, encoding: .utf8) ?? "")
            }
            return try JSONDecoder().decode(IdentifyResult.self, from: data)
        } catch let e as PryntError { throw e }
        catch { throw PryntError.network(error) }
    }
}

extension String {
    func trimmingSlash() -> String {
        var s = self; while s.hasSuffix("/") { s.removeLast() }; return s
    }
}

/// Minimal JSON value so smartSignals decode without a schema.
public enum JSONValue: Decodable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null
    public init(from d: Decoder) throws {
        let c = try d.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .null }
    }
}
