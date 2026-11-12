import Foundation
import UIKit
import MachO

/// iOS integrity tells — raw evidence only; the SERVER decides jailbroken/tampered. Nothing here
/// returns a "isJailbroken" boolean the app could flip; we ship the observations.
enum Integrity {
    private static let suspiciousPaths = [
        "/Applications/Cydia.app", "/Applications/Sileo.app", "/Library/MobileSubstrate/MobileSubstrate.dylib",
        "/bin/bash", "/usr/sbin/sshd", "/etc/apt", "/private/var/lib/apt/", "/usr/bin/ssh",
        "/var/jb", "/Library/MobileSubstrate/DynamicLibraries", "/usr/libexec/cydia",
    ]

    static func jailbreakTells() -> [String: Any] {
        var found: [String] = []
        for p in suspiciousPaths where FileManager.default.fileExists(atPath: p) { found.append(p) }

        // Can we open a package-manager URL scheme?
        let cydia = URL(string: "cydia://package/com.example").map { UIApplication.shared.canOpenURL($0) } ?? false

        // Sandbox escape: a non-jailbroken app cannot write outside its container.
        var sandboxEscape = false
        let probe = "/private/prynt_jb_\(UUID().uuidString).txt"
        if (try? "x".write(toFile: probe, atomically: true, encoding: .utf8)) != nil {
            sandboxEscape = true; try? FileManager.default.removeItem(atPath: probe)
        }

        // fork() must fail (return -1) inside the app sandbox.
        // fork() is unavailable to Swift in current iOS SDKs: resolve it at run time (same check, same meaning).
        typealias ForkFn = @convention(c) () -> pid_t
        var pid: pid_t = -1
        if let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "fork") {   // RTLD_DEFAULT
            pid = unsafeBitCast(sym, to: ForkFn.self)()
        }
        var forkSucceeded = false
        if pid >= 0 { forkSucceeded = true; if pid > 0 { /* parent */ } }

        // Loaded dynamic libraries — MobileSubstrate / Frida / Cydia betray injection.
        var suspiciousDylibs: [String] = []
        for i in 0..<_dyld_image_count() {
            if let name = _dyld_get_image_name(i) {
                let s = String(cString: name)
                if s.contains("MobileSubstrate") || s.contains("SubstrateLoader") ||
                    s.contains("cynject") || s.lowercased().contains("frida") || s.contains("libhooker") {
                    suspiciousDylibs.append(s)
                }
            }
        }

        return [
            "suspiciousFiles": found,
            "cydiaScheme": cydia,
            "sandboxEscape": sandboxEscape,
            "forkSucceeded": forkSucceeded,
            "suspiciousDylibs": suspiciousDylibs,
        ]
    }

    static func fridaTells() -> [String: Any] {
        // Frida's default control port.
        let port27042 = canConnectLocalhost(port: 27042)
        // A debugger/instrumentation being attached sets P_TRACED.
        let traced = isBeingTraced()
        var fridaLibs: [String] = []
        for i in 0..<_dyld_image_count() {
            if let name = _dyld_get_image_name(i) {
                let s = String(cString: name).lowercased()
                if s.contains("frida") || s.contains("gadget") || s.contains("gum") { fridaLibs.append(String(cString: name)) }
            }
        }
        return ["port27042": port27042, "traced": traced, "fridaLibs": fridaLibs]
    }

    static func integrityTells() -> [String: Any] {
        let bundle = Bundle.main
        // App Store apps carry a receipt; its absence suggests side-loading.
        let hasReceipt = bundle.appStoreReceiptURL.map { FileManager.default.fileExists(atPath: $0.path) } ?? false
        var debuggable = false
        #if DEBUG
        debuggable = true
        #endif
        return [
            "installer": hasReceipt ? "AppStore" : "sideload",
            "packageName": bundle.bundleIdentifier ?? "",
            "debuggable": debuggable,
        ]
    }

    // MARK: - helpers
    private static func isBeingTraced() -> Bool {
        var info = kinfo_proc()
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        var size = MemoryLayout<kinfo_proc>.stride
        let rc = sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0)
        return rc == 0 && (info.kp_proc.p_flag & P_TRACED) != 0
    }

    private static func canConnectLocalhost(port: UInt16) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        if fd < 0 { return false }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let rc = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return rc == 0
    }
}
