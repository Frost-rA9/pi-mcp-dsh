// Deferred per-tool registration on pi's native Dynamic Tool Loading 机制。
//
// 每个桥接的 MCP 工具都被注册成**真实 pi 工具**（mcp__<server>__<raw>），但保持 INACTIVE：
// 激活前零 prompt 代价。loader（`mcp` 代理工具）search 命中后增量激活——pi 在下一请求
// 经 Anthropic defer_loading / OpenAI tool_search 锚定新 schema，保持 KV-cache 前缀稳定。
// 惰性加载工具不带 promptSnippet/promptGuidelines（pi 文档：激活带 prompt 元数据的工具
// 会重建系统提示并破坏前缀）。
//
// 代际交换（注册侧）对齐 dsh 两相再同步：覆盖活跃工具注册；消失的工具 stub 化并退出活动集。
import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ServerManager, ToolMeta } from "./connection.ts";
import { MCP_NAMESPACE_PREFIX, compilableSchema, type ListedTool, scoreTools, type ToolHit } from "pi-mcp-dsh-bridge";

function result(text: string, isError = false): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details: {},
    ...(isError ? { isError: true as const } : {}),
  };
}

export class DeferredRegistry {
  /** publicName -> 属主身份 */
  private registered = new Map<string, { serverId: string; rawName: string }>();

  private pi: ExtensionAPI;
  private manager: ServerManager;
  private loaderName: string;
  private gate: () => string | null;

  constructor(pi: ExtensionAPI, manager: ServerManager, loaderName: string, gate: () => string | null) {
    this.pi = pi;
    this.manager = manager;
    this.loaderName = loaderName;
    this.gate = gate;
  }

  /** 不连任何 server，注册全部缓存工具。 */
  registerFromCache(): void {
    for (const id of this.manager.ids) {
      const tools = this.manager.cachedTools(id);
      if (tools.length > 0) this.registerServerTools(id, tools);
    }
  }

  /** (重新)注册整个 server 代际。pi registerTool 覆盖同名 def。 */
  registerServerTools(serverId: string, tools: ToolMeta[]): void {
    for (const meta of tools) this.registerOne(serverId, meta);
  }

  private registerOne(serverId: string, meta: ToolMeta): void {
    const description =
      meta.description && meta.description.trim().length > 0
        ? meta.description
        : `MCP tool "${meta.name}" on server "${serverId}" (no description provided).`;
    this.pi.registerTool({
      name: meta.publicName,
      label: meta.name,
      description,
      parameters: compilableSchema(meta.inputSchema),
      // 有意不带 promptSnippet / promptGuidelines（KV-cache 前缀）。
      execute: async (_toolCallId: string, args: unknown, signal: AbortSignal | undefined) => {
        const denied = this.gate();
        if (denied) return result(denied, true);
        try {
          const r = await this.manager.call(serverId, meta.publicName, args as Record<string, unknown> | undefined, {
            ...(signal !== undefined ? { signal } : {}),
          });
          return result(r.text, r.isError);
        } catch (err) {
          return result(errorText(err), true);
        }
      },
    });
    this.registered.set(meta.publicName, { serverId, rawName: meta.name });
  }

  /**
   * 代际交换（注册侧，dsh 两相再同步）：覆盖活跃工具注册；消失的工具 stub 化并退出活动集。
   */
  onManagerToolsChanged(serverId: string, tools: ToolMeta[]): void {
    const live = new Set(tools.map((t) => t.publicName));
    for (const [publicName, info] of [...this.registered.entries()]) {
      if (info.serverId !== serverId || live.has(publicName)) continue;
      const rawName = info.rawName;
      this.pi.registerTool({
        name: publicName,
        label: publicName,
        description: `[retired] MCP tool "${rawName}" is no longer listed by server "${serverId}".`,
        parameters: { type: "object", additionalProperties: true } as unknown as TSchema,
        execute: async () =>
          result(`MCP tool "${rawName}" was removed from server "${serverId}". Re-run mcp({action:"search"}) to rediscover.`, true),
      });
      const active = this.pi.getActiveTools();
      if (active.includes(publicName)) this.pi.setActiveTools(active.filter((n) => n !== publicName));
    }
    this.registerServerTools(serverId, tools);
  }

  /** session_start 后：除桥接的 MCP 工具外都保持激活，再加上 loader。 */
  keepOnlyLoaderActive(): void {
    const active = this.pi.getActiveTools().filter((n) => !n.startsWith(MCP_NAMESPACE_PREFIX));
    const next = active.includes(this.loaderName) ? active : [...active, this.loaderName];
    this.pi.setActiveTools(next);
  }

  /** 纯增量激活（pi 在工具结果上记录新增）。 */
  activate(publicNames: string[]): string[] {
    const active = this.pi.getActiveTools();
    const added = publicNames.filter((n) => !active.includes(n));
    if (added.length > 0) this.pi.setActiveTools([...active, ...added]);
    return added;
  }

  /**
   * loader `search`：对已知工具打分，激活最高分，报告哪些可直接按名调用
   * （pi 原生 deferred loading 上的 CC ToolSearch / Codex tool_search 语义）。
   */
  async searchAndActivate(query: string, serverId?: string): Promise<{ hits: ToolHit[]; added: string[] }> {
    const all = await this.manager.list(serverId);
    const hits = scoreTools(all as ListedTool[], query);
    const added = this.activate(hits.map((h) => h.publicName));
    return { hits, added };
  }

  isRegistered(publicName: string): boolean {
    return this.registered.has(publicName);
  }

  registeredNames(): string[] {
    return [...this.registered.keys()];
  }
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `MCP tool call failed: ${msg}`;
}
