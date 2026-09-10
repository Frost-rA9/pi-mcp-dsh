# pi-mcp-dsh 设计依据（是什么 / 为什么）

> 本文是**设计依据**（是什么 / 为什么）：定位、参考源锚点、判定门记录、设计决策、架构、不变量、已知取舍。
> **agent 在本目录工作的行为约束见 `AGENTS.md`（本地文件、不入库，故 clone 中不出现）**；本文件按需读：改语义 / 改不变量 / 改参考源语义前。
> 单一参考源 = **dsh mcp-client**（`~/projects/deepseek-harness/packages/mcp/mcp-client/src/`）。完整调研 + 实现方案见 `RESEARCH.md`。

---

## 〇、定位与核心命题

- 一个 pi 扩展，把 **MCP server 的工具桥接成真实 pi 工具**（`mcp__<server>__<tool>`），在 pi 原生 Dynamic Tool Loading 上做 deferred 注册。
- 一句话：**pi 核心刻意不内置 MCP 协议客户端**（README Philosophy "No MCP"）；连接 MCP server、发现工具、映射成 pi 工具、结果投影这层活由本扩展承担。
- 这是**跨切面基础设施**（外置工具如何到达模型），**不是** plan/force 那样的引导轴/强制轴——与 pi-sandbox-dsh / pi-plan-dsh 完全正交、互不读写。

## 一、参考源锚点（dsh mcp-client 源码实证）

| dsh 概念 | 源码位置 | 语义要点 |
|---|---|---|
| 命名契约 | `tools.ts::publicToolName` | `mcp__<server>__<rawName>`；规范到 64 字符 `[A-Za-z0-9_-]`；有损整形追加 `sha256(server\0raw)[:12]`；rawName 只上 wire、publicName 永不反解 |
| 两相世代交换 | `tools.ts::syncTools` | phase1 分页 drain cursor（重复 rawName 整代拒绝）；phase2 成功才 dispose 旧代注册新代；命名冲突整代回滚（全有或全无） |
| 动态跟随 | `tools.ts` | `notifications/tools/list_changed` → re-sync；fetch 失败保留上一代 |
| 一 server 一实例 | `index.ts` (cordis 多实例) / `connection.ts` | 每 server 一个连接/生命周期 |
| 结果投影 | `tools.ts` | isError→throw（映射为 pi isError 结果）；文本块按序拼；outputSchema 校验→structuredContent 否则 JsonValue；不静默丢弃 |
| 超时 | `tools.ts` | `toolCallTimeoutMs` 默认 60s，带 abort；非对象参数兜底 `{}` |
| 重连监督 | `connection.ts` | 指数退避 + 预算重置 —— **pi 裁剪：不采纳（懒连接覆盖）** |

## 二、三段式判定门（每个改动必须过）

1. **pi 原生机制**——`pi.registerTool`（运行时注册）+ `pi.setActiveTools`（纯增量激活）+ Anthropic `defer_loading` / OpenAI `tool_search` 锚定（Dynamic Tool Loading）；`pi.on('session_start'/'session_shutdown')`；`pi.getActiveTools()`。pi **无 MCP 客户端**（传输、握手、工具发现、投影）。
2. **dsh 语义**——命名契约 `publicToolName`；两相世代交换 `syncTools`；`list_changed` 跟随 + 失败保留上一代；`toolCallTimeoutMs` 60s；结果投影；一 server 一实例。
3. **pi 裁剪**——核心小 / 最小暴露面 / 用户决策点：deferred 注册（零 prompt 代价）、懒连接（替代常驻重连监督）；**不采纳** codex 描述 1KB 截断、codex/opencode `enabledTools`/`disabledTools`、opencode progress-reset 超时、BM25 打分（用词项打分，零依赖）、OAuth/远程传输（v2 范围外）、权限弹窗桥接（pi 工具执行模型无此通道）。

## 三、设计决策（为什么这样）

- **用 pi 原生 Dynamic Tool Loading 做 deferred**：每个桥接工具注册成真实 pi 工具但 inactive，激活前零 prompt 代价；`mcp` loader 的 `search` 命中后 `setActiveTools([...])` 纯增量激活，pi 下一请求经 `defer_loading`/`tool_search` 锚定 schema，KV-cache 前缀稳定。
- **懒连接**：server 仅首次调用才拉起（dsh 是连接即注册；pi 裁剪为懒——冷启动零子进程零连接）。子进程退出即丢弃 runtime，下次调用懒重连。
- **单 `mcp` loader**：`list / search / describe / call` 四动作，是 pi 原生的"发现 + 激活"形态；`search` 与 `call` 命中后顺带激活对应工具。
- **裁剪非 dsh 微语义**：不做事前工具过滤、不做描述截断、不做 progress-reset——核心小，命名/两相/投影/超时这些 dsh 语义是主体。

## 四、架构（当前实现，packages/*）

| 块 | 职责 | 实现 |
|---|---|---|
| **bridge** | 共享纯函数/类型：`publicToolName`、`resolveMcpServerConfig`、`resolveToolTimeoutMs`、`scoreTools`、`compilableSchema`、`projectToolResult` | `packages/bridge/src/index.ts` |
| **core** | 唯一 pi 扩展宿主：`mcp` loader 工具 + 装配；`config.ts`（加载 mcp.json）、`connection.ts`（ServerManager）、`registry.ts`（DeferredRegistry） | `packages/core/src/*` |

- core 依赖 `@modelcontextprotocol/sdk`（协议客户端）；bridge 纯函数无副作用、零外部依赖（仅 node 内建 + typebox）。

## 五、设计不变量（回退需先改本节）

1. **pi 原生 deferred 形状**——每个桥接工具是真实 pi 工具但保持 inactive；激活纯增量经 `setActiveTools`。
2. **server 懒连接**——冷启动零子进程/连接；`call`/`list` 首次才拉起。
3. **命名契约 = dsh**——`mcp__<server>__<rawName>`，有损规范化追加哈希，publicName 永不反解。
4. **两相世代交换 = dsh**——先抓全量下一代；失败保留上一代（模型只见全有或全无）。
5. **fail-closed**——受限工具面拒绝 MCP 调用；受限制档位无可用后端拒不运行。
6. **与 pi-sandbox-dsh / pi-plan-dsh 完全正交**——不读写它们的状态、无共享类型。

## 六、已知取舍（接受并文档化）

- **懒连接替代 dsh 常驻重连监督**：掉线后下次调用懒重连，不会 crash-loop 无限恢复；代价是长任务中单次掉线不自动重连（由下次调用兜底）。
- **不做描述截断**（dsh 无此语义）：激活进上下文的工具描述可能较长；由 deferred（只在搜索命中后进入）自然限定。
- **不做工具过滤**：无 `enabledTools`/`disabledTools`；要"暴露哪些工具"由 server 自身的 `listTools` 决定（核心小）。
- **不做 OAuth / 远程传输**：仅 stdio；远程/认证留作后续。
- **gate 是纵深防御**：`edit` 不在活动集时拒绝调用；因 plan 已改软引导（不删工具），此 gate 多数场景不触发，仅为 fail-closed 兜底。

## 七、验证与规模

- `npm run typecheck`（strict，全部 workspace）。
- `npm test`：bridge（命名契约 / 配置校验 / 打分 / 投影）；core 端到端（懒连接、命名、回环、list_changed 两相再同步、失败保留上一代），用本地 echo-server，无需 semble。
- 规模参考：2 个包；bridge ~200 行纯函数 + core ~450 行客户端（核心小）。
