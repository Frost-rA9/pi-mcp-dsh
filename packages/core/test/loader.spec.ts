// loader 端到端测试：以 mock pi 实例化扩展，验证 `mcp` loader 的**模型可见**行为。
// 覆盖（本轮新增语义）：
//  - describe {server}：按需带出 server instructions（不进常驻 system prompt，DESIGN 不变量 8）；
//  - call：canonical structuredContent 进 details（不进模型文本）；
//  - failure 路径：未知 server 的 describe 不抛错、给可读提示。
//
// 配置注入：`PI_CODING_AGENT_DIR` 指向临时目录（config.resolveAgentDir），并把 cwd 也切到该目录，
// 避免在仓库里写 `.pi/pi-mcp-dsh-cache.json`。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { type ServerManager } from "../src/connection.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const echoServer = path.join(__dirname, "echo-server.mjs");

let n = 0;
/** 顺序执行（本 spec 共享 activeTools 与同一个 ServerManager，不能并发）。 */
const queue: { index: number; name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  n++;
  queue.push({ index: n, name, fn });
}

// ---- 环境：临时 agent 目录 + 临时 cwd + mcp.json ----
const sandboxDir = mkdtempSync(path.join(tmpdir(), "pi-mcp-dsh-loader-"));
mkdirSync(path.join(sandboxDir, ".pi"), { recursive: true });
writeFileSync(
  path.join(sandboxDir, "mcp.json"),
  JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [echoServer] } } }),
  "utf8",
);
process.env.PI_CODING_AGENT_DIR = sandboxDir;
const originalCwd = process.cwd();
process.chdir(sandboxDir);

// ---- mock pi ----
type ToolDef = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }> };
const tools = new Map<string, ToolDef>();
const handlers = new Map<string, (...a: unknown[]) => unknown>();
let activeTools: string[] = [];

const pi = {
  registerTool: (t: ToolDef) => { tools.set(t.name, t); },
  registerCommand: () => {},
  registerFlag: () => {},
  on: (name: string, h: (...a: unknown[]) => unknown) => { handlers.set(name, h); },
  sendMessage: () => {},
  appendEntry: () => {},
  getActiveTools: () => [...activeTools],
  setActiveTools: (names: string[]) => { activeTools = [...names]; },
  getFlag: () => undefined,
};

const extension = await import("../src/index.ts");
extension.default(pi as never);
const loader = tools.get("mcp");
assert.ok(loader, "mcp loader tool registered");

// 默认活动集：与真实会话一致（gate 要求 `edit` 在活动集内，否则 fail-closed 拒绝 `call`）。
activeTools = ["read", "write", "edit", "bash", "mcp"];

test("describe {server} 按需带出 instructions（不进常驻 prompt）", async () => {
  const r = await loader!.execute("id", { action: "describe", server: "echo" }, undefined, undefined, undefined);
  const text = r.content[0]!.text;
  assert.match(text, /MCP server: echo/);
  assert.match(text, /Tools: \d+/);
  assert.match(text, /echo-server test instructions: call ping before echo\./);
});

test("call 把 canonical structuredContent 放进 details（不进模型文本）", async () => {
  const r = await loader!.execute(
    "id",
    { action: "call", server: "echo", tool: "mcp__echo__echo_structured", args: { message: "hi" } },
    undefined,
    undefined,
    undefined,
  );
  assert.equal(r.content[0]!.text, "text:hi", "model text stays the plain projection");
  assert.deepEqual(r.details.structuredContent, { message: "hi", source: "echo-server" });
  assert.equal(r.details.isError, false);
});

test("describe 未知 server：可读失败、不抛错", async () => {
  const r = await loader!.execute("id", { action: "describe", server: "nope" }, undefined, undefined, undefined);
  assert.match(r.content[0]!.text, /unknown MCP server: nope/);
});

test("session_start 保持 loader 活跃、桥接工具 inactive（零 prompt 代价）", () => {
  activeTools = ["read", "bash", "mcp__echo__ping"];
  (handlers.get("session_start") as () => void)();
  assert.ok(activeTools.includes("mcp"), "loader stays active");
  assert.ok(!activeTools.some((t) => t.startsWith("mcp__")), "bridged tools stay inactive");
  activeTools = ["read", "write", "edit", "bash", "mcp"];
});

test("fail-closed：活动集缺 `edit` 时 `call` 拒绝", async () => {
  activeTools = ["read", "mcp"];
  const r = await loader!.execute(
    "id",
    { action: "call", server: "echo", tool: "mcp__echo__echo_structured", args: { message: "hi" } },
    undefined,
    undefined,
    undefined,
  );
  assert.match(r.content[0]!.text, /Restricted tool surface is active/);
  assert.equal(r.details.denied, true);
  activeTools = ["read", "write", "edit", "bash", "mcp"];
});

// ---- 顺序执行 + 收尾 ----
for (const t of queue) {
  try {
    await t.fn();
    console.log(`ok ${t.index} - ${t.name}`);
  } catch (e) {
    console.error(`not ok ${t.index} - ${t.name}`);
    throw e;
  }
}
const shutdown = handlers.get("session_shutdown") as (() => Promise<void>) | undefined;
if (shutdown) await shutdown();
process.chdir(originalCwd);
rmSync(sandboxDir, { recursive: true, force: true });
console.log(`\n# loader: ${n} tests ran`);
