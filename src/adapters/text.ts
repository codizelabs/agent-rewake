import type { JsonRpcMessage } from "../acp/ndjson.js";

type RpcError = NonNullable<JsonRpcMessage["error"]>;

/** Limit messages are short; anything past this is a stack trace or a dump, and isn't matched. */
const MAX_TEXT = 16_000;

/**
 * Everything an error says, from wherever the agent put it. The official ACP SDKs turn a thrown
 * error into `-32603 "Internal error"` with the real text in `data.details` (TypeScript, Python) or
 * as a bare string in `data` (Rust); Codex uses `data.message`, Kimi `data.error`. Zed shows
 * `data.details` to the user, so it is as much the error as `message` is.
 */
export function errorText(error: RpcError): string {
  const data = error.data;
  const parts: string[] = [];
  const add = (v: unknown) => {
    if (typeof v !== "string") return;
    const t = stripInternal(v);
    if (t && !parts.includes(t)) parts.push(t);
  };
  add(error.message);
  if (typeof data === "string") add(data);
  else if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    add(d.message);
    add(d.details);
    add(d.detail);
    add(d.error);
    if (d.error && typeof d.error === "object") add((d.error as Record<string, unknown>).message);
  }
  return normalize(parts.join("\n"));
}

/** "Internal error", "Internal error: x" → "", "x". */
function stripInternal(text: string): string {
  return text.replace(/^Internal error(?::\s*|$)/, "").trim();
}

/**
 * Text ready for matching: straight apostrophes ("You’ve" is how Codex and Grok write it), no
 * request-id tail (Copilot), and provider JSON bodies unwrapped to their message, keeping the rest.
 */
export function normalize(text: string): string {
  let t = text
    .slice(0, MAX_TEXT)
    .replace(/[‘’]/g, "'")
    .replace(/\s*\(Request ID: [^)]*\)/g, "");
  const inner = jsonMessages(t);
  if (inner.length) t = `${t}\n${inner.join("\n")}`;
  return t.trim();
}

/**
 * Messages inside a JSON body embedded in the text, as SDKs print them: `429 {"type":"error",
 * "error":{"message":"…"}}`, `402 {"detail":"…"}`, or Python's `{'error': {'message': '…'}}`.
 */
function jsonMessages(text: string): string[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start || end - start > 20_000) return [];
  const raw = text.slice(start, end + 1);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    try {
      value = JSON.parse(raw.replace(/'/g, '"'));
    } catch {
      return [];
    }
  }
  const found: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || !v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    for (const key of ["message", "detail", "details", "raw"]) {
      const s = o[key];
      if (typeof s === "string" && s.trim()) found.push(s.replace(/[‘’]/g, "'").trim());
    }
    for (const key of ["error", "metadata"]) walk(o[key], depth + 1);
  };
  walk(value, 0);
  return found;
}

/** Text with links removed, so a billing URL in advice ("…/settings/billing") isn't read as billing. */
export function withoutUrls(text: string): string {
  return text.replace(/\bhttps?:\/\/\S+|\b[\w.-]{1,253}\.(?:com|ai|dev|io|ae|cn)\/\S*/gi, " ");
}

/** The HTTP status an SDK printed in front of the message ("429 {…}", "Error code: 402 - …"). */
export function httpStatus(text: string): number | undefined {
  const m =
    /(?:^|\n)(?:Error:\s*)?(?:Error code:\s*)?([1-5]\d{2})\b(?:\s*-|\s+[A-Z{])/.exec(text) ??
    /\bLast error:\s*([1-5]\d{2})\b/.exec(text) ??
    /\bstatus(?:=|:\s*|\s+code\s+)([1-5]\d{2})\b/i.exec(text);
  return m ? Number(m[1]) : undefined;
}
