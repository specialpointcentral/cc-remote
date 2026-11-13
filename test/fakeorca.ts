import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * An Orca Server for setup's tests: the JSON-lines RPC on a Unix socket that a profile's
 * orca-runtime.json (0600) names, with the auth token, `_meta.runtimeId`, keepalive frames before
 * each answer, and `ok:false` errors. The settings calls follow what orcad 1.4.254 does (read in
 * its bundle): `settings.getAgentLaunch` reports agentPermission only when agentPermissionDefault
 * holds a choice (QZo); `mutateAgentLaunch` validates each type strictly (xza) and reduces it like
 * Qgc (`command` trims or deletes, `permission` with an agent sets that agent's override, y8);
 * `settings.update {nativeChatPermissionMode}` goes through CBu, which sets agentPermissionDefault
 * for every agent (Rdt), the broad change setup must not make on the new model.
 *
 * `pid` names the process whose environment setup's end-to-end check reads, as orcad's.
 */
export type OrcaSettings = {
  agentCmdOverrides: Record<string, string>;
  agentPermissionDefault?: string;
  agentPermissionOverrides: Record<string, string>;
  nativeChatPermissionMode: string;
  agentDefaultEnv: Record<string, Record<string, string>>;
};

const CHOICES = ["own", "ask", "accept-edits", "auto", "full-access"];
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function fakeOrca(profile: string, options: { legacy?: boolean; appVersion?: string; pid?: number; graphStatus?: string; token?: string } = {}) {
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  chmodSync(profile, 0o700);
  const runtimeId = `runtime-${crypto.randomUUID().slice(0, 8)}`;
  const token = options.token ?? "fixture-token";
  const settings: OrcaSettings = {
    agentCmdOverrides: {},
    ...(options.legacy ? {} : { agentPermissionDefault: "full-access" }),
    agentPermissionOverrides: {},
    nativeChatPermissionMode: "full-access",
    agentDefaultEnv: {},
  };
  const calls: { method: string; params: any }[] = [];
  const state = { graphStatus: options.graphStatus ?? "ready", appVersion: options.appVersion ?? "1.4.254" };

  const lg = () => CHOICES.includes(settings.agentPermissionDefault ?? "");
  const PUe = () => (lg() ? settings.agentPermissionDefault! : settings.nativeChatPermissionMode);
  const launch = () => ({
    agentCmdOverrides: { ...settings.agentCmdOverrides },
    environmentNames: Object.fromEntries(Object.entries(settings.agentDefaultEnv).map(([a, env]) => [a, Object.keys(env).sort()])),
    ...(lg() ? { agentPermission: { default: settings.agentPermissionDefault ?? "own", overrides: { ...settings.agentPermissionOverrides }, userArgs: {} } } : {}),
  });
  const strict = (p: any, keys: string[]) => {
    const extra = Object.keys(p).filter((k) => !keys.includes(k));
    if (extra.length) throw new Error(`Unrecognized key(s) in object: ${extra.join(", ")}`);
  };

  function handle(method: string, params: any): unknown {
    switch (method) {
      case "status.get": return { appVersion: state.appVersion, graphStatus: state.graphStatus, runtimeId };
      case "settings.get": return { settings: { nativeChatPermissionMode: PUe(), nativeChatInheritShellEnvironment: true } };
      case "settings.getAgentLaunch": return { settings: launch() };
      case "settings.mutateAgentLaunch": {
        switch (params?.type) {
          case "command":
            strict(params, ["type", "agent", "value"]);
            if (typeof params.value !== "string" || params.value.length > 8192 || params.value.includes("\0")) throw new Error("Invalid value");
            if (params.value.trim()) settings.agentCmdOverrides[params.agent] = params.value.trim();
            else delete settings.agentCmdOverrides[params.agent];
            break;
          case "permission":
            strict(params, ["type", "choice", "agent", "withoutAuto"]);
            if (!lg()) throw new Error("This host stores permissions in launch arguments");
            if (![...CHOICES, "default"].includes(params.choice)) throw new Error("Invalid enum value");
            if (!params.agent) throw new Error("fixture: only per-agent permission changes are modelled");
            if (params.choice === "default") delete settings.agentPermissionOverrides[params.agent];
            else settings.agentPermissionOverrides[params.agent] = params.choice;
            break;
          case "environment-set":
            strict(params, ["type", "agent", "name", "value"]);
            if (!NAME.test(params.name) || typeof params.value !== "string" || params.value.length > 8192) throw new Error("Invalid variable name");
            settings.agentDefaultEnv[params.agent] = { ...settings.agentDefaultEnv[params.agent], [params.name]: params.value };
            break;
          case "environment-remove":
            strict(params, ["type", "agent", "name"]);
            delete settings.agentDefaultEnv[params.agent]?.[params.name];
            break;
          default: throw new Error("Invalid discriminator value");
        }
        return { settings: launch() };
      }
      case "settings.update": {
        if ("nativeChatPermissionMode" in params && !("agentPermissionDefault" in params)) {
          // CBu → Rdt: one choice for all agents, those without auto pinned to their old one.
          const mode = params.nativeChatPermissionMode;
          if (!["ask", "accept-edits", "auto", "full-access"].includes(mode)) throw new Error("Invalid enum value");
          if (mode === "auto") for (const agent of ["grok"]) settings.agentPermissionOverrides[agent] ??= settings.agentPermissionDefault ?? "own";
          settings.agentPermissionDefault = mode;
          settings.nativeChatPermissionMode = mode;
        }
        return { settings: { nativeChatPermissionMode: PUe() } };
      }
      default: throw Object.assign(new Error(`Unknown method ${method}`), { code: "method_not_found" });
    }
  }

  const socket = join(profile, `o-${process.pid}-${runtimeId.slice(-4)}.sock`);
  const server = Bun.listen<{ buffer: string }>({
    unix: socket,
    socket: {
      open(s) {
        s.data = { buffer: "" };
      },
      data(s, chunk) {
        s.data.buffer += chunk.toString();
        for (let nl = s.data.buffer.indexOf("\n"); nl >= 0; nl = s.data.buffer.indexOf("\n")) {
          const line = s.data.buffer.slice(0, nl);
          s.data.buffer = s.data.buffer.slice(nl + 1);
          let request: any;
          try {
            request = JSON.parse(line);
          } catch {
            continue;
          }
          if (request.authToken !== token) {
            s.write(`${JSON.stringify({ id: request.id, ok: false, error: { code: "unauthorized", message: "bad token" }, _meta: { runtimeId: null } })}\n`);
            continue;
          }
          calls.push({ method: request.method, params: request.params });
          s.write(`${JSON.stringify({ _keepalive: true })}\n`);
          try {
            const result = handle(request.method, request.params ?? {});
            s.write(`${JSON.stringify({ id: request.id, ok: true, result, _meta: { runtimeId } })}\n`);
          } catch (e) {
            s.write(`${JSON.stringify({ id: request.id, ok: false, error: { code: (e as { code?: string }).code ?? "invalid_argument", message: (e as Error).message }, _meta: { runtimeId } })}\n`);
          }
        }
      },
    },
  });
  const runtimeFile = join(profile, "orca-runtime.json");
  writeFileSync(runtimeFile, JSON.stringify({
    runtimeId, pid: options.pid ?? process.pid, authToken: token,
    transports: [{ kind: "unix", endpoint: socket }, { kind: "websocket", endpoint: "ws://127.0.0.1:1" }],
  }), { mode: 0o600 });
  chmodSync(runtimeFile, 0o600);
  return {
    socket,
    settings,
    state,
    calls,
    /** The calls that change settings. */
    mutations: () => calls.filter((c) => c.method === "settings.mutateAgentLaunch" || c.method === "settings.update"),
    stop: () => server.stop(true),
  };
}
