import { PassThrough, type Readable } from "node:stream";
import { pluginFlags } from "./args";

/**
 * The SDK's pluginDelivery: 'initialize'. claude starts with --await-initialize, and the plugins
 * come in the first initialize request on stdin instead of as --plugin-dir flags. The host can't
 * read those paths, and cc-remote copies a session's plugins up before claude starts there, by
 * the flags (args.ts). So `cc-remote claude` reads the request before the start: its plugins become
 * flags, and the request goes on without them. claude still starts with --await-initialize, for
 * whatever else the request carries.
 */
export type Initialize = {
  /** The stdin to pass on: what was read, the request without its plugins in it, then the rest. */
  input: Readable;
  /** Flags for the request's plugins. */
  flags: string[];
  /** The request's id when it listed plugins: the answer to it says whether they're loaded. */
  id?: string;
};

/** The SDK's stdin, read up to its initialize request. */
export function readInitialize(input: Readable): Promise<Initialize> {
  return new Promise((done) => {
    /** Whole lines read so far, each with its newline, then the start of the next one. */
    const read: Buffer[] = [];
    let partial: Buffer[] = [];
    const finish = (flags: string[], id: string | undefined, ended: boolean) => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onEnd);
      input.pause();
      const out = new PassThrough();
      for (const b of [...read, ...partial]) out.write(b);
      if (ended) out.end();
      else input.pipe(out);
      done({ input: out, flags, id });
    };
    const onData = (chunk: Buffer) => {
      let start = 0;
      for (let nl = chunk.indexOf(10); nl >= 0; nl = chunk.indexOf(10, start)) {
        partial.push(chunk.subarray(start, nl + 1));
        start = nl + 1;
        const line = Buffer.concat(partial);
        partial = [];
        const request = initializeRequest(line);
        read.push(request?.line ?? line);
        if (request) {
          if (start < chunk.length) partial.push(chunk.subarray(start));
          return finish(request.flags, request.id, false);
        }
      }
      if (start < chunk.length) partial.push(chunk.subarray(start));
    };
    const onEnd = () => finish([], undefined, true);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onEnd);
  });
}

/** An initialize request, as it goes on: without its plugins, which come back as flags. */
function initializeRequest(line: Buffer): { line: Buffer; flags: string[]; id?: string } | undefined {
  const text = line.toString("utf8");
  if (!text.includes('"initialize"')) return undefined;
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (m?.type !== "control_request" || m.request?.subtype !== "initialize") return undefined;
  if (!Object.hasOwn(m.request, "plugins")) return { line, flags: [] };
  const flags = pluginFlags(m.request.plugins);
  delete m.request.plugins;
  return { line: Buffer.from(`${JSON.stringify(m)}\n`), flags, id: flags.length ? m.request_id : undefined };
}

/**
 * claude's answer to the initialize request `id`, made to say whether the plugins it listed are
 * loaded: claude got them as flags, so it's whether each one was copied up.
 */
export function pluginsApplied(id: string, applied: boolean): (line: string) => string {
  let waiting = true;
  return (line) => {
    if (!waiting || !line.includes('"control_response"') || !line.includes(JSON.stringify(id))) return line;
    const m = JSON.parse(line);
    if (m.type !== "control_response" || m.response?.request_id !== id) return line;
    waiting = false;
    if (m.response.subtype === "success") m.response.response = { ...m.response.response, plugins_applied: applied };
    return JSON.stringify(m);
  };
}
