import { createHash } from "node:crypto";
import { join } from "node:path";
import { readPrivateJson, writePrivateJson } from "./setup/files";
import { cacheFolder } from "./version";

/** The four cumulative token counters Claude reports per model. */
export type TokenTotals = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type SessionUsage = { sessionId: string; observedAt: string; totals: TokenTotals };
export type UsageWindow = { usedPercent: number; resetsAt: number | null; observedAt: string };
type ModelWindow = UsageWindow & { name: string };
/** Quota windows in the saved form, from a query or the cache. */
export type FetchedUsage = { fiveHour?: UsageWindow; sevenDay?: UsageWindow; models?: ModelWindow[] };

type Kind = "session" | "account" | "model";
/**
 * Named by the host alone, unlike the version cache: the Orca plugin finds the same file with the
 * same sha256, and refreshes in Orca's environment, which may lack the CC_REMOTE_SSH of sessions.
 */
const cacheFile = (kind: Kind, host: string) =>
  join(Bun.env.CC_REMOTE_USAGE_CACHE_DIR || cacheFolder(), `${kind}-usage-v1-${createHash("sha256").update(host).digest("hex").slice(0, 24)}.json`);

/** A finite number from 0 to `max`. */
const amount = (n: unknown, max = Infinity): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= max;

/** A saved window as cc-remote writes it, or undefined. */
const savedWindow = <T>(w: T): T | undefined => {
  const x = w as any;
  return amount(x?.usedPercent, 100) && typeof x.observedAt === "string" && (x.resetsAt === null || amount(x.resetsAt)) ? w : undefined;
};

/** Every file names its host and when it was written. */
function save(kind: Kind, host: string, data: object): void {
  try {
    writePrivateJson(cacheFile(kind, host), { host, observedAt: new Date().toISOString(), ...data });
  } catch (e) {
    console.error(`cc-remote: could not save ${kind} usage: ${(e as Error).message}`);
  }
}

/** An event may carry only one window: keep the saved other one. */
function saveAccount(host: string, fiveHour: UsageWindow | undefined, sevenDay: UsageWindow | undefined): void {
  if (!fiveHour && !sevenDay) return;
  const old = lastAccountUsage(host);
  save("account", host, { fiveHour: fiveHour ?? old?.fiveHour, sevenDay: sevenDay ?? old?.sevenDay });
}

/** From claude's rate_limit_event: fractions of 1 (unlike the status line's percentages) and resets in epoch seconds. */
export function rememberAccountUsage(host: string, message: any): void {
  const info = message?.type === "rate_limit_event" ? message.rate_limit_info : undefined;
  if (!info || typeof info !== "object") return;
  const observedAt = new Date().toISOString();
  const window = (w: any): UsageWindow | undefined => amount(w?.utilization, 1)
    ? { usedPercent: Math.round(w.utilization * 10000) / 100, resetsAt: amount(w.resetsAt) && w.resetsAt > 0 ? w.resetsAt * 1000 : null, observedAt }
    : undefined;
  const pick = (type: string) => window(info.unifiedWindows?.[type]) ?? (info.rateLimitType === type ? window(info) : undefined);
  saveAccount(host, pick("five_hour"), pick("seven_day"));
}

export function lastAccountUsage(host: string): Pick<FetchedUsage, "fiveHour" | "sevenDay"> | undefined {
  const value = readPrivateJson(cacheFile("account", host));
  if (value?.host !== host) return undefined;
  const fiveHour = savedWindow(value.fiveHour as UsageWindow), sevenDay = savedWindow(value.sevenDay as UsageWindow);
  return fiveHour || sevenDay ? { fiveHour, sevenDay } : undefined;
}

/** Every window saved for this host, for when a query fails: from earlier queries and session events. */
export function savedUsage(host: string): FetchedUsage | undefined {
  const value = readPrivateJson(cacheFile("model", host)) as any;
  const models = value?.host === host && Array.isArray(value.models)
    ? (value.models as ModelWindow[]).filter((m) => typeof m?.name === "string" && m.name && savedWindow(m))
    : [];
  const account = lastAccountUsage(host);
  return account || models.length ? { ...account, models } : undefined;
}

/** From the SDK's usage query: 0–100 percentages and ISO reset times. Saves and returns what it understood. */
export function rememberFetchedUsage(host: string, limits: unknown): FetchedUsage {
  const values = (limits && typeof limits === "object" ? limits : {}) as Record<string, any>;
  const observedAt = new Date().toISOString();
  const window = (w: any): UsageWindow | undefined => {
    if (!amount(w?.utilization, 100)) return undefined;
    const reset = typeof w.resets_at === "string" ? Date.parse(w.resets_at) : NaN;
    return { usedPercent: w.utilization, resetsAt: Number.isFinite(reset) ? reset : null, observedAt };
  };
  const usage: FetchedUsage = { fiveHour: window(values.five_hour), sevenDay: window(values.seven_day) };
  if (Array.isArray(values.model_scoped)) {
    usage.models = values.model_scoped.flatMap((item: any) => {
      const name = typeof item?.display_name === "string" ? item.display_name.trim() : "";
      const w = window(item);
      return name && name.length <= 80 && w ? [{ name, ...w }] : [];
    });
    // Separate from live account events: an older running cc-remote must not erase model limits.
    save("model", host, { models: usage.models });
  }
  saveAccount(host, usage.fiveHour, usage.sevenDay);
  return usage;
}

/** Keep only numeric totals and an identifier, never conversation text or credentials. */
export function rememberSessionUsage(host: string, message: any): void {
  if (message?.type !== "result" || typeof message.session_id !== "string" || !message.session_id) return;
  const totals = tokenTotals(message.modelUsage);
  if (totals) save("session", host, { sessionId: message.session_id, totals });
}

export function lastSessionUsage(host: string): SessionUsage | undefined {
  const value = readPrivateJson(cacheFile("session", host)) as any;
  const t = value?.totals;
  const valid = typeof value?.sessionId === "string" && typeof value.observedAt === "string" && t && [t.input, t.output, t.cacheRead, t.cacheWrite].every((n) => amount(n));
  return valid ? value : undefined;
}

const TOKEN_FIELDS = { input: "inputTokens", output: "outputTokens", cacheRead: "cacheReadInputTokens", cacheWrite: "cacheCreationInputTokens" } as const;

/** Model totals are cumulative; sum the latest snapshot, never successive result messages. */
function tokenTotals(models: unknown): TokenTotals | undefined {
  if (!models || typeof models !== "object" || Array.isArray(models)) return undefined;
  const total: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const m of Object.values(models) as any[]) {
    for (const [key, field] of Object.entries(TOKEN_FIELDS) as [keyof TokenTotals, string][]) {
      if (!amount(m?.[field])) return undefined;
      total[key] += m[field];
    }
  }
  return total;
}

/**
 * Show account-wide windows separately from a locally observed, possibly older session. `saved`:
 * the windows come from the cache, each with when it was observed.
 */
export function renderUsage(host: string, usage: FetchedUsage | undefined, last: SessionUsage | undefined, saved = false): string {
  const line = (label: string, w: UsageWindow | undefined) => {
    if (!w) return `${label}: unavailable`;
    const reset = w.resetsAt === null ? "" : `, resets ${new Date(w.resetsAt).toISOString()}`;
    return `${label}: ${w.usedPercent}% used${reset}${saved ? `, observed ${w.observedAt}` : ""}`;
  };
  const t = last?.totals;
  return [
    `Remote Claude usage: ${host}${saved ? " (saved values: the query failed)" : ""}`,
    line("5-hour", usage?.fiveHour),
    line("7-day", usage?.sevenDay),
    ...(usage?.models ?? []).map((m) => line(m.name, m)),
    "",
    last && t
      ? `Most recently completed session: ${last.sessionId}\nObserved: ${last.observedAt}\nSession token totals (all models):\nInput: ${t.input}\nOutput: ${t.output}\nCache read: ${t.cacheRead}\nCache write: ${t.cacheWrite}`
      : "No completed session usage recorded locally yet.",
  ].join("\n");
}
