import type { Status, Term } from "./term";

/**
 * One line per step: `[n/T] ⠹ label…  12s` with a live spinner on a terminal, then
 * `[n/T] ✓ label  3s — detail`. Elapsed time rather than a percentage: network-bound steps have no
 * predictable length. Off a terminal (pipes, Orca, tests, --no-progress) every step prints a plain
 * start line and a plain end line. Any other output during a step freezes the spinner first, so
 * nothing it prints, and no prompt, is ever overwritten. Ported from remote-harness's
 * step_begin/step_end/step_freeze (`_common.sh`).
 */
export type Timers = {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const ASCII_FRAMES = "|/-\\";

export class Progress {
  private n = 0;
  private label = "";
  private started = 0;
  private spinner: unknown;
  private frame = 0;

  constructor(
    private readonly term: Term,
    public total: number,
    private readonly plain: boolean,
    private readonly now: () => number = Date.now,
    private readonly timers: Timers = { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (h) => clearInterval(h as Timer) },
  ) {}

  /** The step being run, as `[n/T]`. */
  private get prefix() {
    return `[${this.n}/${this.total}]`;
  }

  private seconds() {
    return `${Math.max(0, Math.floor((this.now() - this.started) / 1000))}s`;
  }

  private draw() {
    const frames = this.term.unicode ? FRAMES : ASCII_FRAMES;
    const glyph = this.term.paint("cyan", frames[this.frame++ % frames.length]!);
    this.term.write(`\r\x1b[K  ${this.prefix} ${glyph} ${this.label}${this.term.unicode ? "…" : "..."}  ${this.term.paint("dim", this.seconds())}`);
  }

  private stop() {
    if (this.spinner === undefined) return;
    this.timers.clearInterval(this.spinner);
    this.spinner = undefined;
    this.term.write("\r\x1b[K");
  }

  /**
   * Starts the next step. Without `spin`, a terminal shows nothing until the step ends: such
   * steps prompt or run commands that talk to the user themselves (sudo, OpenSSH).
   */
  begin(label: string, spin = true) {
    if (this.label) this.stop();
    this.n++;
    if (this.n > this.total) this.total = this.n;
    this.label = label;
    this.started = this.now();
    if (this.plain) this.term.line(`${this.prefix} ${label}...`);
    else if (spin) {
      this.frame = 0;
      this.draw();
      this.spinner = this.timers.setInterval(() => this.draw(), 150);
    }
  }

  /** Takes up the step that just ended again, keeping its number and its timer, as after a fix. */
  again(label = this.label) {
    this.label = label;
    if (this.plain) this.term.line(`${this.prefix} ${label}...`);
  }

  /** Turns a running spinner into a static line, before anything else is printed. */
  freeze() {
    if (this.spinner === undefined) return;
    this.stop();
    this.term.line(`  ${this.prefix} ${this.term.paint("cyan", this.term.unicode ? "⋯" : "...")} ${this.label}${this.term.unicode ? "…" : "..."}`);
  }

  /** Ends the step, under `label` when the end reads differently from the start. */
  end(status: Status, detail?: string, label = this.label) {
    this.stop();
    const mark = this.term.mark(status);
    if (this.plain) this.term.line(`${this.prefix} ${mark} ${label} (${this.seconds()})${detail ? `: ${detail}` : ""}`);
    else this.term.line(`  ${this.prefix} ${mark} ${label}  ${this.term.paint("dim", this.seconds())}${detail ? ` — ${detail}` : ""}`);
    this.label = "";
  }

  /** A line of output during or between steps. */
  say(text = "") {
    this.freeze();
    this.term.line(text);
  }

  /** Stops the spinner for good, as on Ctrl-C. */
  close() {
    this.stop();
    this.label = "";
  }
}
