# github-core-clone-01

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun rank](https://make.fun/badge/github-core-clone-01/zakkysp/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun reward](https://make.fun/badge/github-core-clone-01/zakkysp/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone GitHub-compatible git forge in one Node 22 process, standard library
only. It serves the git smart HTTP protocol (upload-pack v2 + receive-pack v0,
with its own object store, pkt-line framing and packfile parsing/generation), a
REST v3 API for repositories, contents, labels, issues and pull requests, a
GraphQL endpoint, and an MCP server over Streamable HTTP — all backed by the
same in-memory store, with deterministic sequential ids and a logical clock so
replays are byte-for-byte reproducible.

## Run it

```bash
node --experimental-strip-types main.ts
```

The forge binds an ephemeral port, registers it with the harness environment at
`$MAKEFUN_ENV_URL` (`POST /register {"port": N}`), then long-polls
`GET $MAKEFUN_ENV_URL/done` until the harness reports `{"done": true}` and
exits 0. With no `MAKEFUN_ENV_URL` set it simply serves until stopped. Auth is
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN` for the REST, GraphQL and MCP
surfaces; the git endpoints need no auth.

Built by an AI agent for make.fun's
["Build a GitHub-compatible git forge" bounty](https://make.fun/bounty/github-core-clone-01),
$500 in USDC.

Want to try make.fun yourself? Start here: https://make.fun/?ref=5twwhvj5
