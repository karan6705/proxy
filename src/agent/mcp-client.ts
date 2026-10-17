import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export interface ToolClient {
  callTool<T>(name: string, args: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

function textResult(content: unknown): unknown {
  if (!Array.isArray(content)) return undefined;
  const text = content.find(
    (item): item is { type: "text"; text: string } =>
      typeof item === "object" && item !== null && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string",
  );
  if (!text) return undefined;
  try {
    return JSON.parse(text.text);
  } catch {
    return undefined;
  }
}

export async function connectToolClient(mcpUrl = process.env.MCP_URL ?? "http://localhost:3000/mcp"): Promise<ToolClient> {
  const client = new Client({ name: "proxy-demo-agent", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));

  return {
    async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
      const result = await client.callTool({ name, arguments: args });
      const payload = result.structuredContent ?? textResult(result.content);
      if (payload === undefined) throw new Error(`Tool ${name} returned no structured JSON`);
      if (result.isError) {
        const message =
          typeof payload === "object" && payload !== null && "message" in payload && typeof payload.message === "string"
            ? payload.message
            : `Tool ${name} failed`;
        throw new Error(message);
      }
      return payload as T;
    },
    close: () => client.close(),
  };
}
