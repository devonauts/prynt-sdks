import Foundation
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// Prynt Replay for iOS — session replay of a native app, shown in the same Replay console as the web.
///
/// The app is captured as low-rate screenshots (1 frame / s by default, only when the screen changed), with every
/// text input, secure field and view marked `prynt-mask` painted over **before** the frame leaves the device; taps
/// become clicks, so rage clicks, frustration, Py's summaries and issues work as on the web. Frames travel as rrweb
/// events (an `<img>` whose `src` changes), so the console player needs nothing special.
///
/// ```swift
/// PryntReplay.shared.start(.init(publicKey: "pk_live_…", website: "acme.com"))
/// PryntReplay.shared.identify("user_42")      // your own user id, never an email
/// ```
/// Mask anything else: `view.accessibilityIdentifier = "prynt-mask"` (or `maskAllText: true`).
public final class PryntReplay {
    public static let shared = PryntReplay()

    public struct Options {
        public var publicKey: String
        public var website: String            // the site this app belongs to in the console (e.g. "acme.com")
        public var endpoint: String
        public var framesPerSecond: Double
        public var scale: CGFloat             // frame size relative to the screen in points (0.5 = half)
        public var jpegQuality: CGFloat
        public var maskAllText: Bool          // paint over every label too
        public var consent: Bool              // pass false until your consent flow allows recording
        public var visitorId: String?         // Prynt Identify visitorId, when you use it
        public init(publicKey: String, website: String, endpoint: String = "https://api.pryntid.com",
                    framesPerSecond: Double = 1, scale: CGFloat = 0.5, jpegQuality: CGFloat = 0.45,
                    maskAllText: Bool = false, consent: Bool = true, visitorId: String? = nil) {
            self.publicKey = publicKey; self.website = website; self.endpoint = endpoint
            self.framesPerSecond = framesPerSecond; self.scale = scale; self.jpegQuality = jpegQuality
            self.maskAllText = maskAllText; self.consent = consent; self.visitorId = visitorId
        }
    }

    public private(set) var state = "off"     // off | starting | recording | stopped:<reason>
    /// Extra regions to paint over, in window points (Flutter / React Native text fields the view tree cannot see).
    public var extraMasks: [CGRect] = []
    private var opts: Options?
    private var timer: Timer?
    private var events: [[String: Any]] = []
    private var bytes = 0
    private var seq = 0
    private var sessionId = ""
    private var lastFrame: Int?
    private var lastScreen = ""
    private var lastSize = CGSize.zero
    private var needFull = true
    private var lastFlush = Date()
    private var maskAll = false
    private var touchRecognizer: TouchObserver?
    private let queue = DispatchQueue(label: "dev.prynt.replay.upload")
    private let defaults = UserDefaults.standard
    private static let imgId = 5

    private init() {}

    // MARK: public API

    public func start(_ options: Options) {
        DispatchQueue.main.async { self.startOnMain(options) }
    }

    public func stop() {
        DispatchQueue.main.async { self.halt("stopped", final: true) }
    }

    /// Your own user id for this session (filters, helpdesk lookup, Intercom / Zendesk). Never an email.
    public func identify(_ userId: String) {
        let uid = userId.trimmingCharacters(in: .whitespaces)
        guard !uid.isEmpty, !uid.contains("@") else { return }
        DispatchQueue.main.async { self.custom("prynt.identify", ["userId": String(uid.prefix(190))]) }
    }

    public func setConsent(_ given: Bool) {
        DispatchQueue.main.async {
            guard var o = self.opts else { return }
            o.consent = given; self.opts = o
            if !given { self.halt("consent", final: true) } else if self.state != "recording" { self.startOnMain(o) }
        }
    }

    // MARK: lifecycle

    private func startOnMain(_ o: Options) {
        guard o.publicKey.hasPrefix("pk_"), state != "recording", state != "starting" else { return }
        opts = o
        guard o.consent else { state = "stopped:consent"; return }
        state = "starting"
        sessionId = currentSession()
        seq = defaults.integer(forKey: "prynt.replay.seq.\(sessionId)")
        let q = "publicKey=\(enc(o.publicKey))&website=\(enc(o.website))&sessionId=\(enc(sessionId))"
        guard let url = URL(string: o.endpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/v1/replay/config?" + q) else { return }
        var req = URLRequest(url: url)
        req.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let cfg = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
            DispatchQueue.main.async {
                guard code == 200, cfg["record"] as? Bool == true else { self.state = "stopped:" + ((cfg["reason"] as? String) ?? "config_\(code)"); return }
                self.maskAll = o.maskAllText || (cfg["maskAllText"] as? Bool ?? false)
                self.begin()
            }
        }.resume()
    }

    private func begin() {
        guard let o = opts else { return }
        state = "recording"; needFull = true; lastFrame = nil; lastScreen = ""
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(onBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(onForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(onTerminate), name: UIApplication.willTerminateNotification, object: nil)
        installTouches()
        PryntReplay.installCrashHandler()
        timer = Timer.scheduledTimer(withTimeInterval: 1 / max(0.2, min(o.framesPerSecond, 4)), repeats: true) { [weak self] _ in self?.tick() }
        tick()
    }

    private func halt(_ reason: String, final: Bool) {
        timer?.invalidate(); timer = nil
        if let t = touchRecognizer { t.view?.removeGestureRecognizer(t) }
        touchRecognizer = nil
        if state == "recording" { flush(final: final) }
        state = "stopped:" + reason
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func onBackground() { flush(final: false); timer?.invalidate(); timer = nil; defaults.set(Date(), forKey: "prynt.replay.lastActive") }
    @objc private func onForeground() {
        guard state == "recording", let o = opts else { return }
        if currentSession() != sessionId { halt("new_session", final: true); startOnMain(o); return }
        needFull = true
        timer = Timer.scheduledTimer(withTimeInterval: 1 / max(0.2, min(o.framesPerSecond, 4)), repeats: true) { [weak self] _ in self?.tick() }
    }
    @objc private func onTerminate() { flush(final: true, sync: true) }

    // MARK: capture

    private func tick() {
        guard state == "recording", UIApplication.shared.applicationState == .active, let window = keyWindow() else { return }
        defaults.set(Date(), forKey: "prynt.replay.lastActive")
        let screen = screenName(window)
        let size = window.bounds.size
        if screen != lastScreen || size != lastSize {
            let host = opts.map { $0.website } ?? "app"
            push(["type": 4, "data": ["href": "app://\(host)/\(screen)", "width": Int(size.width), "height": Int(size.height)]])
            if !lastScreen.isEmpty && screen != lastScreen { custom("prynt.nav", ["href": "app://\(host)/\(screen)"]) }
            lastScreen = screen; lastSize = size; needFull = true
        }
        guard let frame = render(window) else { return }
        let h = frame.hashValue
        if !needFull && h == lastFrame { return }
        lastFrame = h
        let src = "data:image/jpeg;base64," + frame
        if needFull {
            push(["type": 2, "data": ["node": snapshot(src: src, size: size), "initialOffset": ["top": 0, "left": 0]]])
            needFull = false
        } else {
            push(["type": 3, "data": ["source": 0, "texts": [], "removes": [], "adds": [],
                                      "attributes": [["id": PryntReplay.imgId, "attributes": ["src": src]]]]])
        }
        if bytes > 700_000 || Date().timeIntervalSince(lastFlush) > 10 { flush(final: false) }
    }

    /// The window drawn at `scale`, with every masked view painted over, as base64 JPEG.
    private func render(_ window: UIWindow) -> String? {
        guard let o = opts else { return nil }
        let bounds = window.bounds
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = o.scale
        let img = UIGraphicsImageRenderer(size: bounds.size, format: fmt).image { ctx in
            window.drawHierarchy(in: bounds, afterScreenUpdates: false)
            UIColor(white: 0.55, alpha: 1).setFill()
            for r in maskRects(in: window) + extraMasks { ctx.fill(r.insetBy(dx: -4, dy: -4)) }
        }
        return img.jpegData(compressionQuality: o.jpegQuality)?.base64EncodedString()
    }

    private func maskRects(in window: UIWindow) -> [CGRect] {
        var out: [CGRect] = []
        func walk(_ v: UIView) {
            if v.isHidden || v.alpha < 0.01 { return }
            if shouldMask(v) { out.append(v.convert(v.bounds, to: window)); return }
            for s in v.subviews { walk(s) }
        }
        walk(window)
        return out
    }

    private func shouldMask(_ v: UIView) -> Bool {
        if (v.accessibilityIdentifier ?? "").contains("prynt-mask") { return true }
        if v is UITextField || v is UITextView { return true }        // inputs: always, like the web SDK
        if let t = v as? UITextInputTraits, t.isSecureTextEntry == true { return true }
        if maskAll && (v is UILabel || v is UIImageView) { return true }
        return false
    }

    private func snapshot(src: String, size: CGSize) -> [String: Any] {
        let img: [String: Any] = ["type": 2, "tagName": "img", "id": PryntReplay.imgId, "childNodes": [],
                                  "attributes": ["src": src, "style": "display:block;width:100%;height:100%;object-fit:fill"]]
        let body: [String: Any] = ["type": 2, "tagName": "body", "id": 4, "childNodes": [img],
                                   "attributes": ["style": "margin:0;background:#000;width:\(Int(size.width))px;height:\(Int(size.height))px;overflow:hidden"]]
        let head: [String: Any] = ["type": 2, "tagName": "head", "id": 3, "childNodes": [], "attributes": [:]]
        let html: [String: Any] = ["type": 2, "tagName": "html", "id": 2, "childNodes": [head, body], "attributes": [:]]
        return ["type": 0, "id": 1, "childNodes": [html]]
    }

    // MARK: touches → clicks

    private func installTouches() {
        guard touchRecognizer == nil, let w = keyWindow() else { return }
        let t = TouchObserver { [weak self] p in
            self?.push(["type": 3, "data": ["source": 2, "type": 2, "id": PryntReplay.imgId, "x": Int(p.x), "y": Int(p.y)]])
        }
        w.addGestureRecognizer(t)
        touchRecognizer = t
    }

    // MARK: events + upload

    private func push(_ ev: [String: Any]) {
        var e = ev
        e["timestamp"] = Int(Date().timeIntervalSince1970 * 1000)
        events.append(e)
        bytes += (e["data"] as? [String: Any]).map { String(describing: $0).utf8.count } ?? 64
    }

    private func custom(_ tag: String, _ payload: [String: Any]) {
        guard state == "recording" else { return }
        push(["type": 5, "data": ["tag": tag, "payload": payload]])
    }

    private func flush(final: Bool, sync: Bool = false) {
        guard let o = opts, !events.isEmpty || final else { return }
        let batch = events; events = []; bytes = 0; lastFlush = Date()
        let body: [String: Any] = ["publicKey": o.publicKey, "website": o.website, "sessionId": sessionId, "seq": seq,
                                   "consent": o.consent, "consentSource": "config", "final": final,
                                   "visitorId": o.visitorId as Any, "platform": "ios", "events": batch]
        seq += 1
        defaults.set(seq, forKey: "prynt.replay.seq.\(sessionId)")
        guard let data = try? JSONSerialization.data(withJSONObject: body),
              let url = URL(string: o.endpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/v1/replay/chunk?pk=" + enc(o.publicKey)) else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"; req.httpBody = data
        req.setValue("text/plain", forHTTPHeaderField: "Content-Type")
        req.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { [weak self] _, resp, _ in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if (400..<500).contains(code) && code != 429 {
                DispatchQueue.main.async { self?.halt("server_\(code)", final: false) }
            }
            done.signal()
        }.resume()
        if sync { _ = done.wait(timeout: .now() + 2) }
    }

    // MARK: helpers

    private func currentSession() -> String {
        let last = defaults.object(forKey: "prynt.replay.lastActive") as? Date ?? .distantPast
        if let sid = defaults.string(forKey: "prynt.replay.sid"), Date().timeIntervalSince(last) < 30 * 60 { return sid }
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        let sid = "rvs_" + String((0..<24).map { _ in alphabet.randomElement()! })
        defaults.set(sid, forKey: "prynt.replay.sid")
        defaults.set(Date(), forKey: "prynt.replay.lastActive")
        return sid
    }

    private func keyWindow() -> UIWindow? {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }.first { $0.isKeyWindow }
    }

    private func screenName(_ w: UIWindow) -> String {
        var vc = w.rootViewController
        while true {
            if let p = vc?.presentedViewController { vc = p; continue }
            if let n = vc as? UINavigationController, let t = n.topViewController { vc = t; continue }
            if let t = vc as? UITabBarController, let s = t.selectedViewController { vc = s; continue }
            break
        }
        let name = vc.map { String(describing: type(of: $0)) } ?? "App"
        return name.replacingOccurrences(of: "ViewController", with: "").replacingOccurrences(of: "HostingController", with: "Screen")
    }

    private func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? s }

    static let userAgent: String = {
        let v = UIDevice.current.systemVersion.replacingOccurrences(of: ".", with: "_")
        let model = UIDevice.current.userInterfaceIdiom == .pad ? "iPad; CPU OS" : "iPhone; CPU iPhone OS"
        return "Mozilla/5.0 (\(model) \(v) like Mac OS X) PryntReplay-iOS/1.0"
    }()

    private static var crashInstalled = false
    private static var previousHandler: (@convention(c) (NSException) -> Void)?
    private static func installCrashHandler() {
        guard !crashInstalled else { return }
        crashInstalled = true
        previousHandler = NSGetUncaughtExceptionHandler()
        NSSetUncaughtExceptionHandler { ex in
            let r = PryntReplay.shared
            r.push(["type": 5, "data": ["tag": "prynt.error", "payload": [
                "message": "\(ex.name.rawValue): \(ex.reason ?? "")".prefix(500).description,
                "stack": ex.callStackSymbols.prefix(30).joined(separator: "\n"), "kind": "error"]]])
            r.flush(final: true, sync: true)
            PryntReplay.previousHandler?(ex)
        }
    }
}

/// Watches taps on the whole window without ever taking them from the app.
private final class TouchObserver: UIGestureRecognizer {
    private let onTap: (CGPoint) -> Void
    init(onTap: @escaping (CGPoint) -> Void) {
        self.onTap = onTap
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false; delaysTouchesBegan = false; delaysTouchesEnded = false
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        if let t = touches.first, let v = view { onTap(t.location(in: v)) }
        state = .failed
    }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {}
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { state = .failed }
    override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
}
