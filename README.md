# Prynt SDKs

Client and server SDKs for [Prynt](https://pryntid.com) device intelligence: identify a browser
or app install with a stable `visitorId`, then verify the result on your server with your secret
key. The Prynt service itself is not in this repository — these packages talk to Prynt Cloud
(`https://api.pryntid.com`) or to your own Prynt server.

| Platform | Package | Install | Source |
|---|---|---|---|
| Browser | `@pryntid/js` | `npm install @pryntid/js` or `<script src="https://api.pryntid.com/cdn/prynt.umd.js"></script>` | [packages/agent](packages/agent) |
| React | `@pryntid/react` | `npm install @pryntid/react @pryntid/js` | [packages/react](packages/react) |
| Node.js | `@pryntid/node` | `npm install @pryntid/node` | [packages/server-node](packages/server-node) |
| Python | `pryntid` (import `prynt`) | `pip install pryntid` | [packages/server-python](packages/server-python) |
| Ruby | `prynt` | `gem install prynt` | [packages/server-ruby](packages/server-ruby) |
| PHP | `prynt/server` | `composer require prynt/server` | [packages/server-php](packages/server-php) · [pryntid/prynt-php](https://github.com/devonauts/prynt-php) |
| .NET | `Prynt.Server` | `dotnet add package Prynt.Server` | [packages/server-dotnet](packages/server-dotnet) |
| Java | `com.pryntid:prynt-server` | Maven Central | [packages/server-java](packages/server-java) |
| Go | `github.com/devonauts/prynt-sdks/packages/server-go` | `go get github.com/devonauts/prynt-sdks/packages/server-go` | [packages/server-go](packages/server-go) |
| iOS | `Prynt` | Swift Package `https://github.com/devonauts/prynt-ios` or `pod 'Prynt'` | [packages/mobile-ios](packages/mobile-ios) · [pryntid/prynt-ios](https://github.com/devonauts/prynt-ios) |
| Android | `com.pryntid:prynt-android` | Maven Central | [packages/mobile-android](packages/mobile-android) |
| Flutter | `prynt` | `flutter pub add prynt` | [packages/mobile-flutter](packages/mobile-flutter) |
| React Native | `@pryntid/react-native` | `npm install @pryntid/react-native` | [packages/mobile-react-native](packages/mobile-react-native) |
| AI assistants (MCP) | `@pryntid/mcp` | `npx -y @pryntid/mcp` | [packages/mcp](packages/mcp) |
| Cloudflare Workers | — | [download](https://pryntid.com/downloads/prynt-edge-cloudflare.zip) | [packages/edge-cloudflare](packages/edge-cloudflare) |
| nginx / OpenResty | — | [download](https://pryntid.com/downloads/prynt-edge-nginx.zip) | [packages/edge-nginx](packages/edge-nginx) |
| WordPress | `prynt` | WordPress plugin directory | [packages/wordpress](packages/wordpress) |

Every package has its own `README.md` and `CHANGELOG.md`, and its own version
([Semantic Versioning](https://semver.org)). Releases are tagged `packages/<dir>/vX.Y.Z`.

Docs: <https://pryntid.com/docs> · Get keys: <https://app.pryntid.com>

## Releasing (maintainers)

`scripts/sdk/release.sh all` builds, tests and dry-runs every package in Docker (no tokens).
Pushing a tag `packages/<dir>/vX.Y.Z` runs [`.github/workflows/release.yml`](.github/workflows/release.yml),
which publishes that package with the repository's secrets; npm packages are published with
[provenance](https://docs.npmjs.com/generating-provenance-statements).

## License

MIT — see [LICENSE](LICENSE). Security issues: see [SECURITY.md](SECURITY.md).
