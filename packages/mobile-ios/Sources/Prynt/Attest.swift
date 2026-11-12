import Foundation
import CryptoKit
#if canImport(DeviceCheck)
import DeviceCheck
#endif

/// Apple App Attest — hardware-backed proof that a genuine, unmodified build of your app is
/// running on genuine Apple hardware. The SDK generates a key and an attestation over a
/// challenge; your server verifies it against Apple (needs your App ID + team). Returns nil when
/// App Attest is unsupported or the capability isn't configured — never fails identify().
enum Attest {
    static func token(challenge: String) async -> [String: Any]? {
        #if canImport(DeviceCheck)
        guard #available(iOS 14.0, *) else { return nil }
        let service = DCAppAttestService.shared
        guard service.isSupported else { return nil }
        do {
            let keyId = try await service.generateKey()
            let hash = Data(SHA256.hash(data: Data(challenge.utf8)))
            let attestation = try await service.attestKey(keyId, clientDataHash: hash)
            return [
                "platform": "ios",
                "type": "appAttest",
                "keyId": keyId,
                "token": attestation.base64EncodedString(),
            ]
        } catch {
            return nil
        }
        #else
        return nil
        #endif
    }
}
