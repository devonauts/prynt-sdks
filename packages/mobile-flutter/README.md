# Prynt Flutter plugin

Bridges to the native iOS/Android Prynt SDKs — device signals, integrity (jailbreak/root/Frida/
emulator/cloned), Keychain/Keystore-persisted id, and hardware attestation — resolving identity
server-side.

```dart
import 'package:prynt/prynt.dart';

final prynt = Prynt(apiKey: 'pk_live_…', endpoint: 'https://api.pryntid.com');
final result = await prynt.identify();
print('${result.visitorId} ${result.confidence.level}');
```

## Install

```bash
flutter pub add prynt
```

The plugin uses the native Prynt SDKs: the iOS pod `Prynt` (CocoaPods) and
`com.pryntid:prynt-android` (Maven Central), pulled in automatically. iOS 13+, Android minSdk 21.
MIT licensed.

## Prynt Replay (session replay)

It captures the app as low-rate screenshots (1 frame a second, only when the screen changed), paints over every
text input, password field and anything you mark **on the device, before a frame leaves it**, and turns taps into
clicks. Sessions appear in the same Replay console as your website: screens as pages, rage clicks, crashes as
errors, Py's summaries, issues and alerts. The app joins the site you name in `website` (it must be verified in the
console). Recording follows `consent`; pass `false` until your consent flow allows it.

```dart
await PryntReplay.start(publicKey: 'pk_live_…', website: 'acme.com');
PryntReplay.identify('user_42');

PryntMask(child: Text(account.iban));   // hide anything else
```

Flutter draws its own widgets, so the Dart side reports where every `EditableText` (every `TextField`) and every
`PryntMask` is, twice a second, and the native recorder paints over those regions before the frame is encoded.
