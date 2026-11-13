import { join } from "node:path";
import { readPrivateJson, writePrivateJson } from "./files";

/**
 * What was typed at each prompt, most recent first, for its default, Up/Down and Tab:
 * `~/.config/cc-remote/setup-history.json`, `{"version":1,"host":["central",…]}`. At most 50 per
 * prompt, without duplicates. Client addresses are never recorded, only what the user typed.
 */
const MAX = 50;

export const historyFile = (home: string) => join(home, ".config", "cc-remote", "setup-history.json");

const usable = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024 && !/[\0\r\n]/.test(v);

/** A prompt's history, most recent first. A missing, corrupt or unsafe file is no history. */
export function readHistory(home: string, prompt = "host"): string[] {
  const data = readPrivateJson(historyFile(home));
  const list = data?.version === 1 ? data[prompt] : undefined;
  return Array.isArray(list) ? [...new Set(list.filter(usable))].slice(0, MAX) : [];
}

/** Puts a value first in a prompt's history. */
export function pushHistory(home: string, prompt: string, value: string) {
  if (!usable(value)) return;
  const data = readPrivateJson(historyFile(home));
  const next: Record<string, unknown> = data?.version === 1 ? { ...data } : { version: 1 };
  next[prompt] = [value, ...readHistory(home, prompt).filter((v) => v !== value)].slice(0, MAX);
  writePrivateJson(historyFile(home), next);
}
