# Prynt Android SDK (Kotlin)

Stable device identity + integrity signals, verified server-side. Android library, minSdk 21.

```kotlin
import dev.prynt.Prynt

val prynt = Prynt(context, "pk_live_…", "https://api.pryntid.com")
prynt.identify { outcome ->
    when (outcome) {
        is PryntOutcome.Success -> Log.d("prynt", outcome.result.visitorId)
        is PryntOutcome.Failure -> Log.e("prynt", "failed", outcome.error)
    }
}
```

## What it collects (raw tells — the server decides)
- **Identity**: a persisted device id + `ANDROID_ID` + device fingerprint. (Android has no
  reinstall-surviving per-app store like iOS Keychain; identity is anchored by the combination
  plus Play Integrity and the server-side linking graph.)
- **Root**: `su` binaries, Magisk, `test-keys`, dangerous props, rw `/system`, root apps, busybox.
- **Instrumentation**: Frida port (27042), `frida`/`gum` in `/proc/self/maps`, gum threads, TracerPid.
- **Emulator**: QEMU/goldfish/ranchu, Genymotion, missing sensors, Build fingerprint/model.
- **Cloned/side-loaded**: installer package, signing-cert hash, package name, debuggable flag.
- **Play Integrity** (optional): set `PlayIntegrity.provider = { nonce -> token }` to forward a
  hardware-backed token; your server verifies it against Google.

## Install

Maven Central (`repositories { mavenCentral() }`):

```kotlin
implementation("com.pryntid:prynt-android:1.0.0")
```

MIT licensed.

## Prynt Replay (session replay)

It captures the app as low-rate screenshots (1 frame a second, only when the screen changed), paints over every
text input, password field and anything you mark **on the device, before a frame leaves it**, and turns taps into
clicks. Sessions appear in the same Replay console as your website: screens as pages, rage clicks, crashes as
errors, Py's summaries, issues and alerts. The app joins the site you name in `website` (it must be verified in the
console). Recording follows `consent`; pass `false` until your consent flow allows it.

```kotlin
PryntReplay.start(application, PryntReplay.Options(publicKey = "pk_live_…", website = "acme.com"))
PryntReplay.identify("user_42")   // your own user id, never an email
```

Always masked: `EditText` and password inputs. Mask anything else with `view.tag = "prynt-mask"` (or a content
description containing `prynt-mask`), or everything with text with `maskAllText = true`. Frames use `PixelCopy`
(Android 8+), so SurfaceView / maps are captured too.
