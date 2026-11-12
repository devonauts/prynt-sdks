#!/usr/bin/env bash
# Build, test and (with --publish) publish Prynt SDKs. Wrapper around scripts/sdk/sdk.py.
#
#   scripts/sdk/release.sh <package|all> [<version>] [--dry-run|--publish] [--native] [--skip a,b]
#
#   scripts/sdk/release.sh all                    dry-run every package (no tokens needed)
#   scripts/sdk/release.sh agent 1.0.1            bump @pryntid/js to 1.0.1 (files + CHANGELOG), then dry-run it
#   scripts/sdk/release.sh all --publish          publish every package whose version is not live yet,
#                                                 using the tokens present in the environment
# Tokens: NPM_TOKEN, PYPI_API_TOKEN, RUBYGEMS_API_KEY, NUGET_API_KEY, MAVEN_CENTRAL_USERNAME,
# MAVEN_CENTRAL_PASSWORD, MAVEN_GPG_PRIVATE_KEY, MAVEN_GPG_PASSPHRASE, COCOAPODS_TRUNK_TOKEN,
# PUB_CREDENTIALS, WP_SVN_USERNAME, WP_SVN_PASSWORD. A registry without its token is skipped.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[ $# -ge 1 ] || { sed -n '2,13p' "$0"; exit 2; }
pkg="$1"; shift
ver=""
if [ $# -ge 1 ] && [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then ver="$1"; shift; fi
mode="--dry-run"; extra=()
for a in "$@"; do
  case "$a" in
    --publish) mode="--publish" ;;
    --dry-run) mode="--dry-run" ;;
    *) extra+=("$a") ;;
  esac
done
if [ -n "$ver" ]; then
  if [ "$mode" = "--publish" ]; then
    echo "Bump first and commit, then publish what is committed:" >&2
    echo "  scripts/sdk/release.sh $pkg $ver && git commit -am \"release: $pkg $ver\" && scripts/sdk/release.sh $pkg --publish" >&2
    exit 2
  fi
  python3 "$HERE/sdk.py" bump "$pkg" "$ver"
fi
exec python3 "$HERE/sdk.py" release "$pkg" "$mode" ${extra[@]+"${extra[@]}"}
