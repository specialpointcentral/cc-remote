import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { bridgeAll } from "./bridge";
import { localMcpServers } from "./mcp";
import { LOCAL, PREFIX, READS, REMOVED, widenHooks } from "./names";
import { environment } from "./prompt";
import { mirror } from "./sessions";
import { spawner } from "./ssh";
import { localTools } from "./tools";
import { workspace } from "./tools/util";

type SystemPrompt = Options["systemPrompt"];

/** claude's default prompt, without the sections it writes about its own (host) machine, plus ours. */
function withEnvironment(prompt: SystemPrompt, env: string): SystemPrompt {
  const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join("\n\n");
  if (prompt === undefined) return { type: "preset", preset: "claude_code", excludeDynamicSections: true, append: env };
  if (typeof prompt === "string") return join(prompt, env);
  if (Array.isArray(prompt)) return [...prompt, env];
  if (prompt.type === "preset") return { ...prompt, excludeDynamicSections: true, append: join(prompt.append, env) };
  return { ...prompt, prompt: Array.isArray(prompt.prompt) ? [...prompt.prompt, env] : join(prompt.prompt, env) };
}

/**
 * claude-agent-acp builds the options of every session's query(); this moves the session to the
 * host. claude runs there over ssh, while its file and shell tools, and the MCP servers of the ACP
 * client and of the local Claude Code config, run here in the session's directory.
 */
export function remote(host: string) {
  return async (options: Options): Promise<Options> => {
    const cwd = options.cwd ?? process.cwd();
    // Extra directories are local paths; the host has none of them. They go in the prompt instead.
    const [env, local] = await Promise.all([environment(cwd, options.additionalDirectories ?? []), localMcpServers(cwd)]);
    // Shared by the tools and the stream: the shell's directory, and the host's own files.
    const ws = workspace(cwd);
    return {
      ...options,
      pathToClaudeCodeExecutable: "claude",
      spawnClaudeCodeProcess: spawner(host, cwd, { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" }, ws),
      additionalDirectories: [],
      systemPrompt: withEnvironment(options.systemPrompt, env),
      // The client's servers win over the config's: it chose them for this session.
      mcpServers: { ...bridgeAll({ ...local, ...options.mcpServers }, cwd, options.abortController?.signal), cc: localTools(ws) },
      toolAliases: { ...options.toolAliases, ...Object.fromEntries(LOCAL.map((t) => [t, PREFIX + t])) },
      disallowedTools: [...(options.disallowedTools ?? []), ...REMOVED],
      // claude asks before any MCP tool; it never asks before its own reads.
      allowedTools: [...(options.allowedTools ?? []), ...READS.map((t) => PREFIX + t)],
      hooks: widenHooks(options.hooks),
      ...(options.persistSession === false ? {} : { sessionStore: mirror }),
    };
  };
}
