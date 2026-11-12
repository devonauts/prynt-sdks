# Changelog — @pryntid/mcp

All notable changes to this package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/). New notes go under **Unreleased**;
`scripts/sdk/release.sh mcp X.Y.Z` dates them.

## [Unreleased]

## [0.2.0] - 2026-11-12

- Prynt Replay and Py (Prynt's AI): `prynt_replay_sessions`, `prynt_replay_session`, `prynt_replay_summarize`, `prynt_replay_issues` and `prynt_ask_py` over the new `/v1/replay` server API (secret key; Replay must be active on the account).

## [0.1.0]

- First public release. MCP server (`prynt-mcp`): look up identification events, check IP reputation, report outcomes, service health and an integration guide, using your secret key over stdio.
