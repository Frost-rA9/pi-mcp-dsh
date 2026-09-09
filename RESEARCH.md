# 调研报告：dsh mcp-client 的 MCP 实现与 pi-mcp-dsh 落地

> 调研日期：2026-09-10。服务于 `pi-mcp-dsh`（以 dsh 为**单一参考源**新写的 MCP 桥扩展）。
> 材料来源：`~/projects/deepseek-harness/packages/mcp/mcp-client/src/`（4 个源文件，semble 语义检索 + 直读）。
> 对照：`pi-mcp-bridge` 旧桥（曾以四家为参考、混取语义）。

## 0. 材料来源与版本

| 来源 | 代码 | 依据 |
|---|---|---|
| **dsh** (deepseek-ai/deepseek-harness) | 开源（TS/Cordis） | `packages/mcp/mcp-client/src/{index,connection,tools,transport}.ts` + `docs/subsystems/tools.md` |

## 1. dsh mcp-client 语义（单一参考源）

dsh 把每个 MCP server 作为**一个插件实例**接入（cordis 多实例），Cordis 的 effect 域管理生命周期；HMR 热替换时按 `serverName` 复现同名工具。核心语义：

### 1.1 命名契约（`tools.ts::publicToolName`）
- 模型可见公共名 = `mcp__<server>__<rawName>`；规范到 **64 字符** `[A-Za-z0-9_-]`；一旦有损整形（字符替换 / 截断）就追加 `sha256(server\0raw)[:12]` 防碰撞。
- **纯函数、连接顺序无关**。**rawName 只上 wire**（`tools/call`），publicName 永不解析回 rawName。

### 1.2 两相世代交换（`tools.ts::syncTools`）
- **phase1**：分页拉全量（drain cursor）；重复 rawName → 整代拒绝。
- **phase2**：成功后**才** dispose 上一代并注册新一代；注册冲突（外族占用命名空间）→ 整代回滚。
- 结论：模型只见**全有或全无**，绝不出现半套工具集。

### 1.3 动态跟随
- `notifications/tools/list_changed` → re-sync；fetch 失败**保留上一代**。

### 1.4 结果投影
- `isError` → throw（ToolRuntime catch 路径产生 isError 结果）；文本块按序拼接。
- 图片仅在挂接 `ctx.attachments` 且模型路由声明支持图像时才解码落盘（整批先校验后入）。
- `outputSchema` 可校验则约束 `structuredContent`，不可校验退化 `JsonValue`；不支持块变诊断文本，不静默丢弃。

### 1.5 超时
- `toolCallTimeoutMs` 默认 60s，带 abort；模型参数非对象时兜底 `{}` 让 server 产出具体参数错误（教学性错误）。

### 1.6 重连监督（connection.ts）
- 指数退避（500ms→30s 封顶）＋每次中断 10 次预算＋稳定运行超过 maxDelay 重置预算（crash-loop 有穷放弃）；失败即注销工具。

## 2. 对 pi-mcp-dsh 的落地（三段式）

- **第一段（pi 原生）**：pi 的 Dynamic Tool Loading（`registerTool` 运行时可注册＋`setActiveTools` 纯增量激活＋Anthropic `defer_loading`/OpenAI `tool_search` 原生锚定）是「deferred 发现」在 pi 里的官方等价物；pi-ai 对裸 JSON Schema 有专门分支，MCP inputSchema 可原样注册。**pi 核心无 MCP 协议客户端**，因而传输/握手/发现/投影必由扩展承担。
- **第二段（dsh 语义）**：采纳——命名契约（`publicToolName` + 64 字符 + sha256 防碰撞）、两相世代交换（`syncTools`）、`list_changed` 跟随 + 失败保留上一代、60s 超时、结果投影（isError→pi isError 结果、文本块拼序、不静默丢弃）、一 server 一实例。
- **第三段（pi 裁剪）**：不采纳——常驻重连监督（懒连接覆盖）、OAuth/远程传输（v2 范围外）、权限弹窗桥接（pi 工具执行模型无此通道）；**不采纳 codex/opencode 的非 dsh 语义**（描述 1KB 截断、`enabledTools`/`disabledTools`、opencode progress-reset 超时）；零依赖打分（词项打分替代 BM25）。

### dsh mcp-client → pi-mcp-dsh 映射

| dsh | pi-mcp-dsh |
|---|---|
| `tools.ts::publicToolName` | `packages/bridge/src/index.ts::publicToolName` |
| `tools.ts::syncTools` | `core/src/connection.ts::fetchTools/resync` + `registry.ts::onManagerToolsChanged`（两相） |
| `connection.ts`（生命周期 / 重连监督） | `core/src/connection.ts::ensureConnected`（懒连接，裁剪掉重连监督） |
| `tools.ts` 结果投影 | `bridge::projectToolResult`（isError 映射、文本拼序、不静默丢弃） |
| `index.ts`（corlds 多实例） | `core/src/connection.ts::ServerManager`（一 server 一 runtime） |
| `toolCallTimeoutMs` | `bridge::resolveToolTimeoutMs`（默认 60s，abort） |
| — | `core/src/registry.ts`（pi 原生 Dynamic Tool Loading deferred 注册 + 增量激活） |
| — | `core/src/index.ts`（`mcp` loader 工具 list/search/describe/call） |

## 3. 与 pi-mcp-bridge 的关系
`pi-mcp-bridge` 曾以四家为参考、混取 dsh + codex + opencode 微语义（描述截断、工具过滤、progress-reset 超时）；本扩展改为**以 dsh 为单一参考源新写**，结构上与 `pi-sandbox-dsh`/`pi-plan-dsh` 同构（根 index + `packages/core` + `packages/bridge`），并裁剪掉非 dsh 微语义。旧桥可视为被本扩展取代（见索引 README）。
