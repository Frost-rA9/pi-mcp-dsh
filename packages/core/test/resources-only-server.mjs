// Minimal stdio MCP server that declares ONLY the `resources` capability — no tools.
// Run: node test/resources-only-server.mjs
//
// 用途：验证 dsh 的「server 未声明 tools 能力 = 空集」语义（`getServerCapabilities()?.tools === undefined`）。
// 连接必须成功、工具集为空、不报错；若桥仍无条件 tools/list，本 fixture 会让连接失败。
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListResourcesRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "resources-only-server", version: "0.1.0" },
  { capabilities: { resources: {} }, instructions: "resources-only-server instructions" },
);

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));

const transport = new StdioServerTransport();
await server.connect(transport);
