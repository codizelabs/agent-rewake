import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Schedule } from "../src/core/store.js";
import { codexAdapter } from "../src/hosts/codex/adapter.js";
import { userMessages } from "../src/hosts/codex/rollout.js";

/**
 * After a crashed send, `delivered()` settles the resume from the thread's session file. A second
 * limit in one thread repeats the first resume's exact words, so only records written since the
 * attempt started may count.
 */
const TEXT = "[Sent automatically by Agent Rewake after the usage limit reset] Continue.";
const FIRST = Date.parse("2026-10-07T10:00:05Z");
const SECOND = Date.parse("2026-10-07T15:00:05Z");

const record = (text: string, at: string) =>
  JSON.stringify({
    timestamp: at,
    type: "event_msg",
    payload: {
      type: "item_completed",
      thread_id: "t",
      turn_id: "u",
      item: { type: "UserMessage", id: "i", content: [{ type: "text", text, text_elements: [] }] },
    },
  });

let dir: string;
let rollout: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-delivered-"));
  rollout = join(dir, "rollout.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function resume(startedAt: number | undefined): Schedule {
  return {
    schemaVersion: 1,
    scheduleId: "s1",
    sessionId: "t",
    cwd: "/work",
    kind: "limit_resume",
    text: TEXT,
    dueAt: SECOND,
    createdBy: "auto",
    status: "sending",
    attempts: startedAt === undefined ? [] : [{ n: 1, idempotencyKey: "s1:1", startedAt }],
    createdAt: FIRST,
    updatedAt: SECOND,
    sessionRef: { transcript: rollout },
  } as Schedule;
}
const adapter = () => codexAdapter({ env: {}, node: "node" });

describe("Codex delivered()", () => {
  it("does not count an earlier resume's identical message", () => {
    writeFileSync(rollout, `${record(TEXT, "2026-10-07T10:00:06Z")}\n`);
    expect(adapter().delivered?.(resume(SECOND))).toBeUndefined();
  });

  it("counts the message written after this attempt started", () => {
    writeFileSync(
      rollout,
      `${[record(TEXT, "2026-10-07T10:00:06Z"), record(TEXT, "2026-10-07T15:00:07Z")].join("\n")}\n`,
    );
    expect(adapter().delivered?.(resume(SECOND))).toBe(true);
  });

  it("can't tell without an attempt, or when the record has no readable time", () => {
    writeFileSync(rollout, `${record(TEXT, "2026-10-07T15:00:07Z")}\n`);
    expect(adapter().delivered?.(resume(undefined))).toBeUndefined();
    writeFileSync(rollout, `${record(TEXT, "not a time")}\n`);
    expect(adapter().delivered?.(resume(SECOND))).toBeUndefined();
  });
});

describe("userMessages since a time", () => {
  it("keeps only records at or after it", () => {
    const tail = [
      record("old", "2026-10-07T10:00:00Z"),
      record("new", "2026-10-07T15:00:05Z"),
    ].join("\n");
    expect(userMessages(tail)).toEqual(["old", "new"]);
    expect(userMessages(tail, SECOND)).toEqual(["new"]);
  });
});
