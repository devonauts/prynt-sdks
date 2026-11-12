# Changelog — Prynt

All notable changes to this package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/). New notes go under **Unreleased**;
`scripts/sdk/release.sh mobile-ios X.Y.Z` dates them.

## [Unreleased]

- Prynt Replay: native session replay (screenshots with inputs masked on the device, taps as clicks, crashes as errors) in the same Replay console as the web.

## [1.0.0]

- First public release. iOS SDK: Keychain-persisted id that survives reinstall, jailbreak / instrumentation / cloned-app tells, App Attest; `try await Prynt(apiKey:endpoint:).identify()`. Swift Package + CocoaPods, iOS 13+.
