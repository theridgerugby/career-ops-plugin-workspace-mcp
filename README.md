# Workspace MCP for Career-Ops

A zero-dependency, tools-only MCP plugin for reading a local Career-Ops workspace.
It takes the permission boundary used by Job Panel and keeps the first release
strictly read-only. It adds no lifecycle states, user data files or core patches.
This is an independent community plugin, not an official Career-Ops surface.

## Tools and permissions

| Tool | Returns |
| --- | --- |
| `workspace_summary` | Tracker/inbox counts, status counts, local observation time, source diagnostics |
| `list_jobs` | Job metadata with filters, location/company/role/status/date sorting and bounded pagination |
| `get_job` | One exact listed job identity |
| `get_application_files` | Report/CV/cover-letter paths, existence and missing/rejected reasons |

There are no write tools or configurable write mode. Status transitions,
favorites, deletion, submission, messages, shell commands, browser control and
arbitrary file-content reads are absent. The server does not open PDFs or read
their bodies. Tracker notes, profile sources, credentials and root CV content
are excluded from responses. No HTTP listener, outbound network call or key is
required. Responses go to the explicitly connected MCP client through stdio.

**Privacy:** a local MCP connection gives its client the returned job metadata
and material paths. A cloud-backed agent may send that metadata to its model
provider under the client's settings. Review those settings before connecting.
This plugin makes no third-party transmission itself and cannot enforce how the
client uses responses.

The implementation is an API permission boundary, not an OS sandbox. Node and
the operator-selected Career-Ops checkout run with the operator's account.
Use reviewed, trusted code; separate filesystem permissions can further limit
the process. Test/smoke scripts create and remove their own temporary fixtures;
the server implementation performs only reads.

## Connect explicitly

Requirements: Node 20+ and a trusted Career-Ops checkout with
`tracker-parse.mjs`, `tracker-links.mjs`, `web/src/lib/pipeline-table.mjs`,
`web/src/lib/apply/cv-selection.mjs` and `web/src/lib/report-files.mjs`.
Compatibility was checked against upstream
main `b54c484e592bba35dcd399629e7a60d44312d36b` (2026-10-12).
Missing readers fail startup; the plugin never silently switches to its own
parsing rules.

```sh
node /absolute/path/career-ops-plugin-workspace-mcp/bin/server.mjs \
  --code-root /absolute/path/career-ops \
  --data-root /absolute/path/my-career-ops-data
```

`--code-root` selects executable code you trust; `--data-root` is the allowed data
directory and defaults to that checkout. Both are operator-supplied at process
startup, never tool arguments. For Windows use a single command line and forward
slashes, quoting paths containing spaces.

A generic stdio-client configuration (including Claude Code's MCP JSON format):

```json
{
  "mcpServers": {
    "career-ops-workspace": {
      "command": "node",
      "args": [
        "/absolute/path/career-ops-plugin-workspace-mcp/bin/server.mjs",
        "--code-root", "/absolute/path/career-ops",
        "--data-root", "/absolute/path/my-career-ops-data"
      ]
    }
  }
}
```

For clients with another config format, use the same command and args. No
installer edits any Codex/Claude config. Stop or disconnect this process to
revoke MCP access; disabling the separate Career-Ops export hook does not stop a
client-launched process.

## Data paths and material association

- Defaults: `data/applications.md` (legacy root `applications.md` also supported),
  `data/pipeline.md`, `data/pdf-index.tsv`.
- Nonstandard layouts can set `--tracker relative/path.md` and
  `--pdf-index relative/index.tsv`. Both must remain inside `--data-root`.
- Ambient `CAREER_OPS_*` path overrides and `.career-ops-data` are intentionally
  not followed. Translate your actual layout into explicit startup arguments.
  This prevents inherited environment settings from silently widening access.
- Header/URL parsing, inbox grammar and report-number CV/cover matching use
  the checkout's existing parsers. No company-name package matching.
- Bare report paths such as `reports/010-example.md` can resolve from the
  workspace root as well as the tracker directory. Both resolutions use the
  same `reports/` restriction.
- Report metadata is restricted to `.md` under `reports/`; PDF metadata to `.pdf`
  under `output/`. Symlinks/junctions inside data paths, traversal, directories,
  duplicate job identities, mismatched report labels/targets, reserved report
  sentinels and multiple report links are rejected. `report_problem` exposes
  invalid or missing associations on tracker jobs.
- `snapshot_at` is the local observation time, not a source freshness claim.
  Reads are per-file observations, not an atomic transaction across files.
  Pass the first page's `snapshot_id` on subsequent `list_jobs` calls to reject
  changed tracker/inbox contents. Material metadata is observed separately.
- Empty/missing sources are diagnosed; malformed tracker rows follow core parser
  behavior. `Applied` retains Career-Ops's submitted-state meaning. A local PDF
  is not evidence of employer receipt, and a missing cover letter is not
  automatically an incomplete application.

## Career-Ops plugin hook

The manifest declares the existing finite `export` hook. It prints only local
workspace counts through the engine's logger, returns `pushed: 0`, and creates
no store or service. This hook is useful for a capability/dry-run check.
MCP runs only through the explicit entrypoint above; no new hook kind or core
loader change is needed.

For local development, place a reviewed copy of this directory at
`<checkout>/plugins.local/workspace-mcp` (the folder name must match the manifest
ID), then review and opt in:

```sh
node plugins.mjs enable workspace-mcp
node plugins.mjs enable workspace-mcp --confirm
node plugins.mjs run workspace-mcp export --dry-run
node plugins.mjs skill workspace-mcp
```

These commands are instructions for the operator; they are not run by the MCP
server. Plugin enable/lock gates protect the finite export hook. Direct stdio
startup is a separate explicit consent step, and does not bypass those gates to
load other plugins. No dependencies or install scripts are needed.

## Verification and publication

```sh
npm test
node test/smoke.mjs --code-root /absolute/path/trusted-career-ops
node /absolute/path/career-ops/plugin-audit.mjs /absolute/path/this-plugin
```

The default smoke checks protocol framing/negotiation, exact tools, strict
arguments, file bounds, link rejection and the finite export hook. The optional
core checks exercise the actual upstream readers against fictional temporary
data, including cover-before-CV index rows, duplicate identities, stale pages,
missing sources, path attacks and unchanged tracker bytes.

Source: [theridgerugby/career-ops-plugin-workspace-mcp](https://github.com/theridgerugby/career-ops-plugin-workspace-mcp).
Version 0.1.1 is proposed for the community registry and is not yet
registry-approved. The upstream registry PR pins an exact commit for review.
Before approval, an operator who has reviewed that commit can install it
explicitly with the existing unregistered-plugin flow:

```sh
node plugins.mjs add theridgerugby/career-ops-plugin-workspace-mcp --sha <reviewed-40-hex-commit>
node plugins.mjs enable workspace-mcp --confirm
```

The installed MCP entrypoint is then
`<checkout>/plugins.local/workspace-mcp/bin/server.mjs`; connecting it remains
an explicit client configuration step. Installation/enablement alone starts no
MCP service. The proposed pipeline UI in upstream #5093 remains separate and
awaits scope confirmation.

Protocol reference: [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[initialization](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
and [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
This deliberately implements the small tools-only subset needed here, with
interoperability checked separately against the official TypeScript SDK client.
