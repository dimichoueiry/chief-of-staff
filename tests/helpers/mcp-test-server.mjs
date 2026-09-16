/**
 * A tiny stdio MCP server, so tests can exercise the whole connection path for real:
 * spawn, handshake, list tools, call one, and check that only the named variable was passed.
 * Lives in the repo rather than a temp folder so it can resolve the SDK.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "test-kit", version: "1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "  Says   back what you gave it.  ",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      annotations: { readOnlyHint: true },
    },
    { name: "whoami", description: "The token it was given.", inputSchema: { type: "object", properties: {} } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const text =
    req.params.name === "whoami"
      ? `${process.env.TEST_KIT_TOKEN ?? "(none)"}|${process.env.ANTHROPIC_API_KEY ?? "(none)"}`
      : String(req.params.arguments?.text ?? "");
  return { content: [{ type: "text", text }] };
});

await server.connect(new StdioServerTransport());
