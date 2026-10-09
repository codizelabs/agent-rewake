import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Schedule } from "../src/core/store.js";
import {
  buildReport,
  ISSUE_URL,
  type ReportInput,
  redactor,
  writeReport,
} from "../src/doctor-report.js";
import type { SessionRecord } from "../src/hosts/sessions.js";
import { readInstalled, recordInstall } from "../src/util/installed.js";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const HOME = "/Users/someone";
const SESSION = "019f3a2c-1111-2222-3333-444455556666";

const schedule = (id: string, status: Schedule["status"], host?: string): Schedule => ({
  schemaVersion: 1,
  scheduleId: id,
  sessionId: SESSION,
  cwd: `${HOME}/client-project`,
  kind: "limit_resume",
  text: "PRIVATE message text",
  dueAt: NOW + 3_600_000,
  createdBy: "auto",
  status,
  attempts: [],
  createdAt: NOW - 1000,
  updatedAt: NOW,
  ...(host && { host, sessionRef: { threadId: SESSION } }),
});

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  schemaVersion: 1,
  host: "grok",
  sessionId: "grok-session-abc123",
  cwd: `${HOME}/client-project`,
  open: false,
  closedAt: NOW - 60_000,
  lastPromptAt: NOW - 120_000,
  limit: { kind: "session", billing: false, resetsAt: NOW + 3_600_000, seenAt: NOW - 90_000 },
  updatedAt: NOW,
  ...over,
});

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    version: "0.3.1",
    nodeVersion: "24.1.0",
    platform: "darwin arm64",
    now: NOW,
    home: HOME,
    findings: [{ area: "Rewake", level: "todo", text: "Something to do.", fix: "Do it." }],
    details: [
      `Rewake's folder: ~/.local/state/agent-rewake`,
      `Zed settings folder: ${HOME}/.config/zed`,
    ],
    logs: [
      {
        t: NOW - 5000,
        level: "error",
        event: "agent.resolve_failed",
        agent: "codex-acp",
        message: `ENOENT ${HOME}/.cache/x`,
        pid: 99,
      },
      { t: NOW - 4000, level: "warn", event: "agent.restarted", agent: "claude-acp" },
      { t: NOW - 3000, level: "info", event: "menu.action", action: "schedule" },
      { t: NOW - 2000, level: "info", event: "fire.decide", host: "codex", action: "send" },
      { t: NOW - 1000, level: "info", event: "fire.done", outcome: "sent" },
      {
        t: NOW - 500,
        level: "warn",
        event: "x.y",
        text: "PRIVATE message text",
        cwd: `${HOME}/client-project`,
      },
    ],
    schedules: [
      schedule("aaaaaaaa-0000-4000-8000-000000000001", "scheduled", "codex"),
      schedule("aaaaaaaa-0000-4000-8000-000000000002", "scheduled", "codex"),
      schedule("aaaaaaaa-0000-4000-8000-000000000003", "sent", "codex"),
      schedule("aaaaaaaa-0000-4000-8000-000000000004", "scheduled"),
    ],
    timerArmed: (id) => id.endsWith("1"),
    timerKind: "launchd",
    sessions: [
      {
        host: "grok",
        name: "Grok Build",
        records: [record(), record({ open: true, sessionId: "grok-session-def456" })],
      },
      { host: "codex", name: "Codex", records: [] },
    ],
    ...over,
  };
}

describe("doctor --report text (G67)", () => {
  const text = buildReport(input());

  it("covers recent warnings and errors, timers, sessions per agent and the last decisions", () => {
    expect(text).toContain("== Warnings and errors, last 14 days ==");
    expect(text).toContain("error agent.resolve_failed agent=codex-acp message=ENOENT ~/.cache/x");
    expect(text).toContain("warn agent.restarted agent=claude-acp");
    expect(text).not.toContain("menu.action");
    expect(text).toContain("Scheduler: launchd");
    expect(text).toContain(
      "Planned resumes outside Zed on file: 2; with a timer set: 1; without: 1",
    );
    expect(text).toContain("NO TIMER");
    expect(text).toContain("timer set");
    expect(text).toContain("codex: messages scheduled 2, sent 1");
    expect(text).toContain("zed: messages scheduled 1");
    expect(text).toContain("Grok Build: 2 sessions known (1 open)");
    expect(text).toContain(
      "closed 2026-10-08T11:59:00.000Z, last prompt 2026-10-08T11:58:00.000Z, limit session resets",
    );
    expect(text).toContain("fire.decide host=codex action=send");
    expect(text).toContain("fire.done outcome=sent");
    expect(text).toContain("Something to do.");
    expect(text).toContain("Zed settings folder: ~/.config/zed");
  });

  it("shows paths as ~, hashes session ids, and has no message text or folder names", () => {
    for (const secret of [HOME, SESSION, "grok-session-abc123", "PRIVATE", "client-project", "pid"])
      expect(text, secret).not.toContain(secret);
    expect(text).toMatch(/id-[0-9a-f]{8}/);
    // The same id gets the same hash, so lines can still be matched up.
    const redact = redactor(HOME, [SESSION]);
    expect(redact(`${SESSION} and ${SESSION}`)).toBe(`${redact(SESSION)} and ${redact(SESSION)}`);
    expect(redact(`${HOME}/a and ${HOME}/b`)).toBe("~/a and ~/b");
    expect(redact("C:\\Users\\someone\\x")).toBe("C:\\Users\\someone\\x");
    expect(redactor("C:\\Users\\someone", [])("C:\\Users\\someone\\x and C:/Users/someone/y")).toBe(
      "~\\x and ~/y",
    );
  });

  it("ends with the issue link, to open by hand", () => {
    expect(text).toContain(`open ${ISSUE_URL} and attach this file`);
    expect(ISSUE_URL).toBe("https://github.com/codizelabs/agent-rewake/issues/new/choose");
  });

  it("says so when there is nothing to report", () => {
    const empty = buildReport(
      input({
        logs: [],
        schedules: [],
        sessions: [],
        timerKind: undefined,
        timerArmed: () => undefined,
      }),
    );
    expect(empty).toContain("none on this computer");
    expect(empty).toContain("no messages on file");
    expect(empty).toContain("nothing recorded");
  });
});

describe("writing the report", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rewake-report-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes one owner-only file in Rewake's own folder", () => {
    const file = writeReport(dir, NOW, "hello\n");
    expect(file).toBe(join(dir, "reports", "agent-rewake-report-2026-10-08T12-00-00.txt"));
    expect(readFileSync(file, "utf8")).toBe("hello\n");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
  });
});

describe("the install time kept for doctor (G70)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rewake-installed-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps the first time for a version and starts over for a new one", () => {
    expect(readInstalled(dir)).toBeUndefined();
    recordInstall(dir, "0.3.1", 1000);
    recordInstall(dir, "0.3.1", 5000);
    expect(readInstalled(dir)).toEqual({ version: "0.3.1", at: 1000 });
    recordInstall(dir, "0.4.0", 9000);
    expect(readInstalled(dir)).toEqual({ version: "0.4.0", at: 9000 });
  });

  it("ignores a file that isn't a record", () => {
    writeFileSync(join(dir, "installed.json"), '{"version": 3, "at": "x"}');
    expect(readInstalled(dir)).toBeUndefined();
    writeFileSync(join(dir, "installed.json"), "not json");
    expect(readInstalled(dir)).toBeUndefined();
  });
});
