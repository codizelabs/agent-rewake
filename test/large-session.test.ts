import { mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runContinue } from "../src/continue.js";
import { DEFAULT_SETTINGS, saveSettings } from "../src/core/settings.js";
import {
  type ClosedDeps,
  fileBytes,
  LARGE_HISTORY_BYTES,
  largeHistoryText,
  onLimit,
} from "../src/hosts/closed.js";
import { geminiHooks, geminiHost } from "../src/hosts/gemini/host.js";
import { runHook } from "../src/hosts/hook.js";
import "../src/hosts/index.js";
import { SessionRecords } from "../src/hosts/sessions.js";

const NOW = new Date(2026, 9, 7, 12, 0).getTime();
const H = 3_600_000;
const MB = 1024 * 1024;
const SID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";

let dir: string;
let state: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "rewake-large-")));
  state = join(dir, "state");
  saveSettings(state, DEFAULT_SETTINGS);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const closed = (): ClosedDeps => ({
  stateDir: state,
  now: NOW,
  env: {},
  arm: () => {},
  disarm: () => {},
  notify: () => true,
});

function transcript(bytes: number): string {
  const f = join(dir, "history.jsonl");
  writeFileSync(f, "");
  truncateSync(f, bytes); // a sparse file: only its size matters, and it's never read
  return f;
}

async function continueText(): Promise<string> {
  const out: string[] = [];
  await runContinue({
    hosts: [geminiHost],
    deps: closed(),
    interactive: true,
    out: (t) => out.push(t),
    ask: async () => "",
  });
  return out.join("");
}

describe("a continue of a large session says so", () => {
  it("knows a file's size without reading it, and nothing for a missing file or a folder", () => {
    expect(fileBytes(transcript(3 * MB))).toBe(3 * MB);
    expect(fileBytes(join(dir, "missing.jsonl"))).toBeUndefined();
    expect(fileBytes(dir)).toBeUndefined();
    expect(fileBytes(undefined)).toBeUndefined();
    expect(fileBytes("")).toBeUndefined();
  });

  it("warns at the documented threshold, in plain words, and not below it", () => {
    expect(LARGE_HISTORY_BYTES).toBe(5 * MB);
    expect(largeHistoryText(geminiHost, 5 * MB - 1)).toBeUndefined();
    expect(largeHistoryText(geminiHost, undefined)).toBeUndefined();
    expect(largeHistoryText(geminiHost, 12 * MB)).toBe(
      "This session is large (about 12 MB of history); continuing it re-reads that and uses your plan.",
    );
  });

  it("is in continue's confirmation when the recorded history is large", async () => {
    onLimit(
      geminiHost,
      SID,
      dir,
      { kind: "other", billing: false, resetsAt: NOW + H },
      closed(),
      transcript(8 * MB),
    );
    const text = await continueText();
    expect(text).toContain("Rewake will continue");
    expect(text).toContain(
      "This session is large (about 8 MB of history); continuing it re-reads that and uses your plan.",
    );
  });

  it("is left out when the history is small or its size isn't known", async () => {
    onLimit(
      geminiHost,
      SID,
      dir,
      { kind: "other", billing: false, resetsAt: NOW + H },
      closed(),
      transcript(1 * MB),
    );
    expect(await continueText()).not.toContain("is large");
    onLimit(geminiHost, SID, dir, { kind: "other", billing: false, resetsAt: NOW + H }, closed());
    expect(new SessionRecords(state, "gemini-cli").get(SID)?.historyBytes).toBeUndefined();
  });

  it("is recorded by Gemini CLI's hook from its transcript file's size", async () => {
    const f = join(dir, ".gemini", "tmp", "abc", "chats", "session-1.jsonl");
    mkdirSync(join(f, ".."), { recursive: true });
    const filler = `${JSON.stringify({ type: "gemini", content: "x".repeat(1000) })}\n`;
    const error = JSON.stringify({
      type: "error",
      content: "[API Error: RESOURCE_EXHAUSTED … reset after 2h0m0s]",
    });
    writeFileSync(f, `${filler.repeat(Math.ceil((6 * MB) / filler.length))}${error}\n`);
    const handler = geminiHooks({ closed: () => closed(), program: () => "/bin/true" });
    await runHook(
      handler,
      "AfterAgent",
      JSON.stringify({
        session_id: SID,
        transcript_path: f,
        cwd: dir,
        hook_event_name: "AfterAgent",
      }),
      { GEMINI_SESSION_ID: SID },
      state,
      NOW,
    );
    const bytes = new SessionRecords(state, "gemini-cli").get(SID)?.historyBytes ?? 0;
    expect(bytes).toBeGreaterThan(6 * MB);
  });
});
