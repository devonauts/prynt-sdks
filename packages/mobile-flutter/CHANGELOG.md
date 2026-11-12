# Changelog — prynt

All notable changes to this package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/). New notes go under **Unreleased**;
`scripts/sdk/release.sh mobile-flutter X.Y.Z` dates them.

## [Unreleased]

- Prynt Replay: native session replay (screenshots with inputs masked on the device, taps as clicks, crashes as errors) in the same Replay console as the web.

## [1.0.0]

- First public release. Flutter plugin over the native iOS and Android SDKs: `Prynt(apiKey:, endpoint:).identify()`.
