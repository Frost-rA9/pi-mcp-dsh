// ServerManager：懒连接、长驻子进程复用、工具元数据缓存（v2）、带中止/超时的工具转发、
// 以及 `notifications/tools/list_changed` 上的两相世代交换。
//
// 语义取自单一参考源 dsh `packages/mcp/mcp-client/src/{connection,tools}.ts`：
// - 一 server 一连接实例（dsh 插件实例模型）；
// - 懒连接：server 只在首次调用时拉起（pi 裁剪，替代 dsh 常驻重连监督）；
// - 两相世代交换 `syncTools`（dsh）：phase1 分页拉全量；任何失败（list 错误、重复名）
//   保留上一代注册——模型只见全有或全无；
// - `list_changed` 再同步、失败保留上一代（dsh）；
// - `toolCallTimeoutMs` 默认 60s 带 abort（dsh）；连不上也限时（防挂死）。
//
// 按 pi 哲学裁剪：不做 codex 的描述 1KB 截断、不做 codex/opencode 的工具过滤、
// 不做 opencode 的 progress-reset 超时——核心小、最小暴露面。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResultSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type McpServerConfig,
  type McpServers,
  publicToolName,
  resolveInstructions,
  resolveToolTimeoutMs,
  projectToolResult,
} from "pi-mcp-dsh-bridge";

/** 连接超时，防 server 挂死拖垮调用（dsh 无此值；pi 裁剪取 opencode 默认 30s 内化）。 */
export const CONNECT_TIMEOUT_MS = 30_000;

export interface ToolMeta {
  /** 原始 MCP 名 —— 唯一上 wire 的名字（tools/call）。 */
  name: string;
  /** 模型可见注册名（`mcp__<server>__<raw>`）。 */
  publicName: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ListedTool extends ToolMeta {
  server: string;
}

export interface CallResult {
  text: string;
  isError: boolean;
  /** canonical `structuredContent`（dsh `{ content, structuredContent? }`）；只进 pi details。 */
  structuredContent?: unknown;
}

/** 一 server 的按需信息（instructions 只在 loader `describe` 时带出，不进常驻 prompt）。 */
export interface ServerInfo {
  server: string;
  connected: boolean;
  toolCount: number;
  /** 已发布的 instructions；空未发布。 */
  instructions?: string;
  /** 因超字节上限而未发布时的原因（dsh `maxInstructionBytes`）。 */
  instructionsOmittedReason?: string;
}

interface Runtime {
  transport: StdioClientTransport;
  client: Client;
  tools: ToolMeta[];
  /** 本次连接的 server instructions（经 bridge `resolveInstructions` 规整）。 */
  instructions?: string;
  instructionsOmittedReason?: string;
}

interface CacheEntry {
  tools: ToolMeta[];
  updatedAt: string;
}

interface CacheFile {
  version: 2;
  servers: Record<string, CacheEntry>;
}

interface RawTool {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
}

export class ServerManager {
  private runtimes = new Map<string, Runtime>();
  /** 进行中的首次连接（连接建立单飞：并发首次调用只拉起一个子进程）。 */
  private connecting = new Map<string, Promise<Runtime>>();
  private metaCache: Record<string, ToolMeta[]> = {};
  private cacheFile: string;
  private servers: McpServers;
  private resyncing = new Set<string>();

  /** server 的工具代际变化时触发（resync 或首连且与前一代不同）。 */
  onToolsChanged: ((serverId: string, tools: ToolMeta[]) => void) | null = null;

  constructor(servers: McpServers, opts: { cacheFile?: string } = {}) {
    this.servers = servers;
    this.cacheFile = opts.cacheFile ?? "";
    this.loadCache();
  }

  get ids(): string[] {
    return Object.keys(this.servers);
  }

  /** 现存子进程数（测试断言懒行为）。 */
  connectionCount(): number {
    return this.runtimes.size;
  }

  /** 单 server 的缓存工具（可能为空）；不产生连接。 */
  cachedTools(serverId: string): ToolMeta[] {
    return this.metaCache[serverId] ?? [];
  }

  // ---- 缓存持久化（v2；透明读取 v1 布局） ----
  private loadCache(): void {
    if (!this.cacheFile) return;
    try {
      if (!existsSync(this.cacheFile)) return;
      const raw = JSON.parse(readFileSync(this.cacheFile, "utf8"));
      if (!raw || typeof raw !== "object") return;
      if (raw.version === 2 && raw.servers && typeof raw.servers === "object") {
        for (const [id, entry] of Object.entries(raw.servers as Record<string, CacheEntry>)) {
          const tools = entry?.tools;
          if (Array.isArray(tools)) this.metaCache[id] = tools.map((t) => this.hydrateMeta(id, t));
        }
        return;
      }
      // v1: Record<serverId, ToolMeta[]> without publicName
      for (const [id, tools] of Object.entries(raw as Record<string, ToolMeta[]>)) {
        if (Array.isArray(tools)) this.metaCache[id] = tools.map((t) => this.hydrateMeta(id, t));
      }
    } catch {
      /* ignore corrupt cache */
    }
  }

  private hydrateMeta(serverId: string, t: Partial<ToolMeta>): ToolMeta {
    const name = typeof t.name === "string" ? t.name : "";
    return {
      name,
      publicName: typeof t.publicName === "string" ? t.publicName : publicToolName(serverId, name),
      ...(t.description !== undefined ? { description: t.description } : {}),
      inputSchema: t.inputSchema,
    };
  }

  private saveCache(): void {
    if (!this.cacheFile) return;
    try {
      const file: CacheFile = { version: 2, servers: {} };
      for (const [id, tools] of Object.entries(this.metaCache)) {
        file.servers[id] = { tools, updatedAt: new Date().toISOString() };
      }
      mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      writeFileSync(this.cacheFile, JSON.stringify(file, null, 2), "utf8");
    } catch {
      /* ignore persistence failure */
    }
  }

  // ---- 摄入：命名规范化 + 重复名整体拒绝（dsh） ----
  private normalizeTools(serverId: string, rawTools: RawTool[]): ToolMeta[] {
    const out: ToolMeta[] = [];
    const seen = new Set<string>();
    for (const t of rawTools) {
      const name = typeof t.name === "string" ? t.name : "";
      if (!name) continue;
      if (seen.has(name)) {
        // dsh syncTools：同一 server 重复列出同一工具 = 非法工具列表 → 整代拒绝。
        throw new Error(`server "${serverId}" listed tool "${name}" more than once — invalid tool list`);
      }
      seen.add(name);
      const description = typeof t.description === "string" && t.description.trim() !== "" ? t.description : undefined;
      out.push({
        name,
        publicName: publicToolName(serverId, name),
        ...(description !== undefined ? { description } : {}),
        inputSchema: t.inputSchema,
      });
    }
    return out;
  }

  // ---- 分页列出 ----
  private async fetchTools(client: Client, serverId: string): Promise<ToolMeta[]> {
    // dsh：server 未声明 tools 能力 = 空集（资源型 server 连接成功、工具集为空，不报错）。
    if (client.getServerCapabilities()?.tools === undefined) return [];
    const raw: RawTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const res = await client.listTools(cursor === undefined ? {} : { cursor });
      raw.push(...((res.tools ?? []) as RawTool[]));
      if (!res.nextCursor) break;
      if (cursors.has(res.nextCursor)) throw new Error(`MCP list returned duplicate cursor: ${res.nextCursor}`);
      cursors.add(res.nextCursor);
      cursor = res.nextCursor;
    }
    return this.normalizeTools(serverId, raw);
  }

  private toolsChanged(serverId: string, prev: ToolMeta[] | undefined, next: ToolMeta[]): boolean {
    return JSON.stringify(prev ?? []) !== JSON.stringify(next);
  }

  // ---- 懒连接 ----
  /**
   * 连接建立单飞（DESIGN 不变量 7 / dsh「每 server 一连接 + sync 串行」）：
   * 并发首次调用共享同一次建立；失败不缓存（下一次调用重试）。
   */
  private async ensureConnected(serverId: string): Promise<Runtime> {
    const existing = this.runtimes.get(serverId);
    if (existing) return existing;
    const inFlight = this.connecting.get(serverId);
    if (inFlight) return inFlight;
    const attempt = this.openConnection(serverId);
    this.connecting.set(serverId, attempt);
    try {
      return await attempt;
    } finally {
      if (this.connecting.get(serverId) === attempt) this.connecting.delete(serverId);
    }
  }

  private async openConnection(serverId: string): Promise<Runtime> {
    const cfg = this.servers[serverId];
    if (!cfg) throw new Error(`unknown MCP server: ${serverId}`);

    const transport = new StdioClientTransport({
      command: cfg.command,
      ...(cfg.args !== undefined ? { args: cfg.args } : {}),
      ...(cfg.env !== undefined ? { env: cfg.env } : {}),
      stderr: "pipe",
    });
    const client = new Client({ name: "pi-mcp-dsh", version: "0.1.0" });

    // 连接限时：挂死 server 不能拖垮调用。
    await Promise.race([
      client.connect(transport),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error(`MCP server "${serverId}" failed to connect within 30s`)), CONNECT_TIMEOUT_MS),
      ),
    ]);

    // 子进程退出时丢弃 runtime；下次调用懒重连（pi 裁剪，替代 dsh 常驻重连监督）。
    client.onclose = () => {
      if (this.runtimes.get(serverId)?.client === client) this.runtimes.delete(serverId);
    };
    // dsh/opencode：跟随 server 的工具列表变化。
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      void this.resync(serverId);
    });

    const tools = await this.fetchTools(client, serverId);
    // instructions 随连接产出（dsh：discovery 成功后才有内容可发布；pi 只存起来供 loader 按需带出）。
    const resolved = resolveInstructions(client.getInstructions());
    const runtime: Runtime = {
      transport,
      client,
      tools,
      ...(resolved.text !== undefined ? { instructions: resolved.text } : {}),
      ...(resolved.omittedReason !== undefined ? { instructionsOmittedReason: resolved.omittedReason } : {}),
    };
    this.runtimes.set(serverId, runtime);

    const prev = this.metaCache[serverId];
    this.metaCache[serverId] = tools;
    this.saveCache();
    if (this.toolsChanged(serverId, prev, tools)) this.onToolsChanged?.(serverId, tools);
    return runtime;
  }

  /**
   * 两相再同步（dsh syncTools）：先抓全量下一代；任何失败保留上一代注册不动。
   * 成功后交换 runtime 代际、更新缓存、通知 registry。
   */
  async resync(serverId: string): Promise<void> {
    const rt = this.runtimes.get(serverId);
    if (!rt || this.resyncing.has(serverId)) return;
    this.resyncing.add(serverId);
    try {
      const tools = await this.fetchTools(rt.client, serverId);
      rt.tools = tools;
      this.metaCache[serverId] = tools;
      this.saveCache();
      this.onToolsChanged?.(serverId, tools);
    } catch {
      /* keep previous generation */
    } finally {
      this.resyncing.delete(serverId);
    }
  }

  // ---- 公共操作 ----

  /** 显式连接 + 发现一 server（loader `list` 的引导路径）。 */
  async connect(serverId: string): Promise<ToolMeta[]> {
    const rt = await this.ensureConnected(serverId);
    return rt.tools;
  }

  async list(serverId?: string): Promise<ListedTool[]> {
    const out: ListedTool[] = [];
    const ids = serverId ? (this.servers[serverId] ? [serverId] : []) : this.ids;
    for (const id of ids) {
      const rt = this.runtimes.get(id);
      for (const t of rt?.tools ?? this.metaCache[id] ?? []) {
        out.push({ server: id, ...t });
      }
    }
    return out;
  }

  async describe(serverId: string, tool: string): Promise<ListedTool | undefined> {
    const all = await this.list(serverId);
    return all.find((t) => t.server === serverId && (t.publicName === tool || t.name === tool));
  }

  async call(
    serverId: string,
    tool: string,
    args?: Record<string, unknown>,
    opts: { signal?: AbortSignal } = {},
  ): Promise<CallResult> {
    const rt = await this.ensureConnected(serverId); // lazy: 仅在此拉起子进程
    const meta = rt.tools.find((t) => t.publicName === tool || t.name === tool);
    if (!meta) throw new Error(`tool not found on "${serverId}": ${tool}`);

    const cfg: McpServerConfig = this.servers[serverId] ?? { command: "" };
    const timeoutMs = resolveToolTimeoutMs(cfg);

    const result = await rt.client.callTool(
      { name: meta.name, arguments: args ?? {} },
      CallToolResultSchema,
      {
        timeout: timeoutMs,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        // 无 progress-reset（opencode trick 裁剪）：仅简单超时 + 中止。
      },
    );
    const projected = projectToolResult(result);
    return {
      text: projected.text,
      isError: projected.isError,
      ...(projected.structuredContent !== undefined ? { structuredContent: projected.structuredContent } : {}),
    };
  }

  /**
   * 连接后交付一 server 的按需信息（loader `describe {server}`）：工具数 + 已发布 instructions。
   * 未连接时也会连接（与 `list` 一致的显式发现路径）。
   */
  async serverInfo(serverId: string): Promise<ServerInfo> {
    const rt = await this.ensureConnected(serverId);
    return {
      server: serverId,
      connected: true,
      toolCount: rt.tools.length,
      ...(rt.instructions !== undefined ? { instructions: rt.instructions } : {}),
      ...(rt.instructionsOmittedReason !== undefined
        ? { instructionsOmittedReason: rt.instructionsOmittedReason }
        : {}),
    };
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(
      [...this.runtimes.entries()].map(async ([id, rt]) => {
        try {
          await rt.client.close();
        } catch {
          /* ignore */
        }
        try {
          await rt.transport.close();
        } catch {
          /* ignore */
        }
        this.runtimes.delete(id);
      }),
    );
  }
}
