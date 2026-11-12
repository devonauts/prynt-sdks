# Prynt iOS SDK (Swift)

Stable device identity + integrity signals, verified server-side. Swift Package, iOS 13+.

```swift
import Prynt

let prynt = try Prynt(apiKey: "pk_live_…", endpoint: "https://api.pryntid.com")
let result = try await prynt.identify()
print(result.visitorId, result.confidence.level)   // vst_… high
```

## What it collects (raw tells — the server decides)
- **Identity**: a Keychain-persisted device id that **survives app reinstall**, plus device
  model, OS, screen, hardware. The server fuses these into a stable `visitorId`.
- **Jailbreak**: suspicious files, `cydia://` scheme, sandbox-escape write, `fork()` success,
  injected dylibs (MobileSubstrate/Frida).
- **Instrumentation**: Frida control port (27042), injected `frida`/`gum` images, `P_TRACED`.
- **Cloned/side-loaded**: App Store receipt presence, bundle id, debug build.
- **App Attest** (iOS 14+): a hardware-backed attestation token when the capability is enabled;
  your server verifies it against Apple.

## Install

Swift Package Manager — Xcode → File → Add Package Dependencies → `https://github.com/devonauts/prynt-ios`,
or in `Package.swift`:

```swift
.package(url: "https://github.com/devonauts/prynt-ios", from: "1.0.0")
// target dependency: .product(name: "Prynt", package: "prynt-ios")
```

CocoaPods:

```ruby
pod 'Prynt', '~> 1.0'
```

MIT licensed.

## Prynt Replay (session replay)

It captures the app as low-rate screenshots (1 frame a second, only when the screen changed), paints over every
text input, password field and anything you mark **on the device, before a frame leaves it**, and turns taps into
clicks. Sessions appear in the same Replay console as your website: screens as pages, rage clicks, crashes as
errors, Py's summaries, issues and alerts. The app joins the site you name in `website` (it must be verified in the
console). Recording follows `consent`; pass `false` until your consent flow allows it.

```swift
import Prynt

PryntReplay.shared.start(.init(publicKey: "pk_live_…", website: "acme.com"))
PryntReplay.shared.identify("user_42")   // your own user id, never an email
```

Always masked: `UITextField`, `UITextView`, secure entry. Mask anything else with
`view.accessibilityIdentifier = "prynt-mask"`, or everything with text with `maskAllText: true`.
Options: `framesPerSecond` (default 1), `scale` (0.5), `jpegQuality` (0.45), `endpoint`, `visitorId`.
