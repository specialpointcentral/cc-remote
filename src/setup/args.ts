/**
 * `cc-remote setup`'s flags, and who decides each change: the user at a prompt, a flag, or
 * nobody. Pure, so the rules can be tested on their own. The rules, from the design:
 *
 * - `--check` changes nothing at all.
 * - Installing local tools always asks `[y/N]` with the exact command; without a terminal only
 *   `--install` allows it. `--yes` alone never installs.
 * - Without a terminal (or with `--yes`), the defaults of the `[Y/n]` questions are taken, which
 *   are the safe local writes (host file, history, state, cc-remote's own folder on the server);
 *   anything else needs its own flag.
 * - Orca's Claude Command and permission mode change unattended only from Orca's defaults (or an
 *   older cc-remote path for the command); `--orca set` replaces any command.
 */
export type Options = {
  check: boolean;
  host?: string;
  yes: boolean;
  install: boolean;
  sshKey?: "generate" | "skip";
  copyId: boolean;
  acceptNewHostKey: boolean;
  orca: "auto" | "set" | "skip";
  orcaProfile?: string;
  orcaEnv: boolean;
  orcaPermission: "auto" | "keep";
  smoke: boolean;
  lang?: "en" | "zh";
  noProgress: boolean;
  noColor: boolean;
  verbose: boolean;
  help: boolean;
};

export class UsageError extends Error {}

const choice = <T extends string>(flag: string, value: string, allowed: readonly T[]): T => {
  if (!(allowed as readonly string[]).includes(value)) throw new UsageError(`${flag} takes ${allowed.join(", ")}, not ${value}`);
  return value as T;
};

export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}): Options {
  const o: Options = {
    check: false, yes: false, install: false, copyId: false, acceptNewHostKey: false, orca: "auto", orcaEnv: false,
    orcaPermission: "auto", smoke: false, noProgress: env.CC_REMOTE_NO_PROGRESS === "1", noColor: false, verbose: false, help: false,
    orcaProfile: env.CC_REMOTE_ORCA_PROFILE || undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const value = () => {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined || v === "") throw new UsageError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--check": o.check = true; break;
      case "--host": o.host = value(); break;
      case "-y": case "--yes": o.yes = true; break;
      case "--install": o.install = true; break;
      case "--ssh-key": o.sshKey = choice(flag, value(), ["generate", "skip"] as const); break;
      case "--copy-id": o.copyId = true; break;
      case "--accept-new-host-key": o.acceptNewHostKey = true; break;
      case "--orca": o.orca = choice(flag, value(), ["auto", "set", "skip"] as const); break;
      case "--orca-profile": o.orcaProfile = value(); break;
      case "--orca-env": o.orcaEnv = true; break;
      case "--orca-permission": o.orcaPermission = choice(flag, value(), ["auto", "keep"] as const); break;
      case "--smoke": o.smoke = true; break;
      case "--lang": o.lang = choice(flag, value(), ["en", "zh"] as const); break;
      case "--no-progress": o.noProgress = true; break;
      case "--no-color": o.noColor = true; break;
      case "-v": case "--verbose": o.verbose = true; break;
      case "-h": case "--help": o.help = true; break;
      default: throw new UsageError(`unknown argument ${a}`);
    }
  }
  if (o.check && (o.install || o.smoke)) throw new UsageError(`--check changes nothing, so it can't be combined with ${o.install ? "--install" : "--smoke"}`);
  return o;
}

/** How a run talks to the user: at a terminal, or not (Orca, paseo, pipes, `--yes`). */
export type Mode = { interactive: boolean; check: boolean };

/**
 * What to do about one change: nothing, do it, or ask with this default. `ask-yes` is `[Y/n]`,
 * `ask-no` is `[y/N]`.
 */
export type Decision = "skip" | "do" | "ask-yes" | "ask-no";

/** Installing a missing local tool. */
export function installDecision(o: Options, m: Mode): Decision {
  if (m.check) return "skip";
  if (m.interactive) return "ask-no";
  return o.install ? "do" : "skip";
}

/** Writing the host file: asked when it's new or different, unattended allowed. */
export function hostFileDecision(m: Mode, current: string | undefined, next: string): Decision {
  if (m.check || current === next) return "skip";
  return m.interactive ? "ask-yes" : "do";
}

/** Trusting an unknown host key: OpenSSH's own prompt, or accept-new when the flag says so. */
export function hostKeyDecision(o: Options, m: Mode): "skip" | "ask-yes" | "accept-new" {
  if (m.check) return "skip";
  if (o.acceptNewHostKey) return "accept-new";
  return m.interactive ? "ask-yes" : "skip";
}

/**
 * Making a key for cc-remote when ssh works only through ssh-agent or not at all, copying it to
 * the server and naming it in a managed ~/.ssh/config block. ssh-copy-id needs the password at a
 * terminal, so unattended runs only make the key and the block (with `--ssh-key generate`).
 */
export function sshKeyDecision(o: Options, m: Mode): Decision {
  if (m.check || o.sshKey === "skip") return "skip";
  if (o.sshKey === "generate") return "do";
  return m.interactive ? "ask-yes" : "skip";
}

export const copyIdAllowed = (o: Options, m: Mode) => !m.check && m.interactive && o.sshKey !== "skip";

/** What the current Claude Command is, compared to the one setup proposes. */
export type CommandKind = "ours" | "default" | "cc-remote" | "custom";

export function commandDecision(o: Options, m: Mode, kind: CommandKind): Decision {
  if (m.check || o.orca === "skip" || kind === "ours") return "skip";
  if (o.orca === "set") return "do";
  if (m.interactive) return kind === "custom" ? "ask-no" : "ask-yes";
  return kind === "custom" ? "skip" : "do";
}

/**
 * Switching Claude chats to permission mode auto. Only when central's claude offers it and
 * `--orca-permission keep` wasn't given; unattended only from Orca's default.
 */
export function permissionDecision(o: Options, m: Mode, p: { current: string; isDefault: boolean }, autoOffered: boolean): Decision {
  if (m.check || o.orca === "skip" || o.orcaPermission === "keep" || !autoOffered || p.current === "auto") return "skip";
  if (m.interactive) return p.isDefault ? "ask-yes" : "ask-no";
  return p.isDefault ? "do" : "skip";
}

/** Copying CC_REMOTE_SSH and friends into Orca's Claude environment. */
export function envDecision(o: Options, m: Mode): Decision {
  if (m.check || o.orca === "skip") return "skip";
  if (o.orcaEnv) return "do";
  return m.interactive ? "ask-yes" : "skip";
}
