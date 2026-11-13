/**
 * A small tar writer, so cc-remote can carry files to the host in one stream on every platform,
 * Windows included, without a local tar. Plain ustar headers, plus a pax header in front of an
 * entry whose path doesn't fit one; any POSIX tar on the host unpacks it.
 */

export type TarFile = {
  /** Relative, with `/` separators, such as `skills/review/SKILL.md`. */
  path: string;
  data: Uint8Array;
  /** Permission bits, such as 0o644. */
  mode: number;
  /** Modification time, in seconds. */
  mtime: number;
};

const encoder = new TextEncoder();

/** Where a path splits to fit a ustar header: a name of up to 100 bytes, after a prefix of up to 155. */
export function ustarSplit(path: string): { prefix: string; name: string } | undefined {
  if (Buffer.byteLength(path) <= 100) return { prefix: "", name: path };
  for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) {
    const [prefix, name] = [path.slice(0, i), path.slice(i + 1)];
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name) return { prefix, name };
  }
  return undefined;
}

/** A ustar header: octal numbers, a checksum over the header with its own field as spaces. */
function header(prefix: string, name: string, type: "0" | "5" | "x", mode: number, size: number, mtime: number): Uint8Array {
  const h = new Uint8Array(512);
  const put = (offset: number, length: number, text: string) => h.set(encoder.encode(text).subarray(0, length), offset);
  const octal = (offset: number, length: number, value: number) => put(offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
  put(0, 100, name);
  octal(100, 8, mode);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, mtime);
  h.fill(0x20, 148, 156);
  put(156, 1, type);
  put(257, 6, "ustar\0");
  put(263, 2, "00");
  put(345, 155, prefix);
  put(148, 8, `${h.reduce((sum, b) => sum + b, 0).toString(8).padStart(6, "0")}\0 `);
  return h;
}

const padding = (size: number) => new Uint8Array((512 - (size % 512)) % 512);

/** One pax record, `<length> path=<value>\n`, where the length counts itself. */
function record(key: string, value: string): string {
  const body = Buffer.byteLength(` ${key}=${value}\n`);
  let length = body + 1;
  while (length !== body + `${length}`.length) length = body + `${length}`.length;
  return `${length} ${key}=${value}\n`;
}

/** The header blocks of one entry: its ustar header, after a pax header when the path needs one. */
function entry(path: string, type: "0" | "5", mode: number, size: number, mtime: number): Uint8Array[] {
  const fit = ustarSplit(path);
  if (fit) return [header(fit.prefix, fit.name, type, mode, size, mtime)];
  const pax = encoder.encode(record("path", path));
  // The ustar name only matters to a tar that ignores pax; the last part of the path will do.
  const name = path.split("/").filter(Boolean).pop()!.slice(0, 99);
  return [header("", "PaxHeader", "x", 0o644, pax.length, mtime), pax, padding(pax.length), header("", name, type, mode, size, mtime)];
}

/** A tar archive of the files, each folder before what it holds. */
export function archive(files: TarFile[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const dirs = new Set<string>();
  for (const f of files) {
    const segments = f.path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join("/");
      if (dirs.has(dir)) continue;
      dirs.add(dir);
      parts.push(...entry(`${dir}/`, "5", 0o755, 0, f.mtime));
    }
    parts.push(...entry(f.path, "0", f.mode, f.data.length, f.mtime), f.data, padding(f.data.length));
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
