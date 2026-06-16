# context1337-release

Automated cross-platform **release builder** for
[context1337](https://github.com/wgpsec/context1337) — the wgpsec **AboutSecurity**
knowledge MCP server (binary name `absec`).

It tracks the upstream sources, cross-compiles `absec` for every supported
platform on a single runner, bundles the full AboutSecurity knowledge base, runs
a real MCP smoke test, and publishes per-platform zips as GitHub Releases that
downstream tools can fetch directly — no local Go/Python toolchain required on
the consuming machine.

## What it produces

Each release contains one zip per platform plus a checksum file:

```
context1337-win32-amd64.zip
context1337-linux-amd64.zip
context1337-linux-arm64.zip
context1337-darwin-amd64.zip
context1337-darwin-arm64.zip
SHA256SUMS.txt
```

Every zip unpacks to a `context1337/` directory:

```
context1337/
├── absec[.exe]              # the MCP server binary (loopback-patched)
└── data/
    ├── builtin.db           # FTS5 index built from AboutSecurity
    ├── skills/  Dic/  Payload/  Vuln/   # the knowledge corpus
```

`absec` binds **127.0.0.1 by default** (a `--host` flag, added by this
pipeline's security patch — upstream binds 0.0.0.0). Run it as a Streamable
HTTP MCP server:

```
absec serve --port 1337 --data-dir ./context1337/data
# MCP endpoint:  http://127.0.0.1:1337/mcp
# health probe:  http://127.0.0.1:1337/health  -> "OK"
```

It exposes (lite mode) `search_security`, `get_security_detail`,
`read_security_file`.

## How the automation works

| Workflow | Trigger | What it does |
|---|---|---|
| `track-upstream.yml` | weekly cron + manual | `git ls-remote` checks wgpsec/context1337 + AboutSecurity for new commits; if either moved, bumps `pins.json`, commits it, and calls the release workflow |
| `build-release.yml` | version tag, manual, or called by track-upstream | clone pinned → loopback patch → Python FTS index → `CGO_ENABLED=0` cross-compile all platforms → **MCP verify gate** → publish Release |

The **verify gate** (`verify.ts`) boots the freshly built `absec`, checks
`/health`, and performs a real MCP `initialize` + `tools/list`. If an upstream
change breaks the MCP server, the gate fails and **no release is cut** — the
automation never publishes a broken build.

`pins.json` is the single source of truth for which upstream commits are built.
`dataSnapshotDate` records when the AboutSecurity corpus was last bumped.

## Building locally

Requires `go`, `python3`, `git`, `bun`.

```
bun run build.ts                       # all platforms -> dist/<platform>/context1337/
bun run build.ts --only=linux-amd64    # one platform
bun run build.ts --zip                 # also produce dist/context1337-<platform>.zip
bun run verify.ts linux-amd64          # boot + MCP smoke test the built binary
bun run bump-pins.ts --date=2026-06-16 # check upstream, bump pins.json if newer
```

## Consuming from a downstream tool

Fetch the zip for the host platform from the latest release, verify against
`SHA256SUMS.txt`, and unpack the `context1337/` directory into your tools path.
Then launch `absec serve --port <p> --data-dir <unpacked>/context1337/data` and
connect an MCP client to `http://127.0.0.1:<p>/mcp`.

## Attribution

Upstream `absec` and the AboutSecurity data set are authored by
[wgpsec](https://github.com/wgpsec). This repository only builds and redistributes
them (with a loopback-binding security patch). See [NOTICE](NOTICE) for details
and upstream-licensing caveats.
