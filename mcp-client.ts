import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ServerConfig } from "./config.js";

interface ClientEntry {
  config: ServerConfig;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  connected: boolean;
}

export class McpClientPool {
  private clients = new Map<string, ClientEntry>();

  async connect(config: ServerConfig): Promise<Client> {
    const client = new Client({ name: "openclaw-mcp-adapter", version: "0.1.0" });
    const transport = this.createTransport(config);

    await client.connect(transport);

    // Watch for stdio process exit
    if (transport instanceof StdioClientTransport) {
      transport.onerror = () => this.markDisconnected(config.name);
      transport.onclose = () => this.markDisconnected(config.name);
    }

    this.clients.set(config.name, { config, client, transport, connected: true });
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
      env: { ...process.env, ...config.env },
    });
  }

  async listTools(serverName: string) {
    const entry = this.clients.get(serverName);
    if (!entry) throw new Error(`Unknown server: ${serverName}`);
    const result = await entry.client.listTools();
    return result.tools;
  }

  async callTool(serverName: string, toolName: string, args: unknown) {
    const entry = this.clients.get(serverName);
    if (!entry) throw new Error(`Unknown server: ${serverName}`);

    try {
      return await entry.client.callTool({ name: toolName, arguments: args as Record<string, unknown> });
    } catch (err) {
      if (!entry.connected || this.isConnectionError(err)) {
        await this.reconnect(serverName);
        const newEntry = this.clients.get(serverName)!;
        return await newEntry.client.callTool({ name: toolName, arguments: args as Record<string, unknown> });
      }
      throw err;
    }
  }

  private async reconnect(serverName: string) {
    const entry = this.clients.get(serverName);
    if (!entry) return;

    try { await entry.transport.close?.(); } catch {}
    await this.connect(entry.config);
  }

  private markDisconnected(serverName: string) {
    const entry = this.clients.get(serverName);
    if (entry) entry.connected = false;
  }

  private isConnectionError(err: unknown): boolean {
    const msg = String(err);
    return msg.includes("closed") || msg.includes("ECONNREFUSED") || msg.includes("EPIPE");
  }

  getStatus(serverName: string) {
    const entry = this.clients.get(serverName);
    return { connected: entry?.connected ?? false };
  }
}
