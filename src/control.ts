import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { LOCAL, PREFIX, widenHooks } from "./names";
import type { Layer } from "./proxy";
import { mirrorKey, writeMirror } from "./sessions";

/** An in-process MCP server, as createSdkMcpServer and the bridge make them. */
export type SdkServer = { instance: { connect(transport: Transport): Promise<void> }; timeout?: number };

type Json = Record<string, any>;

/**
 * One server's end of the control channel, as the SDK's own: messages for it arrive in claude's
 * `mcp_message` requests, and what it sends goes back in the replies, or in requests of our own.
 */
class Channel implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  constructor(readonly send: (message: JSONRPCMessage) => Promise<void>) {}
  async start() {}
  async close() {
    this.onclose?.();
  }
}

const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join("\n\n");

/**
 * claude's initialize request, with what cc-remote's options add when it starts the SDK itself:
 * the servers served here, the local tools under the built-ins' names, hook matchers that cover
 * them, and the local environment in place of the host's sections of the system prompt.
 */
export function initialize(request: Json, served: Record<string, SdkServer>, environment: string): Json {
  const names = Object.keys(served);
  const configs = Object.fromEntries(names.flatMap((n) => (served[n]!.timeout ? [[n, { timeout: served[n]!.timeout }]] : [])));
  const out: Json = {
    ...request,
    sdkMcpServers: [...new Set([...(request.sdkMcpServers ?? []), ...names])],
    sdkMcpServerConfigs: { ...request.sdkMcpServerConfigs, ...configs },
    toolAliases: { ...request.toolAliases, ...Object.fromEntries(LOCAL.map((t) => [t, PREFIX + t])) },
    hooks: widenHooks(request.hooks),
  };
  if (out.sdkMcpServerConfigs && !Object.keys(out.sdkMcpServerConfigs).length) delete out.sdkMcpServerConfigs;
  // No systemPrompt is claude's own preset; a list is a custom prompt, where dynamic sections don't apply.
  if (Array.isArray(request.systemPrompt)) out.systemPrompt = [...request.systemPrompt, environment];
  else if (typeof request.systemPrompt === "string") out.systemPrompt = [request.systemPrompt, environment];
  else Object.assign(out, { excludeDynamicSections: true, appendSystemPrompt: join(request.appendSystemPrompt, environment) });
  return out;
}

/**
 * For an SDK that knows nothing of cc-remote, such as the one in Orca, cc-remote plays the part of
 * the SDK for its own servers on the same stream. Their messages are answered here and never
 * reach that SDK; its own servers, hooks and permission prompts pass through as they are. The
 * transcript mirror frames are written to the local projects folder, where it reads sessions.
 *
 * The servers the SDK declares itself win over ours of the same name, except `cc`, the local tools.
 */
export function sdkHost(servers: Record<string, SdkServer>, environment: string, toClaude: (line: string) => void): Layer {
  const reply = (request_id: string, body: { response: unknown } | { error: string }) =>
    toClaude(JSON.stringify({ type: "control_response", response: { subtype: "error" in body ? "error" : "success", request_id, ...body } }));

  /** Servers taking part, from claude's initialize on. Until then claude can't reach any. */
  let served: Record<string, SdkServer> = {};
  const channels = new Map<string, { channel: Channel; connected: Promise<void> }>();
  /** Replies the servers owe claude, by `server:id`. */
  const pending = new Map<string, (message: JSONRPCMessage) => void>();
  /** Our requests to claude, whose replies are ours, and claude's to us still being answered. */
  const ours = new Set<string>();
  const answering = new Set<string>();
  let queued: string[] | undefined = [];
  let next = 0;

  const toClaudeAfterInit = (line: string) => (queued ? queued.push(line) : toClaude(line));

  for (const [name, server] of Object.entries(servers)) {
    const channel = new Channel(async (message) => {
      const id = "id" in message ? message.id : undefined;
      const resolve = id !== undefined && id !== null ? pending.get(`${name}:${id}`) : undefined;
      if (resolve) return resolve(message);
      // Something the server starts itself, such as tools/list_changed.
      const request_id = `cc-remote-${++next}`;
      ours.add(request_id);
      toClaudeAfterInit(JSON.stringify({ type: "control_request", request_id, request: { subtype: "mcp_message", server_name: name, message } }));
    });
    channels.set(name, { channel, connected: server.instance.connect(channel).catch((e) => console.error(`cc-remote: MCP server ${name} failed to start: ${e}`)) });
  }

  async function dispatch(request_id: string, name: string, message: Json) {
    const { channel, connected } = channels.get(name)!;
    answering.add(request_id);
    try {
      await connected;
      let response: unknown = { jsonrpc: "2.0", result: {}, id: 0 };
      if ("method" in message && message.id !== undefined && message.id !== null) {
        response = await new Promise<JSONRPCMessage>((resolve) => {
          pending.set(`${name}:${message.id}`, resolve);
          channel.onmessage?.(message as JSONRPCMessage);
        }).finally(() => pending.delete(`${name}:${message.id}`));
      } else {
        channel.onmessage?.(message as JSONRPCMessage);
      }
      reply(request_id, { response: { mcp_response: response } });
    } catch (e) {
      reply(request_id, { error: (e as Error).message ?? String(e) });
    } finally {
      answering.delete(request_id);
    }
  }

  function inbound(line: string): string | null {
    if (line.includes('"initialize"') && queued) {
      const m = JSON.parse(line);
      if (m.type === "control_request" && m.request?.subtype === "initialize") {
        const theirs = new Set<string>(m.request.sdkMcpServers ?? []);
        served = Object.fromEntries(Object.entries(servers).filter(([n]) => n === "cc" || !theirs.has(n)));
        m.request = initialize(m.request, served, environment);
        // Messages our servers sent before this go out right after it.
        const held = queued;
        queued = undefined;
        queueMicrotask(() => held.forEach(toClaude));
        return JSON.stringify(m);
      }
    }
    if (line.includes('"mcp_set_servers"')) {
      // Setting the SDK's servers replaces the whole set in claude; keep ours in it.
      const m = JSON.parse(line);
      if (m.type === "control_request" && m.request?.subtype === "mcp_set_servers") {
        const own = Object.entries(served).map(([n, s]) => [n, { type: "sdk", name: n, ...(s.timeout ? { timeout: s.timeout } : {}) }]);
        m.request.servers = { ...m.request.servers, ...Object.fromEntries(own) };
        return JSON.stringify(m);
      }
    }
    return line;
  }

  function outbound(line: string): string | null {
    if (line.includes('"mcp_message"')) {
      const m = JSON.parse(line);
      const name = m.request?.server_name;
      if (m.type === "control_request" && m.request.subtype === "mcp_message" && Object.hasOwn(served, name)) {
        void dispatch(m.request_id, name, m.request.message ?? {});
        return null;
      }
    }
    if (line.includes('"transcript_mirror"')) {
      const m = JSON.parse(line);
      if (m.type === "transcript_mirror") {
        const key = typeof m.filePath === "string" ? mirrorKey(m.filePath) : undefined;
        try {
          if (key && Array.isArray(m.entries)) writeMirror(key, m.entries);
        } catch (e) {
          console.error(`cc-remote: could not write the local transcript: ${(e as Error).message}`);
        }
        return null;
      }
    }
    if (ours.size && line.includes('"control_response"')) {
      const m = JSON.parse(line);
      if (m.type === "control_response" && ours.delete(m.response?.request_id)) return null;
    }
    if (answering.size && line.includes('"control_cancel_request"')) {
      // The server sees the cancellation itself, as an MCP notification.
      const m = JSON.parse(line);
      if (m.type === "control_cancel_request" && answering.has(m.request_id)) return null;
    }
    return line;
  }

  return { inbound, outbound };
}
