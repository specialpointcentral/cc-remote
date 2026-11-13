import { createInterface } from "node:readline";
import { t } from "./i18n";
import type { Progress } from "./progress";
import type { Term } from "./term";

/** Ctrl-C at a prompt: setup restores the terminal and exits with 130. */
export class Interrupted extends Error {
  constructor() {
    super("interrupted");
  }
}

export type Input = NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(raw: boolean): unknown };
export type Completer = (line: string) => [string[], string];

/**
 * Questions on the terminal, through node:readline so Tab completes and Up and Down browse the
 * prompt's history. A default is shown in brackets and never prefilled: remote-harness learned that
 * a prefilled default gets a pasted value appended to it. Each question gets an interface of its
 * own, closed once answered, so the terminal is out of raw mode whenever a child process (sudo,
 * OpenSSH) talks to the user.
 */
export class Prompter {
  constructor(
    private readonly input: Input,
    private readonly output: NodeJS.WritableStream,
    private readonly term: Term,
    private readonly progress: Progress,
  ) {}

  private ask(question: string, options: { history?: string[]; completer?: Completer } = {}): Promise<string> {
    this.progress.freeze();
    return new Promise((resolve, reject) => {
      let answered = false;
      const rl = createInterface({
        input: this.input,
        output: this.output,
        terminal: true,
        history: [...(options.history ?? [])],
        historySize: 50,
        removeHistoryDuplicates: true,
        ...(options.completer ? { completer: options.completer } : {}),
      });
      rl.on("SIGINT", () => {
        rl.close();
        this.output.write("\n");
        reject(new Interrupted());
      });
      rl.on("close", () => {
        // Ctrl-D, or the input ended: nobody is there to answer.
        if (!answered) reject(new Interrupted());
      });
      rl.question(question, (answer) => {
        answered = true;
        rl.close();
        resolve(answer);
      });
    });
  }

  /** A line of text. Empty input takes the default. */
  line(label: string, options: { def?: string; history?: string[]; completer?: Completer } = {}): Promise<string> {
    const shown = options.def ? `${label} [${options.def}]: ` : `${label}: `;
    return this.ask(shown, options).then((a) => a || options.def || "");
  }

  /**
   * A yes/no question, `[Y/n]` or `[y/N]` by its default. Asks again until the answer is one of
   * y/yes/是/好 or n/no/否/不 (ported from remote-harness's prompt_yes_no).
   */
  async yesNo(question: string, def: boolean): Promise<boolean> {
    for (;;) {
      const answer = (await this.ask(`${this.term.ask} ${question} ${def ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
      if (!answer) return def;
      if (["y", "yes", "是", "好"].includes(answer)) return true;
      if (["n", "no", "否", "不"].includes(answer)) return false;
      this.term.line(`  ${this.term.mark("warn")} ${t("Please answer y or n.", "请输入 y 或 n。")}`);
    }
  }
}
