/**
 * Where setup writes, and how: ANSI colours only on a terminal (NO_COLOR and --no-color turn them
 * off, FORCE_COLOR on), and plain ASCII markers when the locale isn't UTF-8.
 */
export type Status = "pass" | "warn" | "fail" | "info" | "skip";

export type Out = { write(chunk: string): unknown; isTTY?: boolean; columns?: number };

const CODES = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, blue: 34, cyan: 36 } as const;
type Code = keyof typeof CODES;

export class Term {
  readonly color: boolean;
  readonly unicode: boolean;

  constructor(
    readonly out: Out,
    readonly tty: boolean,
    env: Record<string, string | undefined>,
    noColor = false,
  ) {
    const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0";
    this.color = !noColor && (forced || (tty && env.NO_COLOR === undefined && env.TERM !== "dumb"));
    const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
    this.unicode = process.platform === "win32" || /utf-?8/i.test(locale);
  }

  paint(code: Code, text: string): string {
    return this.color ? `\x1b[${CODES[code]}m${text}\x1b[0m` : text;
  }

  write(text: string) {
    this.out.write(text);
  }

  line(text = "") {
    this.out.write(`${text}\n`);
  }

  /** The marker for a status: ✓ ⚠ ✗, or ok WARN FAIL without UTF-8. */
  mark(status: Status): string {
    const [glyph, ascii, code]: [string, string, Code] =
      status === "pass" ? ["✓", "ok", "green"]
      : status === "warn" ? ["⚠", "WARN", "yellow"]
      : status === "fail" ? ["✗", "FAIL", "red"]
      : status === "skip" ? ["–", "skip", "dim"]
      : ["·", "info", "cyan"];
    return this.paint(code, this.unicode ? glyph : ascii);
  }

  /** The `?` in front of a question. */
  get ask(): string {
    return this.paint("yellow", "?");
  }

  /** `── title`, the start of a section. */
  header(title: string) {
    this.line(this.paint("bold", `${this.unicode ? "──" : "--"} ${title}`));
  }
}

/** The worst of some statuses: a failure beats a warning beats a pass; only notes are a note. */
export function worst(statuses: Status[]): Status {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  if (statuses.length && statuses.every((s) => s === "info" || s === "skip")) return "info";
  return "pass";
}
