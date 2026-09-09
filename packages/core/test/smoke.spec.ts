// core 冒烟测试：ServerManager 端到端（单参考源 dsh 语义）。
// 用本地 echo MCP server，无需 semble。
// 验证：命名契约、惰性连接、回环调用、两相世代交换（list_changed 后 greet 出现）、
//       失败保留上一代。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ServerManager } from "../src/connection.ts";
import { publicToolName } from "pi-mcp-dsh-bridge";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const echoServer = path.join(__dirname, "echo-server.mjs");

let n = 0;
function test(name: string, fn: () => void | Promise<void>): void {
  n++;
  const run = async () => {
    await fn();
    console.log(`ok ${n} - ${name}`);
  };
  // simple sequential runner
  results.push(run().then(() => true, (e) => { console.error(`not ok ${n} - ${name}`); throw e; }));
}
const results: Promise<boolean>[] = [];

function makeManager(): ServerManager {
  return new ServerManager(
    {
      echo: { command: process.execPath, args: [echoServer] },
    },
    { cacheFile: "" },
  );
}

// ---- 命名契约（经 manager 摄入后） ----
test("connect 后工具命名 mcp__echo__*（dsh publicToolName）", async () => {
  const m = makeManager();
  assert.equal(m.connectionCount(), 0);
  const tools = await m.connect("echo");
  assert.ok(tools.length >= 3);
  const names = new Set(tools.map((t) => t.publicName));
  assert.ok(names.has("mcp__echo__echo"));
  assert.ok(names.has("mcp__echo__ping"));
  assert.ok(names.has("mcp__echo__sleep_ms"));
  assert.equal(m.connectionCount(), 1, "lazy connect spawns one subprocess");
  await m.disconnectAll();
});

// ---- 回环调用 ----
test("call echo 回环返回原文", async () => {
  const m = makeManager();
  const r = await m.call("echo", "mcp__echo__echo", { message: "hello" });
  assert.equal(r.text, "hello");
  assert.equal(r.isError, false);
  await m.disconnectAll();
});

// ---- 惰性连接：未 call 前 0 个子进程 ----
test("缓存工具不产生连接（connectionCount 0）", async () => {
  const m = makeManager();
  assert.equal(m.connectionCount(), 0);
  assert.deepEqual(m.cachedTools("echo"), []);
  // 首次 call 才拉起
  const r = await m.call("echo", "mcp__echo__ping", {});
  assert.equal(r.text, "pong");
  assert.equal(m.connectionCount(), 1);
  await m.disconnectAll();
});

// ---- 两相世代交换：list_changed 后 greet 出现 ----
test("list_changed 触发两相再同步，greet 出现且保留上一代", async () => {
  const m = makeManager();
  await m.connect("echo");
  assert.ok(!m.cachedTools("echo").some((t) => t.name === "greet"), "greet 初始不存在");

  // 触发 server 增发 list_changed + 加入 greet
  await m.call("echo", "mcp__echo__trigger_list_changed", {});
  // 等待异步 re-sync 完成
  await new Promise((r) => setTimeout(r, 200));
  await m.resync("echo");
  const tools = m.cachedTools("echo");
  assert.ok(tools.some((t) => t.name === "greet"), "greet 出现在再同步后的代际");
  await m.disconnectAll();
});

// ---- 失败保留上一代：对未知 server 的 resync 不崩 ----
test("resync 失败保留上一代（不抛错）", async () => {
  const m = makeManager();
  await m.connect("echo");
  const before = m.cachedTools("echo");
  // 用一个未连接的 server 调 resync：静默返回
  await m.resync("nonexistent");
  assert.deepEqual(m.cachedTools("echo"), before);
  await m.disconnectAll();
});

await Promise.all(results);
console.log(`\n# core: ${n} tests ran`);
