import { query, type SDKUserMessage, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { remoteCommand, rsh } from "./ssh";

/**
 * The plan's windows from a usage answer. A login with none (an API key, Bedrock, Vertex) is a failed
 * query, not an empty one: `cc-remote usage` then shows what was saved, and exits 1 for the plugin.
 */
export function planLimits(result: { rate_limits_available: boolean; rate_limits: unknown }): unknown {
  if (!result.rate_limits_available) throw new Error("the remote Claude's login has no plan limits to show (an API key, Bedrock or Vertex)");
  return result.rate_limits;
}

/** Ask the remote Claude for /usage data without sending a prompt or moving its credentials. */
export async function remoteUsage(host: string): Promise<unknown> {
  // Also bounds a stale shared connection, which the query reuses as hostVersion does.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  async function* idle(): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
  }
  const session = query({
    prompt: idle(),
    options: {
      abortController: controller,
      persistSession: false,
      settingSources: [],
      tools: [],
      pathToClaudeCodeExecutable: "claude",
      spawnClaudeCodeProcess: (options): SpawnedProcess => {
        // No password prompt for a refresh started by the Orca plugin, which has no terminal.
        const [ssh, ...flags] = rsh(true, ["-o", "BatchMode=yes"]);
        // No folder: the query reads no project. Redaction applies as for any session.
        return spawn(ssh!, [...flags, "-T", host, remoteCommand(options.args, {}, undefined)], { stdio: ["pipe", "pipe", "pipe"], signal: options.signal, windowsHide: true }) as SpawnedProcess;
      },
    },
  });
  try {
    await session.initializationResult();
    // Experimental in the SDK: package.json pins its version; check this call when upgrading it.
    const result = await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    return planLimits(result);
  } finally {
    clearTimeout(timer);
    session.close();
    controller.abort();
  }
}
