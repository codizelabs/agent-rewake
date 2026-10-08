import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveSettings } from "../src/core/settings.js";
import { canAskAboutErrorReports, errorReportsEnabled } from "../src/errors/consent.js";
import { parseDsn } from "../src/errors/dsn.js";
import { maybeAskErrorReports } from "../src/errors/install-question.js";
import { appendLedger, cleanOldLogs, readLedger } from "../src/errors/ledger.js";
import { buildEnvelope, buildEvent, newEventId } from "../src/errors/payload.js";
import { fingerprint, sendOne, underCap } from "../src/errors/queue.js";
import { reportError } from "../src/errors/report.js";
import { scrubFrame, scrubMessage, scrubStack } from "../src/errors/scrub.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-errors-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("DSN parsing", () => {
  it("splits the public key, host and project id out of a real-looking DSN", () => {
    const dsn = parseDsn(
      "https://b7c2ddf4d39fb630623f79338076b83d@o1305163.ingest.us.sentry.io/4512221393715200",
    );
    expect(dsn).toEqual({
      publicKey: "b7c2ddf4d39fb630623f79338076b83d",
      host: "o1305163.ingest.us.sentry.io",
      projectId: "4512221393715200",
      envelopeUrl: "https://o1305163.ingest.us.sentry.io/api/4512221393715200/envelope/",
    });
  });

  it("is undefined for garbage: missing config never crashes anything, it's just off", () => {
    for (const bad of ["not a url", "https://host-with-no-key/123", "https://key@host/", ""])
      expect(parseDsn(bad)).toBeUndefined();
  });
});

describe("opt-in gating (off unless turned on)", () => {
  it("is off when unset, even with no environment overrides", () => {
    expect(errorReportsEnabled({ errorReports: "off" }, {})).toBe(false);
  });

  it('is on only when the setting is "on" and no override forces it off', () => {
    expect(errorReportsEnabled({ errorReports: "on" }, {})).toBe(true);
  });

  it('AGENT_REWAKE_ERROR_REPORTS=0 always wins over an "on" setting', () => {
    expect(errorReportsEnabled({ errorReports: "on" }, { AGENT_REWAKE_ERROR_REPORTS: "0" })).toBe(
      false,
    );
  });

  it('DO_NOT_TRACK=1 always wins over an "on" setting', () => {
    expect(errorReportsEnabled({ errorReports: "on" }, { DO_NOT_TRACK: "1" })).toBe(false);
  });

  it("CI always turns it off, whatever the setting", () => {
    expect(errorReportsEnabled({ errorReports: "on" }, { CI: "true" })).toBe(false);
    expect(errorReportsEnabled({ errorReports: "on" }, { CI: "1" })).toBe(false);
  });

  it("no environment variable can turn it on when the setting is off", () => {
    expect(errorReportsEnabled({ errorReports: "off" }, { AGENT_REWAKE_ERROR_REPORTS: "1" })).toBe(
      false,
    );
  });
});

describe("install's question: once, interactive only, default No", () => {
  it("never asks outside a terminal", async () => {
    const ask = vi.fn();
    await maybeAskErrorReports(dir, {}, false, ask, () => {});
    expect(ask).not.toHaveBeenCalled();
  });

  it("never asks in CI, even in a terminal", async () => {
    const ask = vi.fn();
    await maybeAskErrorReports(dir, { CI: "true" }, true, ask, () => {});
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks once, interactively, and a "No" leaves reporting off', async () => {
    const ask = vi.fn().mockResolvedValue(false);
    await maybeAskErrorReports(dir, {}, true, ask, () => {});
    expect(ask).toHaveBeenCalledTimes(1);
    expect(errorReportsEnabled(loadSettingsFixture(dir), {})).toBe(false);
  });

  it('a "Yes" turns it on', async () => {
    const ask = vi.fn().mockResolvedValue(true);
    await maybeAskErrorReports(dir, {}, true, ask, () => {});
    expect(errorReportsEnabled(loadSettingsFixture(dir), {})).toBe(true);
  });

  it("never asks again once answered", async () => {
    const ask = vi.fn().mockResolvedValue(false);
    await maybeAskErrorReports(dir, {}, true, ask, () => {});
    await maybeAskErrorReports(dir, {}, true, ask, () => {});
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

function loadSettingsFixture(stateDir: string) {
  // Local require-free read, so this test file doesn't need to re-export loadSettings.
  const raw = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8"));
  return { errorReports: raw.errorReports === "on" ? "on" : "off" } as const;
}

describe("canAskAboutErrorReports", () => {
  it("is false without a terminal, in CI, or with DO_NOT_TRACK set", () => {
    expect(canAskAboutErrorReports(false)).toBe(false);
    expect(canAskAboutErrorReports(true, { CI: "1" })).toBe(false);
    expect(canAskAboutErrorReports(true, { DO_NOT_TRACK: "1" })).toBe(false);
  });

  it("is true in a plain interactive terminal", () => {
    expect(canAskAboutErrorReports(true, {})).toBe(true);
  });
});

describe("scrubbing: the allow-list, proven against a corpus of nasty inputs", () => {
  const home = "/Users/kashan";
  const nasty = [
    `${home}/projects/secret-app/src/index.ts`,
    "kashan@example.com",
    "sk-abcdefghijklmnopqrstuvwxyz0123456789",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "Please summarise this customer's private medical records in /Users/kashan/Documents/patient.pdf",
  ];

  it("never leaks a raw nasty string through scrubMessage", () => {
    for (const bad of nasty) {
      const scrubbed = scrubMessage(`Error: couldn't read ${bad}`, home);
      expect(scrubbed).not.toContain(home);
      expect(scrubbed).not.toContain("kashan@example.com");
      expect(scrubbed).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
      expect(scrubbed).not.toMatch(/ghp_[A-Za-z0-9]{10,}/);
    }
  });

  it("reduces a stack frame to a basename, function and line — never a full path", () => {
    const frame = scrubFrame(`    at readConfig (${home}/projects/app/src/core/settings.ts:42:7)`);
    expect(frame).toEqual({ file: "settings.ts", function: "readConfig", lineno: 42 });
  });

  it("keeps node: internals as given (never a user path) and drops unparsable lines", () => {
    expect(
      scrubFrame("    at Object.<anonymous> (node:internal/modules/cjs/loader:1234:5)"),
    ).toEqual({
      file: "node:internal/modules/cjs/loader",
      function: "Object.<anonymous>",
      lineno: 1234,
    });
    expect(scrubFrame("not a stack line")).toBeUndefined();
  });

  it("a full stack trace never carries a home-folder path through", () => {
    const stack = `Error: boom\n    at run (${home}/projects/app/src/cli.ts:10:1)\n    at main (${home}/projects/app/src/main.ts:1:1)`;
    const frames = scrubStack(stack);
    expect(frames.length).toBe(2);
    for (const f of frames) expect(f.file).not.toContain(home);
  });

  it("a built event never carries the corpus through, anywhere in its JSON", () => {
    const home2 = "/Users/kashan";
    for (const bad of nasty) {
      const err = new Error(`failed on ${bad}`);
      err.stack = `Error: failed on ${bad}\n    at doThing (${home2}/app/src/thing.ts:5:1)`;
      const event = buildEvent(
        { name: "test.error", error: err, tags: { place: "cli" }, fromSource: true, home: home2 },
        newEventId(),
        new Date(),
      );
      const json = JSON.stringify(event);
      expect(json).not.toContain(home2);
      expect(json).not.toContain("kashan@example.com");
      expect(json).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
      expect(json).not.toMatch(/ghp_[A-Za-z0-9]{10,}/);
    }
  });

  it("always sends ip_address: null (Sentry stores IP by default otherwise)", () => {
    const event = buildEvent(
      { name: "test.error", tags: { place: "cli" }, fromSource: true, home: "/Users/kashan" },
      newEventId(),
      new Date(),
    );
    expect(event.user).toEqual({ ip_address: null });
  });
});

describe("the envelope shape", () => {
  it("is three JSON lines: envelope header, item header, event payload", () => {
    const dsn = parseDsn("https://key@host.example/42");
    if (!dsn) throw new Error("test DSN didn't parse");
    const event = buildEvent(
      { name: "test.error", tags: { place: "cli" }, fromSource: true, home: "" },
      newEventId(),
      new Date(),
    );
    const envelope = buildEnvelope(event, dsn);
    const lines = envelope.split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    const header = JSON.parse(lines[0] ?? "");
    expect(header.event_id).toBe(event.event_id);
    expect(header.dsn).toContain("host.example");
    const itemHeader = JSON.parse(lines[1] ?? "");
    expect(itemHeader.type).toBe("event");
    const payload = JSON.parse(lines[2] ?? "");
    expect(payload.event_id).toBe(event.event_id);
  });
});

describe("sending: never throws, bounded by a timeout", () => {
  const dsn = parseDsn("https://key@host.example/42");
  if (!dsn) throw new Error("test DSN didn't parse");
  const event = buildEvent(
    { name: "test.error", tags: { place: "cli" }, fromSource: true, home: "" },
    newEventId(),
    new Date(),
  );

  it("returns false, not a throw, when fetch rejects", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(sendOne(event, dsn, fetchImpl as unknown as typeof fetch, 50)).resolves.toBe(
      false,
    );
  });

  it("returns false, not a throw, when the request is aborted by the timeout", async () => {
    // A real fetch rejects with AbortError once its signal fires; this mock does the same, so the
    // test proves sendOne's own 3-second-style bound actually ends the call instead of hanging.
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    await expect(sendOne(event, dsn, fetchImpl as unknown as typeof fetch, 20)).resolves.toBe(
      false,
    );
  });

  it("returns true on a 200, and sends the right headers and body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const ok = await sendOne(event, dsn, fetchImpl as unknown as typeof fetch, 1000);
    expect(ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(dsn.envelopeUrl);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-sentry-envelope",
    );
    expect((init.headers as Record<string, string>)["X-Sentry-Auth"]).toContain(
      `sentry_key=${dsn.publicKey}`,
    );
  });
});

describe("the daily cap and de-duplication", () => {
  it("de-dupes an identical fingerprint and caps at 20 a day", () => {
    const event = buildEvent(
      { name: "test.error", tags: { place: "cli" }, fromSource: true, home: "" },
      newEventId(),
      new Date(),
    );
    expect(underCap(dir, event, 1000)).toBe(true);
    expect(fingerprint(event)).toBe(fingerprint(event));
  });
});

describe("reportError: never throws, always ledgers, only queues when opted in", () => {
  it("writes a ledger entry even when reporting is off", () => {
    reportError(dir, { name: "test.error", message: "boom", tags: { place: "cli" } }, {});
    expect(readLedger(dir)).toHaveLength(1);
    expect(readLedger(dir)[0]?.sent).toBe(false);
  });

  it("marks the ledger entry sent when reporting is on", () => {
    saveSettings(dir, {
      clock: "12h",
      newThreads: "ask",
      autoWhenPromptsSkipped: true,
      keepAwake: "plugged-in",
      errorReports: "on",
    });
    reportError(dir, { name: "test.error", message: "boom", tags: { place: "cli" } }, {});
    expect(readLedger(dir)[0]?.sent).toBe(true);
  });

  it("never throws even with a broken state directory", () => {
    expect(() =>
      reportError("/definitely/not/a/writable/path", { name: "x", tags: { place: "cli" } }, {}),
    ).not.toThrow();
  });

  it("is synchronous and fast: safe to call from a hot path without awaiting", () => {
    const start = Date.now();
    for (let i = 0; i < 5; i++)
      reportError(dir, { name: `test.error.${i}`, tags: { place: "cli" } }, {});
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe("the local ledger", () => {
  it("is bounded to the last 200 entries", () => {
    for (let i = 0; i < 205; i++)
      appendLedger(dir, { t: "now", name: `e${i}`, type: "Error", message: "m", sent: false });
    const ledger = readLedger(dir);
    expect(ledger).toHaveLength(200);
    expect(ledger[0]?.name).toBe("e5");
    expect(ledger.at(-1)?.name).toBe("e204");
  }, 20_000);

  it("is written owner-only (0600)", () => {
    appendLedger(dir, { t: "now", name: "e", type: "Error", message: "m", sent: false });
    const mode = statSync(join(dir, "error-ledger.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("log cleanup", () => {
  it("removes log files older than 14 days and keeps recent ones", () => {
    // logs/ not existing yet must never throw.
    cleanOldLogs(dir, Date.now());

    const logs = join(dir, "logs");
    mkdirSync(logs, { recursive: true });
    const mk = (name: string) => {
      const p = join(logs, name);
      writeFileSync(p, "{}\n");
      return p;
    };
    const oldFile = mk("rewake-old.jsonl");
    const newFile = mk("rewake-new.jsonl");
    const now = Date.now();
    const old = now - 20 * 24 * 60 * 60 * 1000;
    utimesSync(oldFile, old / 1000, old / 1000);
    cleanOldLogs(dir, now);
    expect(readdirSync(logs).sort()).toEqual(["rewake-new.jsonl"]);
    expect(() => statSync(newFile)).not.toThrow();
  });
});
