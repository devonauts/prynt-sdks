# Changelog — com.pryntid:prynt-android

All notable changes to this package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/). New notes go under **Unreleased**;
`scripts/sdk/release.sh mobile-android X.Y.Z` dates them.

## [Unreleased]

- Prynt Replay: native session replay (screenshots with inputs masked on the device, taps as clicks, crashes as errors) in the same Replay console as the web.

## [1.0.0]

- First public release. Android SDK: persisted device id, root / Frida / emulator / cloned-app tells, optional Play Integrity provider; `Prynt(context, apiKey, endpoint).identify { … }`.
