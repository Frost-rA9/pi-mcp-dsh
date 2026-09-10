# pi-mcp-dsh

A pi extension that bridges MCP server tools into **real pi tools** (`mcp__<server>__<tool>`), modeled on a single reference source: [dsh](https://github.com/deepseek-ai/deepseek-harness) (`packages/mcp/mcp-client`). Pi core deliberately ships **no MCP client** — this extension is what connects MCP servers and exposes their tools to the model.

## Model

**Deferred registration + lazy server start on pi's native Dynamic Tool Loading.** Every bridged MCP tool is registered as a real pi tool but kept *inactive* — zero prompt cost until used. A single `mcp` loader discovers, activates, and calls.

- Servers come only from config (`~/.pi/agent/mcp.json` / project `.pi/mcp.json`); a server starts **lazily** on its first call, so a cold start connects to nothing.
- The `mcp` loader has four actions: `list` (see all tools across servers), `search` (find tools by query and **activate** matches additively), `describe` (show a tool's schema), `call` (invoke a tool).
- Activation is purely additive via `pi.setActiveTools`, so pi anchors the new schemas via Anthropic `defer_loading` / OpenAI `tool_search` on the next request.
- Naming contract (dsh `publicToolName`): `mcp__<server>__<rawName>`, normalized to at most 64 chars; a lossy normalization appends a SHA-256 hash so distinct MCP identities never collapse.

## Orthogonality

This is **cross-cutting infrastructure** — how external MCP tools reach the model — not a guidance or enforcement axis. It reads/writes neither `plan` nor `sandbox` state; all three configure and run independently.

| Kind | Extension | State | Role |
|---|---|---|---|
| Guidance axis | `pi-plan-dsh` | `plan/mode` | soft prompt guidance |
| Enforcement axis | `pi-sandbox-dsh` | `sandbox/mode` | write-boundary OS sandbox |
| Infrastructure | `pi-mcp-dsh` | — | bridge MCP tools to real pi tools |

## Design rules

1. Every bridged MCP tool is a real pi tool (`mcp__<server>__<raw>`) but inactive until used — zero prompt cost.
2. Servers start lazily on first use; nothing spawns on cold start.
3. Two-phase generation exchange (dsh `syncTools`): fetch the full next generation first; any failure keeps the previous generation — the model sees all-or-nothing.
4. **Fail closed**: a restricted tool surface refuses MCP tool calls.
5. Result projection maps `isError` to pi's error results and never silently drops content blocks.

## Backends

MCP servers over stdio transport, config-driven (`mcpServers` in `~/.pi/agent/mcp.json` or `.pi/mcp.json`). See [RESEARCH.md](RESEARCH.md) for the dsh `mcp-client` study and [DESIGN.md](DESIGN.md) for the design rationale.

## License

MIT
