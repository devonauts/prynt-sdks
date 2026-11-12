import Foundation
import UIKit
import CryptoKit

/// Stable device attributes + an on-device fingerprint hash. Raw hardware/OS/locale that the
/// server fuses with the persisted id for identity.
enum DeviceSignals {
    static func collect() -> [String: Any] {
        let screen = UIScreen.main
        let pi = ProcessInfo.processInfo
        return [
            "deviceModel": hardwareModel(),
            "deviceName": UIDevice.current.systemName,
            "osVersion": UIDevice.current.systemVersion,
            "systemName": UIDevice.current.systemName,
            "screen": [
                "w": Int(screen.nativeBounds.width),
                "h": Int(screen.nativeBounds.height),
                "scale": screen.nativeScale,
            ],
            "timezone": TimeZone.current.identifier,
            "languages": ["primary": Locale.preferredLanguages.first ?? "en"],
            "locale": Locale.current.identifier,
            "hardwareConcurrency": pi.processorCount,
            "deviceMemory": Int(pi.physicalMemory / 1_073_741_824),   // GiB
            "vendor": "Apple",
            "lowPowerMode": pi.isLowPowerModeEnabled,
        ]
    }

    /// The raw hardware identifier (e.g. "iPhone15,2"), more stable than the marketing name.
    static func hardwareModel() -> String {
        var sysinfo = utsname()
        uname(&sysinfo)
        let mirror = Mirror(reflecting: sysinfo.machine)
        let id = mirror.children.reduce(into: "") { acc, el in
            if let v = el.value as? Int8, v != 0 { acc.append(Character(UnicodeScalar(UInt8(v)))) }
        }
        return id.isEmpty ? "iPhone" : id
    }

    /// SHA-256 over the stable device attributes (locale/tz excluded — they change) → hex.
    static func fingerprint(_ signals: [String: Any]) -> String {
        let scr = signals["screen"] as? [String: Any] ?? [:]
        let parts = [
            signals["deviceModel"] as? String ?? "",
            signals["osVersion"] as? String ?? "",
            "\(scr["w"] ?? "")x\(scr["h"] ?? "")",
            String(signals["hardwareConcurrency"] as? Int ?? 0),
            String(signals["deviceMemory"] as? Int ?? 0),
        ].filter { !$0.isEmpty }
        let digest = SHA256.hash(data: Data(parts.joined(separator: "###").utf8))
        return digest.map { String(format: "%02x", $0) }.joined().prefix(32).description
    }
}
