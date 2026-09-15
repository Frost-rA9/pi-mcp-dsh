# pi-mcp-dsh 设计依据（是什么 / 为什么）

> 本文是**设计依据**（是什么 / 为什么）：定位、参考源锚点、判定门记录、设计决策、架构、不变量、已知取舍。
> **agent 在本目录工作的行为约束见 `AGENTS.md`（本地文件、不入库，故 clone 中不出现）**；本文件按需读：改语义 / 改不变量 / 改参考源语义前。
> 单一参考源 = **dsh mcp-client**（`~/projects/deepseek-harness/packages/mcp/mcp-client/src/`，锚点核对于 HEAD `0d1f50007f` / `0.1.6-alpha.1`）。完整调研 + 实现方案见 `RESEARCH.md`。

---

## 〇、定位与核心命题

- 一个 pi 扩展，把 **MCP server 的工具桥接成真实 pi 工具**（`mcp__<server>__<tool>`），在 pi 原生 Dynamic Tool Loading 上做 deferred 注册。
- 一句话：**pi 核心刻意不内置 MCP 协议客户端**（README Philosophy "No MCP"）；连接 MCP server、发现工具、映射成 pi 工具、结果投影这层活由本扩展承担。
- 这是**跨切面基础设施**（外置工具如何到达模型），**不是** plan/force 那样的引导轴/强制轴——与 pi-sandbox-dsh / pi-plan-dsh 完全正交、互不读写。

## 一、参考源锚点（dsh mcp-client 源码实证）

| dsh 概念 | 源码位置 | 语义要点 |
|---|---|---|
| 命名契约 | `tools.ts::publicToolName` | `mcp__<server>__<rawName>`；规范到 64 字符 `[A-Za-z0-9_-]`；有损整形追加 `sha256(server\0raw)[:12]`；rawName 只上 wire、publicName 永不反解 |
| 两相世代交换 | `tools.ts::syncTools` | phase1 由 **SDK 聚合 `tools/list`**（dsh 新版把分页交给 SDK）；重复 rawName 整代拒绝；phase2 成功才 dispose 旧代、注册新代；命名冲突整代回滚（全有或全无）。**pi 偏离**：自建 drain（含重复 cursor 拒绝的护栏，dsh 已放弃该护栏而跟随 SDK 行为） |
| 动态跟随 | `tools.ts` / `connection.ts` | `notifications/tools/list_changed` → re-sync；fetch 失败保留上一代；**SDK 自动刷新必须关掉**（`listChanged.tools.autoRefresh: false, debounceMs: 0`），re-sync 仍走自家串行链 |
| 一 server 一实例 | `connection.ts` + `tools.ts` | 每 server 一个连接/生命周期；supervisor 把所有 sync（首次/通知/重连）串行化，两个 sync 不可能交错；**pi 版本新增：连接建立单飞**（并发首次调用只拉起一个进程） |
| 无 tools 能力 | `tools.ts::syncTools` | `getServerCapabilities()?.tools === undefined → { tools: [] }`——资源型 server 连接成功、工具集为空，**不报错** |
| 代际关闭 | `connection.ts::closeGeneration` / `settleFailedGeneration` | 关闭操作返回“是否确认关闭”；**无法确认传输关闭 → 直接停止重连**（宁可停也不叠两个 server 进程），报错要求 reload/restart |
| instructions | `connection.ts` + `server-context.ts:33-40` | 每条成功连接产出一段归因后的字面量指令（`### MCP server: <name>`；**pi 侧归因由 loader 结果的 `MCP server: <id>` 行承担**）；`maxInstructionBytes` 默认 **32768**（dsh 含归因）超限即不发布；仅 discovery 成功后发布，dispose/重连耗尽即清空；`interpolate: false`（花括号保持字面量） |
| 结果投影 | `tools.ts::createMcpToolDefinition` | 上游结果先过 SDK spec 校验，**无效即显式错误**；isError→throw（映射为 pi isError 结果）；文本块按序拼；canonical = `{ content, structuredContent? }`；不静默丢弃 |
| 结果适配器 | `tools.ts::createMcpToolDefinition` | 把“上游 schema + 取原始结果的回调”归一成可复用定义（callback 拿得到 execution，含 agent 与 signal）；非 MCP 提供方（Cua Driver）复用它而不开 transport |
| 超时 | `tools.ts` | `toolCallTimeoutMs` 默认 60s，带 abort，**同时覆盖工具调用与 resource 请求**；非对象参数兜底 `{}` |
| 协议协商 | `package.json` + `connection.ts` | 依赖 `@modelcontextprotocol/client@2.0.0`；`versionNegotiation: { mode: 'auto' }`（可用则 2026-07-28，否则回落旧修订；stdio 协商会先起一个临时 probe 进程）——**pi 偏离：仍在 `@modelcontextprotocol/sdk@1.30`（下一步候选）** |
| resources | `mcp-resources` | **3 个共享工具**（`list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`，均带显式 `server` 参数）+ 服务器名 prompt 段；与 server 是否声明 resources 能力无关；blob→`[binary resource: N base64 characters; …]`——**pi 未采纳（下一步候选）** |
| 重连监督 | `connection.ts` | 指数退避 + 预算重置 —— **pi 裁剪：不采纳（懒连接覆盖）** |

## 二、三段式判定门（每个改动必须过）

1. **pi 原生机制**——`pi.registerTool`（运行时注册）+ `pi.setActiveTools`（纯增量激活）+ Anthropic `defer_loading` / OpenAI `tool_search` 锚定（Dynamic Tool Loading）；`pi.on('session_start'/'session_shutdown')`；`pi.getActiveTools()`。pi **无 MCP 客户端**（传输、握手、工具发现、投影）。
2. **dsh 语义**——命名契约 `publicToolName`；两相世代交换 `syncTools`；`list_changed` 跟随 + 失败保留上一代；无 tools 能力 = 空集；instructions（有界发布）；结果投影（SDK spec 校验 + canonical 值）；`toolCallTimeoutMs` 60s；一 server 一实例 + sync 串行。
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
7. **一 server 一 runtime + 连接建立单飞**——同一 server 的并发首次调用只拉起一个连接/子进程（dsh「每 server 一个连接 + sync 串行」的 pi 版）；建立失败不缓存失败结果（下次调用重试）。
8. **instructions 只按需出现**——server 指令**不进常驻 system prompt**（dsh 用 `systemPrompt.section` 每次 assembly 注入；pi 裁剪为 loader `describe` 按需带出，零常驻代价），且超过字节上限即**不发布内容**（保留 server 可用）。

## 六、已知取舍（接受并文档化）

- **懒连接替代 dsh 常驻重连监督**：掉线后下次调用懒重连，不会 crash-loop 无限恢复；代价是长任务中单次掉线不自动重连（由下次调用兜底）。
- **不做描述截断**（dsh 无此语义）：激活进上下文的工具描述可能较长；由 deferred（只在搜索命中后进入）自然限定。
- **不做工具过滤**：无 `enabledTools`/`disabledTools`；要"暴露哪些工具"由 server 自身的 `listTools` 决定（核心小）。
- **不做 OAuth / 远程传输**：仅 stdio；远程/认证留作后续。
- **gate 是纵深防御**：`edit` 不在活动集时拒绝调用；因 plan 已改软引导（不删工具），此 gate 多数场景不触发，仅为 fail-closed 兜底。
- **instructions 超限 = 不发布 + 说明**（dsh 是拒绝连接）：32768 字节上限对齐 dsh `maxInstructionBytes` 默认值；pi 侧改为在 loader 结果里报告被省略及字节数，不让一个啰嗦的 server 变成不可用。
- **不做 resources 桥**（dsh `mcp-resources` 的 3 个共享工具 + 服务器名 prompt 段）：**下一步候选**。落地前需先定形——共享工具（dsh 形）与 pi 的 deferred/按名激活模型不同，且 blob→描述 的渲染规则要单独定。
- **不迁移 `@modelcontextprotocol/client@2.0.0`**（最新已发布）：**下一步候选**。收益是协议协商（2026-07-28 + 旧修订回落）、SDK 自持分页/校验、官方 spec 类型；代价是连接层重写（`versionNegotiation`、stdio probe 进程、`cacheMode`、`toolDefinition` 参数）且**必须显式设 `autoRefresh: false`**，否则与两相世代交换打架。
- **不采纳 dsh「关闭无法确认 → 停止重连」**：该规则属于 dsh 的重连监督器；pi 无监督器（懒连接），且 1.x SDK 的 `close()` 已是 stdin 结束 → SIGTERM → SIGKILL，几乎不产生残留进程。若将来迁移 SDK 2.0 或引入监督器，需重新评估（不变量 7 的单飞是当前等价物）。
- **`structuredContent` 只进 pi `details`**：canonical `{ content, structuredContent? }` 的后者不进模型文本（零 prompt 代价），只供宿主/程序化使用；模型可见部分仍是展平文本。

## 七、验证与规模

- `npm run typecheck`（strict，全部 workspace）。
- `npm test`：bridge（命名契约 / 配置校验 / 打分 / 投影，含 canonical `structuredContent`）；core 端到端（无 tools 能力 = 空集、连接建立单飞、懒连接、命名、回环、`list_changed` 两相再同步、失败保留上一代、instructions 按需与超限不发布），用本地 echo-server / pid-server，无需 semble。
- 规模参考：2 个包；bridge ~200 行纯函数 + core ~450 行客户端（核心小）。
