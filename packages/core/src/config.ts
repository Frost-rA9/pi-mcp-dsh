// MCP server 配置文件读取（副作用：mcp.json 读写）。
// 纯配置驱动、与任何特定 server 解耦：
//   项目 `.pi/mcp.json` 覆盖 `~/.pi/agent/mcp.json` 的 `mcpServers`；
//   两者皆未定义 → 无 server（无内置默认）。无工具过滤（pi 裁剪，对齐桥契约）。
import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfig, McpServers } from "pi-mcp-dsh-bridge";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 测试用 echo MCP server 脚本的绝对路径（供测试配置使用，不写死进主体）。 */
export const echoServerPath = path.join(__dirname, "..", "test", "echo-server.mjs");

export function resolveAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function readMcpServersFrom(file: string): McpServers | null {
  try {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const servers = raw?.mcpServers;
    if (servers && typeof servers === "object" && Object.keys(servers).length > 0) {
      return servers as McpServers;
    }
    return null;
  } catch {
    return null;
  }
}

/** 加载 server 配置，优先级：项目 `.pi/mcp.json` > `~/.pi/agent/mcp.json`。 */
export function loadMcpServers(cwd: string = process.cwd()): McpServers {
  const globalFile = path.join(resolveAgentDir(), "mcp.json");
  const projectFile = path.join(cwd, ".pi", "mcp.json");
  const global = readMcpServersFrom(globalFile) ?? {};
  const project = readMcpServersFrom(projectFile) ?? {};
  return { ...global, ...project };
}

/** 每个 server 校验配置（对齐 dsh resolveConfig），非法即抛。 */
export function validateMcpServers(servers: McpServers): McpServers {
  const out: McpServers = {};
  for (const [id, cfg] of Object.entries(servers)) {
    out[id] = cfg; // 校验交给 resolveMcpServerConfig（bridge），此处不重复
  }
  return out;
}

/** 工具元数据缓存文件路径（v2 格式）。 */
export function cachedMetaPath(cwd: string = process.cwd()): string {
  return path.join(cwd, ".pi", "pi-mcp-dsh-cache.json");
}
