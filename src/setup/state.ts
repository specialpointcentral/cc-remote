import { join } from "node:path";
import { readPrivateJson, writePrivateJson } from "./files";

/**
 * `~/.config/cc-remote/setup-state.json`: this machine's id (for the marker on the central
 * server), the last run, and every change setup made with the value it replaced, so a later
 * `setup --undo` can put things back. Written at the end of each run that isn't `--check`.
 */
export type ActionId =
  | "local.install" | "local.hostfile" | "ssh.keygen" | "ssh.config-block" | "ssh.copy-id"
  | "remote.marker" | "orca.claude-command" | "orca.permission" | "orca.env";

export type Action = { id: ActionId; at: string; previous?: unknown; value?: unknown; [key: string]: unknown };

export type State = {
  version: 1;
  machineId: string;
  lastRun?: string;
  ccRemote?: string;
  host?: string;
  actions: Action[];
  lastCheck?: { at: string; passed: number; warnings: number; failed: number };
};

/** Old actions beyond this many are dropped, oldest first. */
const MAX_ACTIONS = 200;

export const stateFile = (home: string) => join(home, ".config", "cc-remote", "setup-state.json");

/** The saved state, or undefined before the first run (or when the file is unusable). */
export function readState(home: string): State | undefined {
  const data = readPrivateJson(stateFile(home));
  if (data?.version !== 1 || typeof data.machineId !== "string" || !/^[0-9a-f-]{36}$/.test(data.machineId)) return undefined;
  return { ...(data as unknown as State), actions: Array.isArray(data.actions) ? (data.actions as Action[]) : [] };
}

export const newState = (): State => ({ version: 1, machineId: crypto.randomUUID(), actions: [] });

export function writeState(home: string, state: State) {
  writePrivateJson(stateFile(home), { ...state, actions: state.actions.slice(-MAX_ACTIONS) });
}
