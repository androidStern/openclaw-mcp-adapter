import { parseConfig } from "./config.js";
import { McpClientPool } from "./mcp-client.js";

interface ToolCacheEntry {
  toolName: string;
  serverName: string;
  originalName: string;
  description: string;
  parameters: unknown;
}

// Module-level globals that persist across registry instantiations.
//
// OpenClaw caches plugin registries by workspaceDir. When an agent has a
// per-agent workspace it receives a brand-new registry at request time, but
// start() is only invoked once during gateway boot on the *first* registry.
// All subsequent registries therefore never call start(), which means tools
// appear registered but every call fails silently with "Tool not available".
//
// Keeping the pool and a descriptor cache at module scope lets us skip the
// full service lifecycle for those later registries: we simply re-register
// the already-connected tools straight into the new api instance.
let globalPool: McpClientPool | null = null;
let globalToolCache: ToolCacheEntry[] = [];

export default function (api: any) {
  const config = parseConfig(api.pluginConfig);

  if (config.servers.length === 0) {
    console.log("[mcp-adapter] No servers configured");
    return;
  }

  // Fast path: a pool is already running from a previous registry instantiation.
  // Re-register every cached tool into this new registry and return early —
  // no new connections, no service lifecycle.
  if (globalPool && globalToolCache.length > 0) {
    console.log(`[mcp-adapter] Re-registering ${globalToolCache.length} cached tools for new registry`);
    for (const entry of globalToolCache) {
      api.registerTool({
        name: entry.toolName,
        description: entry.description,
        parameters: entry.parameters,
        async execute(_id: string, params: unknown) {
          const result = await globalPool!.callTool(entry.serverName, entry.originalName, params);
          const text = result.content
            ?.map((c: any) => c.text ?? c.data ?? "")
            .join("\n") ?? "";
          return {
            content: [{ type: "text", text }],
            isError: result.isError,
          };
        },
      });
    }
    return;
  }

  const pool = new McpClientPool();

  // Use service lifecycle - connections only happen when gateway starts
  api.registerService({
    id: "mcp-adapter",

    async start() {
      globalPool = pool;

      for (const server of config.servers) {
        try {
          console.log(`[mcp-adapter] Connecting to ${server.name}...`);
          await pool.connect(server);

          const tools = await pool.listTools(server.name);
          console.log(`[mcp-adapter] ${server.name}: found ${tools.length} tools`);

          for (const tool of tools) {
            const toolName = config.toolPrefix ? `${server.name}_${tool.name}` : tool.name;
            const description = tool.description ?? `Tool from ${server.name}`;
            const parameters = tool.inputSchema ?? { type: "object", properties: {} };

            api.registerTool({
              name: toolName,
              description,
              parameters,
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

            // Cache tool metadata so subsequent per-agent registry instances
            // can re-register without going through the service lifecycle again.
            globalToolCache.push({
              toolName,
              serverName: server.name,
              originalName: tool.name,
              description,
              parameters,
            });

            console.log(`[mcp-adapter] Registered: ${toolName}`);
          }
        } catch (err) {
          console.error(`[mcp-adapter] Failed to connect to ${server.name}:`, err);
        }
      }
    },

    async stop() {
      console.log("[mcp-adapter] Shutting down...");
      await pool.closeAll();
      globalPool = null;
      globalToolCache = [];
      console.log("[mcp-adapter] All connections closed");
    },
  });
}
