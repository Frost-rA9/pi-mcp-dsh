// pi-mcp-dsh · pi 扩展宿主（唯一 pi 扩展）。
//
// 单一参考源 = dsh `packages/mcp/mcp-client`。装配：pi 原生 Dynamic Tool Loading
// 上做 deferred 注册（每个桥接工具 inactive，零 prompt 代价）→ 单 `mcp` loader 工具
// （list/search/describe/call）做发现与激活 → server 首次调用懒启动。
//
// 这是 MCP 协议客户端：pi 核心刻意不内置 MCP（README Philosophy "No MCP"），
// 连接 server、发现工具、映射成 mcp__server__tool、结果投影这些活都由本扩展承担。
import type { ExtensionAPI, ExtensionContext, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { loadMcpServers, cachedMetaPath } from "./config.ts";
import { ServerManager } from "./connection.ts";
import { DeferredRegistry } from "./registry.ts";

const LOADER_NAME = "mcp";

const Action = Type.Union([
  Type.Literal("list"),
  Type.Literal("search"),
  Type.Literal("describe"),
  Type.Literal("call"),
]);

const McpParams = Type.Object({
  action: Action,
  server: Type.Optional(Type.String()),
  tool: Type.Optional(Type.String()),
  query: Type.Optional(Type.String()),
  args: Type.Optional(Type.Record(Type.String(), Type.Any())),
});

type McpParamsT = Static<typeof McpParams>;

/** 从配置的 server 生成提示引导（数据驱动，不硬编码任何 server）。 */
function buildGuidelines(ids: string[]): string[] {
  const g = [
    "Bridged MCP tools appear as real pi tools named mcp__<server>__<tool>. Use mcp({action:\"search\", query}) to find tools for a capability — matching tools are activated automatically and become directly callable by name.",
    "Use mcp({action:\"list\"}) to see all tools across servers; mcp({action:\"describe\", server, tool}) shows a tool's parameter schema; mcp({action:\"describe\", server}) shows that server's instructions and tool count.",
    "Call a tool directly via mcp({action:\"call\", server:\"<server>\", tool:\"<tool>\", args:{...}}); the server starts lazily on first call.",
    ids.length > 0
      ? `Available MCP servers: ${ids.join(", ")}.`
      : "No MCP servers are configured yet (set mcpServers in `~/.pi/agent/mcp.json` or `.pi/mcp.json`).",
  ];
  // 仅当确实配置了 "semble" 才给出该 server 的提示。
  if (ids.includes("semble")) {
    g.push(
      'To search a codebase, call mcp({action:"call", server:"semble", tool:"mcp__semble__search", args:{query, repo}}) where repo is a local path or https git URL.',
      'After a search, use mcp({action:"call", server:"semble", tool:"mcp__semble__find_related", args:{file_path, line, repo}}) for similar code elsewhere.',
    );
  }
  return g;
}

export default function (pi: ExtensionAPI): void {
  const servers = loadMcpServers();
  const manager = new ServerManager(servers, { cacheFile: cachedMetaPath() });

  // Fail-closed 防御：当活动工具面已移除写能力（`edit` 不在 active 集）时拒绝 MCP 调用。
  // 与具体扩展解耦（不读其他扩展状态），作为纵深防御。
  const gate = (): string | null => {
    if (pi.getActiveTools().includes("edit")) return null;
    return "Restricted tool surface is active: MCP tool calls are refused here. Re-enable the write-capable tool surface and retry.";
  };

  const registry = new DeferredRegistry(pi, manager, LOADER_NAME, gate);
  manager.onToolsChanged = (serverId, tools) => registry.onManagerToolsChanged(serverId, tools);

  // 加载时注册缓存工具；保持 inactive，直到被 search 或 call。
  registry.registerFromCache();

  // 长驻资源清理（pi docs：长驻资源与 shutdown）。
  pi.on("session_shutdown", async () => {
    await manager.disconnectAll();
  });

  // 初始活动集保持最小：除桥接的 MCP 工具外全保留，再加 loader。
  pi.on("session_start", async () => {
    registry.keepOnlyLoaderActive();
  });

  pi.registerTool({
    name: LOADER_NAME,
    label: "MCP",
    description:
      "Proxy to Model Context Protocol (MCP) servers. Actions: list (show tools on one/all servers), " +
      "search (find tools by query and ACTIVATE them so they become directly callable by name), " +
      "describe (server only: show its instructions and tool count; with tool: show that tool's params/schema), " +
      "call (invoke a tool; starts the server on first call). " +
      "Available servers: " + manager.ids.join(", ") + ".",
    parameters: McpParams,
    promptSnippet: "mcp({action, server, tool, args, query}) — discover, activate, and call MCP tools",
    promptGuidelines: buildGuidelines(manager.ids),
    async execute(
      _toolCallId: string,
      params: McpParamsT,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const r = await run(pi, manager, registry, gate, params, signal);
      return {
        content: [{ type: "text", text: r.text }],
        details: r.details ?? {},
      };
    },
  });
}

async function run(
  pi: ExtensionAPI,
  manager: ServerManager,
  registry: DeferredRegistry,
  gate: () => string | null,
  p: McpParamsT,
  signal: AbortSignal | undefined,
): Promise<{ text: string; details?: Record<string, unknown> }> {
  const server = p.server;
  switch (p.action) {
    case "list": {
      // 引导未缓存 server：发现是显式模型动作，这里连接正是首次可用的前提
      // （连接经 onToolsChanged -> registry 注册活工具）。
      const uncached = manager.ids.filter(
        (id) => (!server || id === server) && manager.cachedTools(id).length === 0,
      );
      for (const id of uncached) {
        try {
          await manager.connect(id);
        } catch {
          /* 不可达 server：在下方（空）列出中体现 */
        }
      }
      const tools = await manager.list(server);
      if (tools.length === 0) {
        const scope = server ? ` on "${server}"` : "";
        return {
          text: `No MCP tools discovered${scope}. Try mcp({action:"call", ...}) once to connect a server, or check the server config.`,
        };
      }
      const active = new Set(pi.getActiveTools());
      const lines = tools.map((t) => {
        const state = active.has(t.publicName) ? "" : " (inactive — search to activate)";
        return `${t.publicName}${t.description ? " — " + t.description : ""}${state}`;
      });
      return { text: lines.join("\n") };
    }
    case "search": {
      const q = p.query ?? "";
      if (!q) return { text: 'Please provide a "query".' };
      const { hits, added } = await registry.searchAndActivate(q, server);
      if (hits.length === 0) {
        const hint =
          "If a server is configured but has no tools yet, run mcp({action:\"list\"}) once — it connects configured servers and discovers their live tools. Then search again.";
        return { text: `No tools matched "${q}". ${hint}` };
      }
      const lines = hits.map(
        (h) => `${h.publicName} (score ${h.score})${h.description ? " — " + h.description : ""}`,
      );
      const tail =
        added.length > 0
          ? `\n\nActivated ${added.length} tool(s): ${added.join(", ")}. They are now directly callable by name.`
          : `\n\nMatching tools were already active.`;
      return { text: lines.join("\n") + tail, details: { matches: hits.map((h) => h.publicName), added } };
    }
    case "describe": {
      if (!server) return { text: 'Please provide a "server".' };
      // 无 tool：server 级信息（含 instructions 按需带出——不进常驻 system prompt，DESIGN 不变量 8）。
      if (!p.tool) {
        try {
          const info = await manager.serverInfo(server);
          const lines = [
            `MCP server: ${info.server}`,
            `Tools: ${info.toolCount}${info.toolCount === 0 ? " (none listed)" : " — use mcp({action:\"list\", server}) or mcp({action:\"search\", query, server}) to see them"}`,
          ];
          if (info.instructions !== undefined) lines.push(`\nInstructions from this server:\n${info.instructions}`);
          else if (info.instructionsOmittedReason !== undefined) lines.push(`\n[instructions omitted: ${info.instructionsOmittedReason}]`);
          else lines.push("\nThis server publishes no instructions.");
          return { text: lines.join("\n") };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { text: `Could not connect to MCP server "${server}": ${msg}` };
        }
      }
      const t = await manager.describe(server, p.tool);
      if (!t)
        return {
          text: `Tool not found: ${p.tool} on "${server}". Use mcp({action:"list", server:"${server}"}) to see available tools.`,
        };
      return {
        text: `${t.publicName}\n${t.description ?? ""}\n\nSchema:\n${JSON.stringify(t.inputSchema ?? {}, null, 2)}`,
      };
    }
    case "call": {
      if (!server) return { text: 'Please provide a "server".' };
      if (!p.tool) return { text: 'Please provide a "tool".' };
      const denied = gate();
      if (denied) return { text: denied, details: { denied: true } };
      try {
        const r = await manager.call(server, p.tool, p.args as Record<string, unknown> | undefined, {
          ...(signal !== undefined ? { signal } : {}),
        });
        // 一次成功调用后使其下次可直接按名调用（增量）。
        const meta = (await manager.list(server)).find(
          (t) => t.server === server && (t.publicName === p.tool || t.name === p.tool),
        );
        const added = meta ? registry.activate([meta.publicName]) : [];
        return {
          text: r.text,
          details: {
            isError: r.isError,
            ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}),
            ...(added.length > 0 ? { activated: added } : {}),
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          text: `MCP call failed: ${msg}\nUse mcp({action:"describe", server:"${server}", tool:"${p.tool}"}) to check the tool's schema, or mcp({action:"list"}) to see what is available.`,
          details: { isError: true },
        };
      }
    }
  }
}
