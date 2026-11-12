import Foundation
import Security

/// Keychain-backed stable device id. Unlike UserDefaults or IDFV, a Keychain item persists
/// across app reinstalls (until the device is wiped), giving the server a strong identity anchor.
enum Persist {
    private static let service = "dev.prynt.deviceid"
    private static let account = "vid"

    static func deviceId() -> String {
        if let existing = read() { return existing }
        let fresh = "pd_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        write(fresh)
        return fresh
    }

    private static func read() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data, let s = String(data: data, encoding: .utf8) else { return nil }
        return s
    }

    private static func write(_ value: String) {
        let delete: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(delete as CFDictionary)
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: Data(value.utf8),
            // Survives reinstall; available after first unlock; never leaves the device.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        SecItemAdd(add as CFDictionary, nil)
    }
}
