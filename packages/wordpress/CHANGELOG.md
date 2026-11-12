# Changelog — prynt

All notable changes to this package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/). New notes go under **Unreleased**;
`scripts/sdk/release.sh wordpress X.Y.Z` dates them.

## [Unreleased]

## [1.2.0]

- Prynt Reveal: see which companies visit the site. "Connect" exchanges a one-time setup code from the Prynt console (single use, 30 minutes) for the website's public key, or paste the public key by hand; the Reveal-only bundle then loads async in `<head>` on front-end pages. The first visit verifies the website (no DNS record or meta tag). Saving the Device settings no longer resets other options.

## [1.1.0]

- Current release (first one published to the registry). Identify visitors and stop bot and spam submissions on login, registration, comments and WooCommerce checkout (honeypot, timing and script-based content checks), with a settings page.
