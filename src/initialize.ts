import { PassThrough, type Readable } from "node:stream";

/**
 * The SDK's pluginDelivery: 'initialize'. claude starts with --await-initialize, and the plugins
 * come in the first initialize request on stdin instead of as --plugin-dir flags. The host can't
 * read those paths, and cc-remote copies a session's plugins up before claude starts there. So
 * `cc-remote claude` reads that first line before the start: the request's plugins get copied up,
 * and it goes on naming their paths on the host, where claude loads them as it would have here and
 * answers whether it did.
 */
export type Initialize = {
  /** The stdin to pass on: the first line, the request with the host's paths if it was one, then the rest. */
  input: Readable;
  /** The request's id, when it listed plugins. */
  id?: string;
};

/**
 * The SDK's stdin, read up to the end of its first line, which `plugins` gives the request's list
 * to rewrite when it is an initialize request. Only that line: claude waits for it as well, and
 * whatever else comes first starts the session as it is.
 */
export function readInitialize(input: Readable, plugins: (list: unknown) => unknown[]): Promise<Initialize> {
  return new Promise((done) => {
    let read: Buffer[] = [];
    const finish = (id?: string, ended = false) => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onEnd);
      input.pause();
      const out = new PassThrough();
      for (const b of read) out.write(b);
      if (ended) out.end();
      else input.pipe(out);
      done({ input: out, id });
    };
    const onData = (chunk: Buffer) => {
      const nl = chunk.indexOf(10);
      if (nl < 0) return void read.push(chunk);
      const line = Buffer.concat([...read, chunk.subarray(0, nl + 1)]);
      const request = initializeRequest(line, plugins);
      read = [request?.line ?? line, chunk.subarray(nl + 1)];
      finish(request?.id);
    };
    const onEnd = () => finish(undefined, true);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onEnd);
  });
}

/** An initialize request with its plugins rewritten, as it goes on, when the line is one that lists any. */
function initializeRequest(line: Buffer, plugins: (list: unknown) => unknown[]): { line: Buffer; id?: string } | undefined {
  const text = line.toString("utf8");
  if (!text.includes('"initialize"') || !text.includes('"plugins"')) return undefined;
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (m?.type !== "control_request" || m.request?.subtype !== "initialize" || !Object.hasOwn(m.request, "plugins")) return undefined;
  m.request.plugins = plugins(m.request.plugins);
  return { line: Buffer.from(`${JSON.stringify(m)}\n`), id: typeof m.request_id === "string" ? m.request_id : undefined };
}

/**
 * claude's answer to the initialize request `id`, saying the plugins aren't all loaded: for when
 * one couldn't be copied up, so claude never saw it to say so.
 */
export function notAllApplied(id: string): (line: string) => string {
  let waiting = true;
  return (line) => {
    if (!waiting || !line.includes('"control_response"') || !line.includes(JSON.stringify(id))) return line;
    const m = JSON.parse(line);
    if (m.type !== "control_response" || m.response?.request_id !== id) return line;
    waiting = false;
    if (m.response.subtype === "success") m.response.response = { ...m.response.response, plugins_applied: false };
    return JSON.stringify(m);
  };
}
