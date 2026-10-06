import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** A JSON-RPC 2.0 message as it appears on an ACP stdio link. */
export type JsonRpcId = number | string;

export interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** One received line: the exact original text plus its parsed form (undefined if not valid JSON). */
export interface Line {
  raw: string;
  message: JsonRpcMessage | undefined;
}

export function isRequest(m: JsonRpcMessage): boolean {
  return typeof m.method === "string" && m.id !== undefined && m.id !== null;
}

export function isNotification(m: JsonRpcMessage): boolean {
  return typeof m.method === "string" && (m.id === undefined || m.id === null);
}

export function isResponse(m: JsonRpcMessage): boolean {
  return m.method === undefined && m.id !== undefined && ("result" in m || "error" in m);
}

/**
 * Reads newline-delimited JSON. Every line is delivered with its original text so callers can
 * forward it byte-for-byte; parsing failures are delivered with `message: undefined` rather than
 * throwing, so one malformed line never stops the stream.
 */
export function readLines(input: Readable, onLine: (line: Line) => void, onEnd: () => void): void {
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  rl.on("line", (raw) => {
    if (raw.trim() === "") return;
    let message: JsonRpcMessage | undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      message =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as JsonRpcMessage)
          : undefined;
    } catch {
      message = undefined;
    }
    onLine({ raw, message });
  });
  rl.on("close", onEnd);
}

/** Writes one message per line. ACP forbids embedded newlines; JSON.stringify never emits them. */
export class LineWriter {
  constructor(private readonly output: Writable) {}

  writeRaw(raw: string): void {
    this.output.write(`${raw}\n`);
  }

  write(message: JsonRpcMessage): void {
    this.output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }
}
