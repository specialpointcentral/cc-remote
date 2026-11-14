import type { HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { Outcome } from "./run";

/**
 * Claude Code's contract for a command hook's result, turned into the answer of an SDK callback,
 * which claude reads as it reads a hook's JSON output (claude's H8, and its callback runner, which
 * also takes a callback's systemMessage as the hook's "output").
 *
 * - Exit 0: a JSON object on stdout (alone, whitespace around it) is the output; plain text is
 *   context for Claude on UserPromptSubmit, UserPromptExpansion, SessionStart and PostModelSwitch,
 *   the compaction's instructions on PreCompact, and otherwise only for the debug log.
 *   JSON that doesn't parse or fit the schema is a non-blocking error.
 * - Exit 2: a blocking error with stderr as the reason, in each event's way (below). Valid JSON
 *   output still applies, but can't lift the block.
 * - Any other exit: valid JSON alone decides; otherwise a non-blocking error, which the user sees
 *   (systemMessage) and Claude doesn't.
 * - A hook that can't start or times out fails like a non-blocking error; with `onFailure: "block"`
 *   a failure (that, another exit code, bad output) blocks instead, except on the events that
 *   ignore the option. A timed-out PreModelSwitch hook blocks the switch.
 */

type Json = Record<string, any>;

/** Plain stdout on exit 0 is context for Claude on these. */
const CONTEXT = ["UserPromptSubmit", "UserPromptExpansion", "SessionStart", "PostModelSwitch"];

/** Exit 2, and a blocking failure, block with a top-level decision on these. */
const DECISION = ["UserPromptSubmit", "UserPromptExpansion", "Stop", "SubagentStop", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "TaskCreated", "TaskCompleted", "TeammateIdle", "PreModelSwitch", "ConfigChange"];

/** Exit 2 only shows stderr to the user on these. */
const USER_ONLY = ["SessionStart", "SubagentStart", "SessionEnd", "PostCompact", "PostModelSwitch"];

/** `onFailure: "block"` has no effect on these. */
const NO_FAILURE_BLOCK = ["Stop", "SubagentStop", "TaskCompleted", "TeammateIdle"];

/** The output fields Claude Code reads, and the type each must have. */
const FIELDS: Record<string, (v: unknown) => boolean> = {
  continue: (v) => typeof v === "boolean",
  suppressOutput: (v) => typeof v === "boolean",
  stopReason: (v) => typeof v === "string",
  systemMessage: (v) => typeof v === "string",
  terminalSequence: (v) => typeof v === "string",
  reason: (v) => typeof v === "string",
  decision: (v) => v === "approve" || v === "block",
  hookSpecificOutput: (v) => !!v && typeof v === "object" && !Array.isArray(v),
};

const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** Stdout read as Claude Code reads it: one JSON object with only whitespace around it, plain text, or neither. */
export function parseOutput(stdout: string, event: string): { json: Json } | { text: string } | { invalid: string } {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return { text: trimmed };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Lines that are each JSON, such as a log a tool printed, are text unless one of them is an output object.
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
    const each = lines.length > 1 ? lines.map((l) => { try { return { v: JSON.parse(l) as unknown }; } catch { return undefined; } }) : [];
    if (each.length && each.every(Boolean)) {
      return each.some((x) => isObject(x!.v) && Object.keys(x!.v).some((k) => k in FIELDS))
        ? { invalid: "print the JSON output object alone on stdout" }
        : { text: trimmed };
    }
    return { invalid: "stdout looks like JSON but doesn't parse" };
  }
  if (!isObject(parsed)) return { text: trimmed };
  for (const [k, ok] of Object.entries(FIELDS)) {
    if (k in parsed && !ok(parsed[k])) return { invalid: `${k} has the wrong type` };
  }
  if (parsed.hookSpecificOutput && parsed.hookSpecificOutput.hookEventName !== event) {
    return { invalid: `hookSpecificOutput.hookEventName must be "${event}"` };
  }
  // Only the fields Claude Code knows: the callback's answer is checked against its schema.
  return { json: Object.fromEntries(Object.entries(parsed).filter(([k]) => k in FIELDS)) };
}

/** How each event takes a blocking error, with `reason` for Claude or the user. */
export function blocking(event: string, reason: string, base: Json = {}): HookJSONOutput {
  if (event === "PreToolUse") {
    return { ...base, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } } as HookJSONOutput;
  }
  if (DECISION.includes(event)) return { ...base, decision: "block", reason } as HookJSONOutput;
  // claude takes a callback's systemMessage as what the hook printed: the block's reason here.
  if (event === "PreCompact") return { ...base, decision: "block", reason, systemMessage: reason } as HookJSONOutput;
  if (event === "Elicitation" || event === "ElicitationResult") {
    return { ...base, reason, hookSpecificOutput: { hookEventName: event, action: "decline" } } as HookJSONOutput;
  }
  if (USER_ONLY.includes(event)) return { ...base, systemMessage: reason } as HookJSONOutput;
  return base as HookJSONOutput; // PermissionRequest, PermissionDenied, Notification, Setup, StopFailure, MessageDisplay ignore it.
}

/** A non-blocking error: the user sees it, Claude doesn't. On PreCompact a systemMessage would become instructions. */
function nonBlocking(event: string, detail: string): HookJSONOutput {
  return event === "PreCompact" ? {} : { systemMessage: `${event} hook error: ${detail}` };
}

/** A hook that failed: a non-blocking error, or a block with `onFailure: "block"`. */
function failure(event: string, detail: string, onFailure: unknown): HookJSONOutput {
  if (onFailure === "block" && !NO_FAILURE_BLOCK.includes(event)) {
    return blocking(event, `${event} hook failed: ${detail}; blocking because onFailure is "block"`);
  }
  return nonBlocking(event, detail);
}

/** The first line of a stream's text, for an error notice. */
const firstLine = (text: string) => text.trim().split(/\r?\n/)[0]?.slice(0, 500) ?? "";

/** The callback's answer for a hook run's outcome. */
export function hookOutput(event: string, outcome: Outcome, onFailure?: unknown): HookJSONOutput {
  switch (outcome.kind) {
    case "cancelled":
    case "skipped":
      return {};
    case "timeout":
      return event === "PreModelSwitch" ? blocking(event, "the hook did not answer in time") : failure(event, "timed out", onFailure);
    case "failed":
      return failure(event, outcome.message, onFailure);
  }
  const { code, stdout, stderr } = outcome;
  const out = parseOutput(stdout, event);
  if (code === 2) return blocking(event, stderr.trim() || "Blocked by hook", "json" in out ? out.json : {});
  if ("invalid" in out) return failure(event, `invalid output: ${out.invalid}`, onFailure);
  if (code !== 0) {
    if ("json" in out && onFailure !== "block") return out.json as HookJSONOutput;
    return failure(event, firstLine(stderr) || `exit code ${code}`, onFailure);
  }
  if ("json" in out) return out.json as HookJSONOutput;
  if (!out.text) return {};
  if (CONTEXT.includes(event)) return { hookSpecificOutput: { hookEventName: event, additionalContext: out.text } } as HookJSONOutput;
  if (event === "PreCompact") return { systemMessage: out.text };
  return {};
}

/**
 * What an async hook leaves for Claude once it ends: its JSON output's additionalContext and
 * systemMessage, the output printed alone or on a line of its own. An asyncRewake hook's exit 2
 * leaves its stderr, or its stdout when stderr is empty.
 */
export function asyncContext(outcome: Outcome, rewake: boolean): string[] {
  if (outcome.kind !== "exit") return [];
  if (rewake && outcome.code === 2) return [outcome.stderr.trim() || outcome.stdout.trim()].filter(Boolean);
  const candidates = [outcome.stdout.trim(), ...outcome.stdout.split(/\r?\n/).map((l) => l.trim())];
  for (const c of candidates) {
    if (!c.startsWith("{")) continue;
    try {
      const json = JSON.parse(c) as unknown;
      if (!isObject(json)) continue;
      const context = json.hookSpecificOutput?.additionalContext;
      return [typeof context === "string" ? context : "", typeof json.systemMessage === "string" ? json.systemMessage : ""].filter(Boolean);
    } catch {}
  }
  return [];
}
