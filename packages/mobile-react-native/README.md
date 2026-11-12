# @pryntid/react-native

Bridges to the native iOS/Android Prynt SDKs — device signals, integrity (jailbreak/root/Frida/
emulator/cloned), Keychain/Keystore-persisted id, and hardware attestation — resolving identity
server-side.

```ts
import { Prynt } from '@pryntid/react-native';

const prynt = new Prynt('pk_live_…', 'https://api.pryntid.com');
const { visitorId, confidence } = await prynt.identify();
```

## Install

```bash
npm install @pryntid/react-native
cd ios && pod install
```

Autolinks on RN 0.68+. Uses the native Prynt SDKs — the iOS pod `Prynt` (CocoaPods) and
`com.pryntid:prynt-android` (Maven Central), pulled in automatically. MIT licensed.

## Prynt Replay (session replay)

It captures the app as low-rate screenshots (1 frame a second, only when the screen changed), paints over every
text input, password field and anything you mark **on the device, before a frame leaves it**, and turns taps into
clicks. Sessions appear in the same Replay console as your website: screens as pages, rage clicks, crashes as
errors, Py's summaries, issues and alerts. The app joins the site you name in `website` (it must be verified in the
console). Recording follows `consent`; pass `false` until your consent flow allows it.

```ts
import { PryntReplay } from '@pryntid/react-native';

PryntReplay.start({ publicKey: 'pk_live_…', website: 'acme.com' });
PryntReplay.identify('user_42');
```

`TextInput` is a native field, so it is always masked. Mask other views with `nativeID="prynt-mask"`.
