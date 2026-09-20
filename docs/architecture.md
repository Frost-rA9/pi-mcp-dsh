# pi-mcp-dsh · 架构（精简）

> 把 **MCP server 的工具桥接成真实 pi 工具**（`mcp__<server>__<tool>`），在 pi 原生 **Dynamic Tool Loading** 上做 **deferred 注册**。
> pi 核心刻意不内置 MCP 客户端（传输/握手/发现/投影由本扩展承担）——这是**跨切面基础设施**，与 `pi-sandbox-dsh` / `pi-plan-dsh` 完全正交。
> 单一参考源 = dsh `packages/mcp/mcp-client`；锚点 `ddefc45fbc`（本轮重核：`mcp-client/src/` **零变更**，仅 package.json 版本与 tests/http-fixture.ts 夹具）。行为约束见 `AGENTS.md`（本地文件、不入库）。

## pi 机制映射

| 需求 | pi 原生机制 |
|---|---|
| 桥接工具 | `registerTool`（每个 MCP 工具 = 真实 pi 工具，但 **inactive**） |
| 发现 + 激活 | 单个 `mcp` loader 工具（`list / search / describe / call`）；命中后 `setActiveTools([...])` **纯增量**激活 |
| 零常驻 prompt 代价 | 激活前工具不在上下文；激活经 `defer_loading` / `tool_search` 锚定 schema（KV 前缀稳定） |
| 指令按需 | `mcp` loader 的 `describe` 结果里带 server instructions（**不进常驻 system prompt**） |
| 生命周期 | `session_start` / `session_shutdown`：保持 loader 活跃、桥接工具 inactive |

## 结构

| 块 | 职责 | 实现 |
|---|---|---|
| bridge | 纯函数/类型：`publicToolName`、`resolveMcpServerConfig`、`resolveToolTimeoutMs`、`scoreTools`、`compilableSchema`、`projectToolResult` | `packages/bridge/src/index.ts` |
| core | 扩展宿主：`mcp` loader + 装配、`config.ts`（`mcp.json`）、`connection.ts`（ServerManager，懒连接/单飞）、`registry.ts`（DeferredRegistry，两相世代交换） | `packages/core/src/*` |

core 依赖 `@modelcontextprotocol/sdk`（协议客户端）；bridge 零外部依赖（node 内建 + typebox）。

## 关键语义（对齐 dsh）

- **命名契约**：`mcp__<server>__<rawName>`；规范到 64 字符 `[A-Za-z0-9_-]`，有损整形追加 `sha256(server\0raw)[:12]`；rawName 只上 wire，**publicName 永不反解**。
- **两相世代交换**：先抓全量下一代（phase1）→ 成功才 dispose 旧代、注册新代（phase2）；重复 rawName / 命名冲突 → **整代拒绝**（模型只见全有或全无，失败保留上一代）。
- **懒连接**：server 仅首次 `call`/`list` 才拉起（冷启动零子进程）；**一 server 一 runtime + 连接建立单飞**（并发首次调用只拉起一个进程）；建立失败不缓存。
- **动态跟随**：`notifications/tools/list_changed` → re-sync；SDK 自动刷新关掉（`autoRefresh: false`），re-sync 走自家串行链。
- **能力缺省**：`capabilities.tools === undefined` → 工具集为空，**连接成功且不报错**。
- **结果投影**：上游结果先过 SDK spec 校验（无效 → 显式错误，不静默丢弃）；`isError` → throw（映射为 pi isError）；canonical `{ content, structuredContent? }`，后者**只进 pi `details`**（不进模型文本）。
- **超时**：`toolCallTimeoutMs` 默认 60s，带 abort，覆盖工具调用与 resource 请求。

## 不变量（回退先改这里）

1. **pi 原生 deferred 形状**：真实工具但 inactive，激活纯增量经 `setActiveTools`。
2. **server 懒连接**：冷启动零子进程/连接。
3. **命名契约 = dsh**（有损规范化追加哈希，publicName 永不反解）。
4. **两相世代交换 = dsh**（全有或全无，失败保留上一代）。
5. **fail-closed**：活动集缺 `edit` 时 `call` 拒绝；无可用档位后端不跑。
6. **与另两个扩展完全正交**（不读写其状态、无共享类型）。
7. **一 server 一 runtime + 连接建立单飞**。
8. **instructions 只按需出现**：不进常驻 prompt；超过上限（32768 字节）即**不发布内容**（保留 server 可用）。

## 已知取舍 / 边界

- **懒连接替代 dsh 常驻重连监督**：掉线后下次调用懒重连，不 crash-loop；代价是长任务中单次掉线不自动恢复。
- 不做描述截断、不做 `enabledTools`/`disabledTools` 过滤、不做 progress-reset 超时、不做 OAuth/远程传输（仅 stdio）。
- **暂不迁 `@modelcontextprotocol/client@2.0.0`**（本仓仍在 `sdk@1.30`）：2.0 `auto` 协商会先起临时 probe 进程（与本仓"一 server 一进程"冲突）；若迁则不要用 `auto`。
- **暂不做 resources 桥**（dsh 3 个共享工具 + 服务器名 prompt 段）：本机在用的 server 实测 `resources/list` 与 `templates/list` 均为 0，做出来只会返回空。
- **MCP server 在 workspace 外写状态时，受限档位下连不上**（如 `uvx` 型 server 写 `~/.cache/uv` → `Read-only file system` 连接关闭）：不是 bug，排障先看这一点（把缓存目录指到工作区内，或显式放宽档位）。

## 验证

- `npm run typecheck`（strict）
- `npm test`：bridge（命名 / 配置 / 打分 / 投影）+ core 端到端（无 tools 能力 = 空集、连接单飞、懒连接、`list_changed` 两相再同步、失败保留上一代、instructions 按需与超限不发布），用本地 echo-server / pid-server，无需外部 server
