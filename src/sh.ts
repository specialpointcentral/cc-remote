/** Single-quotes a word for a POSIX shell. */
export const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
