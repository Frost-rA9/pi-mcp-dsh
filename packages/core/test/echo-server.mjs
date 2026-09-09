// Minimal stdio MCP server used to validate pi-mcp-dsh WITHOUT needing Semble.
// Run: node test/echo-server.mjs
//
// Test surface:
//  - echo / ping: basic call round-trip
//  - sleep_ms: long-running call for abort/timeout tests
//  - trigger_list_changed: adds `greet`, then emits notifications/tools/list_changed
//    so the bridge's two-phase re-sync can be exercised end to end.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

let greetAdded = false;

const tools = () => {
  const base = [
    {
      name: "echo",
      description: "Echo the provided message back verbatim.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string", description: "Message to echo" } },
        required: ["message"],
      },
    },
    {
      name: "ping",
      description: "Return the string 'pong'.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "sleep_ms",
      description: "Sleep for the given number of milliseconds, then report it.",
      inputSchema: {
        type: "object",
        properties: { ms: { type: "number", description: "Milliseconds to sleep" } },
        required: ["ms"],
      },
    },
    {
      name: "trigger_list_changed",
      description: "Add the greet tool, then emit notifications/tools/list_changed.",
      inputSchema: { type: "object", properties: {} },
    },
  ];
  if (greetAdded) {
    base.push({
      name: "greet",
      description: "Greet a person by name (appears only after list_changed).",
      inputSchema: { type: "object", properties: { name: { type: "string" } } },
      required: ["name"],
    });
  }
  return base;
};

const server = new Server(
  { name: "echo-server", version: "0.2.0" },
  { capabilities: { tools: { listChanged: true } } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools() }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  if (name === "echo") {
    return { content: [{ type: "text", text: args.message ?? "" }] };
  }
  if (name === "ping") {
    return { content: [{ type: "text", text: "pong" }] };
  }
  if (name === "sleep_ms") {
    const ms = typeof args.ms === "number" ? args.ms : 100;
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { content: [{ type: "text", text: `slept ${ms}ms` }] };
  }
  if (name === "greet") {
    return { content: [{ type: "text", text: `hello, ${args.name ?? "stranger"}!` }] };
  }
  if (name === "trigger_list_changed") {
    if (!greetAdded) {
      greetAdded = true;
      await server.notification({ method: "notifications/tools/list_changed" });
    }
    return { content: [{ type: "text", text: "list_changed notification sent" }] };
  }
  return {
    content: [{ type: "text", text: `unknown tool: ${name}` }],
    isError: true,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
