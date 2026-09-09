// bridge 纯函数测试：命名契约、配置校验、打分、结果投影。
// 单一参考源 = dsh mcp-client（publicToolName / resolveConfig / 结果投影）。
import assert from "node:assert/strict";
import {
  MCP_NAMESPACE_PREFIX,
  MAX_PUBLIC_NAME_LENGTH,
  publicToolName,
  resolveMcpServerConfig,
  resolveToolTimeoutMs,
  scoreTools,
  projectToolResult,
  type McpServerConfig,
} from "../src/index.ts";

let n = 0;
function test(name: string, fn: () => void): void {
  n++;
  fn();
  console.log(`ok ${n} - ${name}`);
}

// ---- publicToolName ----
test("publicToolName 干净名保持原样", () => {
  assert.equal(publicToolName("semble", "search"), `${MCP_NAMESPACE_PREFIX}semble__search`);
  assert.equal(publicToolName("git", "list"), "mcp__git__list");
});

test("publicToolName 非法字符替换为下划线并追加哈希（dsh lossy 语义）", () => {
  // rawName "list files"：空格→下划线是有损规范化 → 追加哈希防撞
  const out = publicToolName("semble", "list files");
  assert.ok(out.startsWith("mcp__semble__list_files_"), out);
  assert.ok(out.length <= MAX_PUBLIC_NAME_LENGTH, "within 64 chars");
});

test("publicToolName 超长名截断且追加哈希、不坍缩", () => {
  const long = "a".repeat(80);
  const a = publicToolName("srv", long);
  const b = publicToolName("srv", `${long}x`);
  assert.ok(a.length <= MAX_PUBLIC_NAME_LENGTH, `length ${a.length}`);
  assert.ok(a.includes("_"), "appends hash suffix after truncation");
  assert.notEqual(a, b, "distinct identities must not collapse");
});

test("publicToolName 不同 (server,raw) 组合恒不同", () => {
  assert.notEqual(publicToolName("a", "x"), publicToolName("b", "x"));
  assert.notEqual(publicToolName("a", "x"), publicToolName("a", "y"));
});

// ---- resolveMcpServerConfig ----
test("resolveMcpServerConfig 合法配置原样通过", () => {
  const cfg: McpServerConfig = { command: "uvx", args: ["--from", "semble[mcp]", "semble"], toolTimeoutSec: 120 };
  const out = resolveMcpServerConfig("semble", cfg);
  assert.equal(out.command, "uvx");
  assert.equal(out.toolTimeoutSec, 120);
});

test("resolveMcpServerConfig 缺 command 拒绝", () => {
  assert.throws(() => resolveMcpServerConfig("s", {} as McpServerConfig), /command/);
});

test("resolveMcpServerConfig 未知键拒绝（对齐 dsh resolveConfig）", () => {
  assert.throws(() => resolveMcpServerConfig("s", { command: "x", enabledTools: ["a"] } as McpServerConfig), /unknown key/);
});

test("resolveToolTimeoutMs 默认 60s，显式覆盖", () => {
  assert.equal(resolveToolTimeoutMs({ command: "x" }), 60_000);
  assert.equal(resolveToolTimeoutMs({ command: "x", toolTimeoutSec: 30 }), 30_000);
});

// ---- scoreTools ----
test("scoreTools 精确名加成、按分排序", () => {
  const all = [
    { server: "s", name: "search", publicName: "mcp__s__search", description: "find code" },
    { server: "s", name: "edit_file", publicName: "mcp__s__edit_file", description: "edit code" },
  ] as const;
  const hits = scoreTools([...all], "search");
  assert.equal(hits[0]?.name, "search");
  assert.ok(hits[0]!.score > 0);
});

test("scoreTools 空查询返回空", () => {
  assert.deepEqual(scoreTools([], "  "), []);
});

// ---- projectToolResult ----
test("projectToolResult 文本块按序拼接", () => {
  const r = projectToolResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] });
  assert.equal(r.text, "a\nb");
  assert.equal(r.isError, false);
});

test("projectToolResult 非文本块 JSON 序列化 + 是错误则标记", () => {
  const r = projectToolResult({ isError: true, content: [{ type: "text", text: "boom" }] });
  assert.equal(r.text, "boom");
  assert.equal(r.isError, true);
});

console.log(`\n# bridge: ${n} tests passed`);
