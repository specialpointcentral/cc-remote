/** Native installs of claude live in ~/.local/bin, which non-interactive ssh shells often leave off PATH. */
export const REMOTE_PATH = `PATH="$HOME/.local/bin:$PATH"`;

/** Single-quotes a word for a POSIX shell. */
export const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
