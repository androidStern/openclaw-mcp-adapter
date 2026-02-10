export interface ServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  allowPrivateUrls?: boolean;
}

export interface McpAdapterConfig {
  servers: ServerConfig[];
  toolPrefix: boolean;
}

const PRIVATE_IP_PATTERNS = [
  /^127\./, /^10\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, /^0\.0\.0\.0$/,
  /^\[?::1\]?$/, /^\[?fc/, /^\[?fd/,
];

function isPrivateHost(hostname: string): boolean {
  return PRIVATE_IP_PATTERNS.some((p) => p.test(hostname))
    || hostname === "localhost"
    || hostname.endsWith(".local");
}

function validateUrl(url: string, serverName: string, allowPrivate: boolean): void {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Server "${serverName}": unsupported protocol "${parsed.protocol}"`);
  }
  if (!allowPrivate && isPrivateHost(parsed.hostname)) {
    throw new Error(
      `Server "${serverName}": URL points to private/reserved address "${parsed.hostname}". ` +
      `Set allowPrivateUrls: true to override.`
    );
  }
}

function interpolateEnv(obj: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = v.replace(/\$\{([^}]+)\}/g, (_, name) => {
      if (process.env[name] === undefined) {
        console.warn(`[mcp-adapter] env var "${name}" is not set`);
      }
      return process.env[name] ?? "";
    });
  }
  return result;
}

export function parseConfig(raw: unknown): McpAdapterConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  const servers: ServerConfig[] = [];

  for (const s of (cfg.servers as unknown[]) ?? []) {
    const srv = s as Record<string, unknown>;
    if (!srv.name) throw new Error("Server missing 'name'");

    const transport = (srv.transport as string) ?? "stdio";
    if (transport === "stdio" && !srv.command) throw new Error(`Server "${srv.name}" missing 'command'`);
    if (transport === "http" && !srv.url) throw new Error(`Server "${srv.name}" missing 'url'`);

    const allowPrivate = srv.allowPrivateUrls === true;
    if (transport === "http" && srv.url) {
      validateUrl(srv.url as string, srv.name as string, allowPrivate);
    }

    servers.push({
      name: srv.name as string,
      transport: transport as "stdio" | "http",
      command: srv.command as string | undefined,
      args: srv.args as string[] | undefined,
      env: srv.env ? interpolateEnv(srv.env as Record<string, string>) : undefined,
      url: srv.url as string | undefined,
      headers: srv.headers ? interpolateEnv(srv.headers as Record<string, string>) : undefined,
      allowPrivateUrls: allowPrivate,
    });
  }

  return {
    servers,
    toolPrefix: cfg.toolPrefix !== false,
  };
}
