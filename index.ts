import { parseConfig } from "./config.js";
import { McpClientPool } from "./mcp-client.js";

export default async function (api: any) {
  const config = parseConfig(api.pluginConfig);

  if (config.servers.length === 0) {
    console.log("[mcp-adapter] No servers configured");
    return;
  }

  const pool = new McpClientPool();

  for (const server of config.servers) {
    try {
      console.log(`[mcp-adapter] Connecting to ${server.name}...`);
      await pool.connect(server);

      const tools = await pool.listTools(server.name);
      console.log(`[mcp-adapter] ${server.name}: found ${tools.length} tools`);

      for (const tool of tools) {
        const toolName = config.toolPrefix ? `${server.name}_${tool.name}` : tool.name;

        api.registerTool({
          name: toolName,
          description: tool.description ?? `Tool from ${server.name}`,
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
          async execute(_id: string, params: unknown) {
            const result = await pool.callTool(server.name, tool.name, params);
            const text = result.content
              ?.map((c: any) => c.text ?? c.data ?? "")
              .join("\n") ?? "";
            return {
              content: [{ type: "text", text }],
              isError: result.isError,
            };
          },
        });

        console.log(`[mcp-adapter] Registered: ${toolName}`);
      }
    } catch (err) {
      console.error(`[mcp-adapter] Failed to connect to ${server.name}:`, err);
    }
  }
}
