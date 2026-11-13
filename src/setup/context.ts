import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { Mode, Options } from "./args";
import type { Action } from "./state";
import { Progress, type Timers } from "./ui/progress";
import { type Input, Prompter } from "./ui/prompt";
import { type Out, type Status, Term } from "./ui/term";

/**
 * One setup run: its options, its terminal, and how it runs commands. Everything setup touches
 * goes through here (the environment, HOME, the platform, PATH lookups), so tests run it whole
 * against a temporary home with fake tools.
 */
export type Env = Record<string, string | undefined>;

export type Io = {
  stdin?: Input;
  stdout?: Out & NodeJS.WritableStream;
  env?: Env;
  now?: () => number;
  timers?: Timers;
  platform?: NodeJS.Platform;
  /** Whether this user is root; for tests. */
  root?: boolean;
  /** The os-release file; for tests. */
  osRelease?: string;
  /** The running cc-remote: a compiled binary, or bun with the script it runs. */
  self?: { compiled: boolean; execPath: string; main: string };
};

/** One finding: what was checked, how it went, and what to do about it. */
export type Check = {
  id: string;
  status: Status;
  /** The short name in the left column, such as `rg` or `login`. */
  label: string;
  detail: string;
  /** What fixes it, one line each, shown under the detail. */
  remedy?: string[];
  /** A few words for the collapsed step line, when it differs from the detail. */
  short?: string;
  /** The package that would fix it, for a missing local tool. */
  pkg?: string;
};

export type Result = { code: number; stdout: string; stderr: string; ms: number };

const COMPILED = Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/");

export class Ctx {
  readonly env: Env;
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly root: boolean;
  readonly osRelease: string;
  readonly self: { compiled: boolean; execPath: string; main: string };
  readonly now: () => number;
  readonly term: Term;
  readonly progress: Progress;
  readonly prompt: Prompter;
  readonly mode: Mode;
  readonly stdin: Input;
  /** Each step's findings, as they stand after any fixes, for the summary. */
  readonly results = new Map<string, Check[]>();
  /** Every change made, for setup-state.json. */
  readonly actions: Action[] = [];
  /** Files and settings written, for the summary. */
  readonly saved: string[] = [];
  /** Show passing details too: on the first run, and with -v. */
  details = false;

  constructor(
    readonly o: Options,
    io: Io,
    total: number,
  ) {
    this.env = io.env ?? process.env;
    this.home = this.env.HOME || this.env.USERPROFILE || homedir();
    this.platform = io.platform ?? process.platform;
    this.root = io.root ?? (process.getuid?.() === 0);
    this.osRelease = io.osRelease ?? "/etc/os-release";
    this.self = io.self ?? { compiled: COMPILED, execPath: process.execPath, main: Bun.main };
    this.now = io.now ?? Date.now;
    this.stdin = io.stdin ?? process.stdin;
    const stdout = io.stdout ?? process.stdout;
    const tty = !!stdout.isTTY;
    this.mode = { interactive: !!this.stdin.isTTY && tty && !o.yes && !o.check, check: o.check };
    this.term = new Term(stdout, tty, this.env, o.noColor);
    this.progress = new Progress(this.term, total, !tty || o.noProgress, this.now, io.timers);
    this.prompt = new Prompter(this.stdin, stdout, this.term, this.progress);
  }

  /** A command on this run's PATH. */
  which(command: string): string | undefined {
    if (isAbsolute(command)) return command;
    return Bun.which(command, { PATH: this.env.PATH ?? "" }) ?? undefined;
  }

  /** `~/x` for a path in the home folder, as messages show it. */
  tilde(path: string): string {
    return path === this.home ? "~" : path.startsWith(this.home + "/") ? `~${path.slice(this.home.length)}` : path;
  }

  /** The environment without the variables that are undefined, as a child process gets it. */
  childEnv(extra: Env = {}, base: Env = this.env): Record<string, string> {
    return Object.fromEntries(Object.entries({ ...base, ...extra }).filter((e): e is [string, string] => e[1] !== undefined));
  }

  /** Runs a command with its output captured. */
  async run(argv: string[], options: { env?: Env; input?: string; timeoutMs?: number; cwd?: string } = {}): Promise<Result> {
    const started = performance.now();
    const exe = this.which(argv[0]!) ?? argv[0]!;
    try {
      const proc = Bun.spawn([exe, ...argv.slice(1)], {
        env: options.env ? this.childEnv({}, options.env) : this.childEnv(),
        cwd: options.cwd,
        stdin: options.input !== undefined ? new Blob([options.input]) : "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: options.timeoutMs ?? 60_000,
      });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code: await proc.exited, stdout, stderr, ms: Math.round(performance.now() - started) };
    } catch (e) {
      return { code: 127, stdout: "", stderr: (e as Error).message, ms: Math.round(performance.now() - started) };
    }
  }

  /**
   * Runs a command that talks to the user itself (sudo, OpenSSH's prompts, ssh-copy-id): on the
   * terminal, with the spinner stopped. Off the real terminal (tests) its output is relayed.
   */
  async interactive(argv: string[], env?: Env): Promise<number> {
    this.progress.freeze();
    const exe = this.which(argv[0]!) ?? argv[0]!;
    const real = this.stdin === process.stdin;
    try {
      const proc = Bun.spawn([exe, ...argv.slice(1)], {
        env: env ? this.childEnv({}, env) : this.childEnv(),
        stdin: real ? "inherit" : "ignore",
        stdout: real ? "inherit" : "pipe",
        stderr: real ? "inherit" : "pipe",
      });
      if (!real) {
        const [out, err] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
        for (const line of `${out}${err}`.split("\n").filter(Boolean)) this.term.line(`  ${line}`);
      }
      return await proc.exited;
    } catch (e) {
      this.term.line(`  ${(e as Error).message}`);
      return 127;
    }
  }

  /** Records a change for setup-state.json. */
  record(action: Omit<Action, "at">) {
    this.actions.push({ ...action, at: new Date(this.now()).toISOString() } as Action);
  }

  /** Whether a folder is on this run's PATH. */
  onPath(dir: string): boolean {
    return (this.env.PATH ?? "").split(delimiter).some((d) => d === dir || d === `${dir}/`);
  }

  /** cc-remote's config folder. */
  get config(): string {
    return join(this.home, ".config", "cc-remote");
  }
}
