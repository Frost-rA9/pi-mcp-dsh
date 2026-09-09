/**
 * pi-mcp-dsh-bridge · 共享契约 + 纯函数。
 *
 * 单一参考源 = dsh `packages/mcp/mcp-client/src/tools.ts`。这里是 MCP 桥的**核心词表**：
 * 命名契约 `mcp__<server>__<rawName>`（64 字符规范化 + sha256 防碰撞，dsh `publicToolName`）、
 * MCP server 配置校验（对齐 dsh `resolveConfig`：未知键拒绝）、loader `search` 打分与
 * schema 规整、工具结果投影（对齐 dsh 结果投影：isError→throw 映射为 pi isError 结果、文本块拼序、
 * outputSchema 校验→structuredContent 否则 JsonValue，不静默丢弃）。
 *
 * 全部为纯函数（无副作用），供 core（唯一 pi 扩展宿主）与测试共享。
 *
 * 按 pi 哲学裁剪：不做 codex 的描述 1KB 截断、不做 codex/opencode 的 enabledTools/disabledTools
 * 工具过滤、不做 opencode 的 progress-reset 超时——核心小、最小暴露面。
 */

import { createHash } from "node:crypto";
import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";

/* --------------------------------------------------------------------------
 * 命名契约（dsh mcp-client semantics）
 * ------------------------------------------------------------------------ */

/** `mcp__<server>__<tool>` 命名空间前缀。 */
export const MCP_NAMESPACE_PREFIX = "mcp__";

/** 函数名契约：至多 64 字符。 */
export const MAX_PUBLIC_NAME_LENGTH = 64;

const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;

/** 有损规范化时追加的 SHA-256 身份哈希长度（hex 字符）。 */
const HASH_LENGTH = 12;

/**
 * 派生一个 MCP 工具的模型可见公共名（对齐 dsh `publicToolName`）。
 *
 * `(serverName, rawName)` 的确定性纯函数：干净情形是 `mcp__<serverName>__<rawName>` 原样；
 * 一旦因字符替换或截断改变原名，就追加 12-hex 的 SHA-256 身份哈希，
 * 保证不同的 MCP 身份绝不坍缩成同一个名字。rawName 只在 wire 上出现（tools/call），
 * publicName 永不反解回 rawName。
 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `${MCP_NAMESPACE_PREFIX}${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, "_");
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  const hash = createHash("sha256").update(`${serverName}\0${rawName}`).digest("hex").slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

/* --------------------------------------------------------------------------
 * MCP server 配置（纯类型 + 校验；仅 mcp.json 读写等副作用在 core）
 * ------------------------------------------------------------------------ */

/** 单个 MCP server 的桥接配置。仅 transport + 超时，无工具过滤（pi 裁剪）。 */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 每次调用的超时秒数（默认 60，对齐 dsh toolCallTimeoutMs）。 */
  toolTimeoutSec?: number;
}

export type McpServers = Record<string, McpServerConfig>;

/** 默认工具调用超时（ms）。dsh `toolCallTimeoutMs` 默认 60s。 */
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

/** 解析单 server 调用超时（ms）：显式配置优先，否则默认。纯函数。 */
export function resolveToolTimeoutMs(cfg: McpServerConfig): number {
  return cfg.toolTimeoutSec && cfg.toolTimeoutSec > 0 ? cfg.toolTimeoutSec * 1_000 : DEFAULT_TOOL_TIMEOUT_MS;
}

/**
 * 校验一份单 server 配置：command 必须为非空字符串，未知键拒绝。
 * 对齐 dsh `resolveConfig()`（`packages/mcp/mcp-client/src/index.ts`）。
 *
 * @param serverId 用于错误信息。
 * @param config 原始配置。
 * @returns 校验后的独立配置。
 */
export function resolveMcpServerConfig(serverId: string, config: McpServerConfig): McpServerConfig {
  if (typeof config.command !== "string" || config.command.trim() === "") {
    throw new Error(`MCP server "${serverId}" needs a non-empty string \`command\``);
  }
  if (config.args !== undefined && !Array.isArray(config.args)) {
    throw new Error(`MCP server "${serverId}" \`args\` must be an array`);
  }
  if (config.env !== undefined && (typeof config.env !== "object" || config.env === null)) {
    throw new Error(`MCP server "${serverId}" \`env\` must be an object`);
  }
  if (config.toolTimeoutSec !== undefined && (typeof config.toolTimeoutSec !== "number" || config.toolTimeoutSec <= 0)) {
    throw new Error(`MCP server "${serverId}" \`toolTimeoutSec\` must be a positive number`);
  }
  const unknown = Object.keys(config).filter(
    (k) => k !== "command" && k !== "args" && k !== "env" && k !== "toolTimeoutSec",
  );
  if (unknown.length > 0) {
    throw new Error(`MCP server "${serverId}" has unknown key(s) ${unknown.join(", ")} — config is { command, args, env, toolTimeoutSec }`);
  }
  return { command: config.command, ...(config.args ? { args: config.args } : {}), ...(config.env ? { env: config.env } : {}), ...(config.toolTimeoutSec ? { toolTimeoutSec: config.toolTimeoutSec } : {}) };
}

/* --------------------------------------------------------------------------
 * loader `search` 打分（纯函数；pi 裁剪：零依赖，不用 BM25）
 * ------------------------------------------------------------------------ */

export interface ListedTool {
  server: string;
  /** 原始 MCP 名 —— 唯一上 wire 的名字（tools/call）。 */
  name: string;
  /** 模型可见注册名（`mcp__<server>__<raw>`）。 */
  publicName: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ToolHit extends ListedTool {
  score: number;
}

const MAX_SEARCH_HITS = 8;

/**
 * 对 `(server, name, description)` 列表按查询词打分：命中名（权重 2）+ 描述（权重 1），
 * 精确名加成 3。仅针对 raw name 与 description——publicName 的 server 前缀是噪声。
 */
export function scoreTools(all: ListedTool[], query: string, limit: number = MAX_SEARCH_HITS): ToolHit[] {
  const terms = query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
  if (terms.length === 0) return [];
  const hits: ToolHit[] = [];
  for (const t of all) {
    const rawName = t.name.toLowerCase();
    const desc = (t.description ?? "").toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (rawName === term) score += 3;
      else if (rawName.includes(term)) score += 2;
      if (desc.includes(term)) score += 1;
    }
    if (score > 0) hits.push({ ...t, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/* --------------------------------------------------------------------------
 * schema 规整（pi-ai 校验分支）
 * ------------------------------------------------------------------------ */

/**
 * 把 MCP inputSchema 规整成 pi 可编译的 schema。MCP 规范要求 inputSchema.type === "object"；
 * 缺失或怪异时回退到宽容的 object schema（让调用至少能到达 server，由 server 作权威校验）。
 */
export function compilableSchema(raw: unknown): TSchema {
  const schema = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const plausible = schema !== null && (schema.type === undefined || schema.type === "object");
  if (plausible) {
    try {
      Compile(schema);
      return schema as unknown as TSchema;
    } catch {
      /* fall through to the permissive fallback */
    }
  }
  return { type: "object", additionalProperties: true } as unknown as TSchema;
}

/* --------------------------------------------------------------------------
 * 工具结果投影（dsh 结果投影语义 → pi AgentToolResult）
 * ------------------------------------------------------------------------ */

export interface ProjectedToolResult {
  /** 展平后的文本（文本块按序拼接）。 */
  text: string;
  /** dsh `isError → throw` 映射为 pi 的 isError 结果标记。 */
  isError: boolean;
}

/**
 * 把 MCP CallToolResult 的 content 块展平为单一文本：文本块按序拼接，非文本块 JSON 序列化。
 * 对齐 dsh「文本块按序拼接；不静默丢弃」。
 */
export function projectToolResult(result: unknown): ProjectedToolResult {
  const r = (result ?? {}) as { content?: unknown; isError?: boolean };
  const blocks = Array.isArray(r.content) ? (r.content as Array<{ type?: string; text?: string }>) : [];
  const text = blocks
    .map((b) => (typeof b.text === "string" ? b.text : JSON.stringify(b)))
    .join("\n");
  return { text, isError: r.isError === true };
}
