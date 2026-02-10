import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ServerConfig } from "./config.js";

interface ToolSchema {
  type?: string;
  properties?: Record<string, { type?: string }>;
  required?: string[];
}

interface ClientEntry {
  config: ServerConfig;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  connected: boolean;
  toolSchemas: Map<string, ToolSchema>;
}

export class McpClientPool {
  private clients = new Map<string, ClientEntry>();

  async connect(config: ServerConfig): Promise<Client> {
    const client = new Client({ name: "openclaw-mcp-adapter", version: "0.1.0" });
    const transport = this.createTransport(config);

    await client.connect(transport);

    // Watch for stdio process exit
    if (transport instanceof StdioClientTransport) {
      transport.onerror = (err) => {
        console.error(`[mcp-adapter] ${config.name} error:`, err);
        this.markDisconnected(config.name);
      };
      transport.onclose = () => {
        console.log(`[mcp-adapter] ${config.name} disconnected`);
        this.markDisconnected(config.name);
      };
    }

    this.clients.set(config.name, { config, client, transport, connected: true, toolSchemas: new Map() });
    return client;
  }

  private createTransport(config: ServerConfig) {
    if (config.transport === "http") {
      return new StreamableHTTPClientTransport(new URL(config.url!), {
        requestInit: { headers: config.headers },
      });
    }
    return new StdioClientTransport({
      command: config.command!,
      args: config.args,
      env: config.env,
    });
  }

  async listTools(serverName: string) {
    const entry = this.clients.get(serverName);
    if (!entry) throw new Error(`Unknown server: ${serverName}`);
    const result = await entry.client.listTools();
    for (const tool of result.tools) {
      if (tool.inputSchema) {
        entry.toolSchemas.set(tool.name, tool.inputSchema as ToolSchema);
      }
    }
    return result.tools;
  }

  async callTool(serverName: string, toolName: string, args: unknown) {
    const entry = this.clients.get(serverName);
    if (!entry) throw new Error(`Unknown server: ${serverName}`);

    this.warnOnSchemaViolations(serverName, toolName, args, entry.toolSchemas);

    try {
      return await entry.client.callTool({ name: toolName, arguments: args as Record<string, unknown> });
    } catch (err) {
      if (!entry.connected || this.isConnectionError(err)) {
        await this.reconnect(serverName);
        const newEntry = this.clients.get(serverName);
        if (!newEntry) throw new Error(`Failed to reconnect to ${serverName}`);
        return await newEntry.client.callTool({ name: toolName, arguments: args as Record<string, unknown> });
      }
      throw err;
    }
  }

  private async reconnect(serverName: string) {
    const entry = this.clients.get(serverName);
    if (!entry) return;

    console.log(`[mcp-adapter] Reconnecting to ${serverName}...`);
    try { await entry.transport.close?.(); } catch (err) {
      console.warn(`[mcp-adapter] ${serverName} close error during reconnect:`, err);
    }
    this.clients.delete(serverName);
    await this.connect(entry.config);
    console.log(`[mcp-adapter] Reconnected to ${serverName}`);
  }

  private markDisconnected(serverName: string) {
    const entry = this.clients.get(serverName);
    if (entry) entry.connected = false;
  }

  private warnOnSchemaViolations(
    serverName: string, toolName: string, args: unknown, schemas: Map<string, ToolSchema>,
  ) {
    const schema = schemas.get(toolName);
    if (!schema || typeof args !== "object" || args === null) return;

    const obj = args as Record<string, unknown>;
    const prefix = `[mcp-adapter] ${serverName}/${toolName}`;

    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in obj)) {
          console.warn(`${prefix}: missing required field "${field}"`);
        }
      }
    }

    if (schema.properties) {
      for (const [field, prop] of Object.entries(schema.properties)) {
        if (field in obj && prop.type && obj[field] !== null && obj[field] !== undefined) {
          const actual = typeof obj[field];
          const expected = prop.type === "integer" ? "number" : prop.type;
          if (actual !== expected) {
            console.warn(`${prefix}: field "${field}" expected ${prop.type}, got ${actual}`);
          }
        }
      }
    }
  }

  private isConnectionError(err: unknown): boolean {
    const msg = String(err);
    return msg.includes("closed") || msg.includes("ECONNREFUSED") || msg.includes("EPIPE")
      || msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET")
      || msg.includes("ENOTFOUND") || msg.includes("EHOSTUNREACH");
  }

  getStatus(serverName: string) {
    const entry = this.clients.get(serverName);
    return { connected: entry?.connected ?? false };
  }

  async close(serverName: string) {
    const entry = this.clients.get(serverName);
    if (!entry) return;

    try {
      await entry.transport.close?.();
    } catch {
      // Ignore close errors
    }
    this.clients.delete(serverName);
  }

  async closeAll() {
    for (const name of this.clients.keys()) {
      await this.close(name);
    }
  }
}
