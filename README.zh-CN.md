# pi-mcp-dsh

一个 pi 扩展，把 MCP server 的工具桥接成**真实 pi 工具**（`mcp__<server>__<tool>`），仅以单一参考源建模：[dsh](https://github.com/deepseek-ai/deepseek-harness)（`packages/mcp/mcp-client`）。pi 核心刻意**不内置 MCP 客户端**——本扩展正是「连接 MCP server 并把它们的工具暴露给模型」的实现者。

## 模型

**在 pi 原生 Dynamic Tool Loading 上做 deferred 注册 + 懒启动 server。** 每个桥接的 MCP 工具都被注册成真实 pi 工具，但保持 *inactive*——激活前零 prompt 代价。单个 `mcp` loader 负责发现、激活与调用。

- server 完全来自配置（`~/.pi/agent/mcp.json` / 项目 `.pi/mcp.json`）；server 在其**首次调用**时才懒启动——冷启动不连任何东西。
- `mcp` loader 有四个动作：`list`（列出所有 server 的工具）、`search`（按查询找工具并**增量激活**命中项）、`describe`（查看工具的入参 schema）、`call`（调用工具）。
- 激活经 `pi.setActiveTools` 纯增量进行，pi 在下一请求经 Anthropic `defer_loading` / OpenAI `tool_search` 锚定新 schema。
- 命名契约（dsh `publicToolName`）：`mcp__<server>__<rawName>`，规范到至多 64 字符；有损规范化时追加 SHA-256 哈希，保证不同 MCP 身份绝不坍缩。

## 正交性

这是**跨切面基础设施**——外置 MCP 工具如何到达模型——不是引导轴或强制轴。它不读写 `plan`/`sandbox` 状态；三者在配置与运行上完全独立。

| 类型 | 扩展 | 状态 | 角色 |
|---|---|---|---|
| 引导轴 | `pi-plan-dsh` | `plan/mode` | 软提示引导 |
| 强制轴 | `pi-sandbox-dsh` | `sandbox/mode` | 写入边界的 OS 沙箱 |
| 基础设施 | `pi-mcp-dsh` | — | 把 MCP 工具桥接成真实 pi 工具 |

## 设计规则

1. 每个桥接的 MCP 工具都是真实 pi 工具（`mcp__<server>__<raw>`），但激活前 inactive——零 prompt 代价。
2. server 首次使用才懒启动；冷启动无任何子进程/连接。
3. 两相世代交换（dsh `syncTools`）：先抓全量下一代；任何失败保留上一代——模型只见全有或全无。
4. **失败即关闭**：受限工具面拒绝 MCP 工具调用。
5. 结果投影把 `isError` 映射为 pi 的错误结果，且从不静默丢弃内容块。

## 后端

MCP server 经 stdio transport，配置驱动（`~/.pi/agent/mcp.json` 或 `.pi/mcp.json` 的 `mcpServers`）。dsh `mcp-client` 研究与设计依据见 [RESEARCH.md](RESEARCH.md) 与本地 `AGENTS.md`（gitignored）。

## 许可证

MIT
