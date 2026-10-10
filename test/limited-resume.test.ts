import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_REARMS, RESET_MARGIN_MS } from "../src/core/resume.js";
import { DEFAULT_SETTINGS, saveSettings } from "../src/core/settings.js";
import { ScheduleStore } from "../src/core/store.js";
import { antigravityHost } from "../src/hosts/antigravity/host.js";
import { armClosed, type ClosedDeps, type ClosedHost, closedAdapter } from "../src/hosts/closed.js";
import { grokHost } from "../src/hosts/grok/host.js";
import "../src/hosts/index.js";
import { SessionRecords } from "../src/hosts/sessions.js";
import { fire } from "../src/timers/fire.js";

/**
 * A headless resume that comes back still limited, for the two agents whose usage Rewake can't
 * look up beforehand (it makes no network calls and never reads credentials): the limit message
 * is the only signal, and it must re-arm within the bound rather than count as a plain failure.
 */

const H = 3_600_000;
const SID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";

let dir: string;
let state: string;
let grokHome: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "rewake-closed-")));
  state = join(dir, "state");
  grokHome = join(dir, ".grok");
  mkdirSync(join(grokHome, "logs"), { recursive: true });
  saveSettings(state, DEFAULT_SETTINGS);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Case {
  name: string;
  host: () => ClosedHost;
  /** A stub agent, still at its limit, that states no reset time. */
  noReset: string;
  /** A stub agent, still at its limit, that states a reset `ms` from now. */
  withReset: (ms: number) => string;
}

const cases: Case[] = [
  {
    name: "Grok Build",
    host: () => grokHost(process.env),
    noReset: 'process.stderr.write("You have reached your weekly limit.\\n");\nprocess.exit(1);\n',
    // Grok gives its reset in the billing line its run logged.
    withReset: (ms) => {
      writeFileSync(
        join(grokHome, "logs", "unified.jsonl"),
        `${JSON.stringify({ ts: "x", msg: "billing: fetched credits config", ctx: { config: { creditUsagePercent: 100, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: new Date(Date.now() + ms).toISOString() } } } })}\n`,
      );
      return 'process.stderr.write("You have reached your weekly limit.\\n");\nprocess.exit(1);\n';
    },
  },
  {
    name: "Antigravity CLI",
    host: () => antigravityHost(() => false),
    noReset:
      'process.stdout.write(JSON.stringify({ error: "RESOURCE_EXHAUSTED: Individual quota reached." }) + "\\n");\nprocess.exit(1);\n',
    withReset: (ms) =>
      `process.stdout.write(JSON.stringify({ error: "RESOURCE_EXHAUSTED: Individual quota reached. Resets in ${Math.round(ms / 60_000)}m0s" }) + "\\n");\nprocess.exit(1);\n`,
  },
];

function armed(c: Case, script: string) {
  const host = c.host();
  const program = join(dir, "agent.mjs");
  writeFileSync(program, script);
  const t0 = Date.now();
  const records = new SessionRecords(state, host.id);
  const r = records.update(SID, dir, t0, (x) => ({ ...x, program }));
  if (!r) throw new Error("no session record");
  const d: ClosedDeps = {
    stateDir: state,
    now: t0,
    env: {},
    arm: () => {},
    disarm: () => {},
    notify: () => {},
  };
  const s = armClosed(host, r, t0 - 1000, d);
  const notes: string[] = [];
  let clock = t0;
  return {
    notes,
    t0,
    at: (t: number) => {
      clock = t;
    },
    get: () => new ScheduleStore(state).get(s.scheduleId),
    run: () =>
      fire(s.scheduleId, {
        stateDir: state,
        now: () => clock,
        hosts: new Map([
          [host.id, closedAdapter(host, state, { ...process.env, GROK_HOME: grokHome })],
        ]),
        notify: (_t, b) => {
          notes.push(b);
          return true;
        },
      }),
  };
}

describe.each(cases)("$name resumed while still limited", (c) => {
  it("waits for the reset it states instead of counting a failure", async () => {
    const a = armed(c, c.withReset(2 * H));
    expect(await a.run()).toBe("waiting");
    const after = a.get();
    expect(after).toMatchObject({ status: "scheduled", rearms: 1 });
    expect(after?.attempts).toMatchObject([{ outcome: "limited" }]);
    // Two hours on, give or take the seconds the run took, plus the margin.
    expect(after?.dueAt).toBeGreaterThanOrEqual(a.t0 + 2 * H - 60_000 + RESET_MARGIN_MS);
    expect(after?.dueAt).toBeLessThanOrEqual(Date.now() + 2 * H + RESET_MARGIN_MS);
    expect(a.notes.some((n) => /still at its usage limit|couldn't continue/.test(n))).toBe(false);
  });

  it("falls back to the capped backoff when no reset is stated, then tells the person", async () => {
    const a = armed(c, c.noReset);
    const waits: number[] = [];
    for (let i = 0; i < MAX_REARMS; i++) {
      expect(await a.run()).toBe("waiting");
      const due = a.get()?.dueAt ?? 0;
      waits.push(due - (i === 0 ? a.t0 : (a.get()?.updatedAt ?? 0)));
      a.at(due);
    }
    expect(a.get()).toMatchObject({ status: "scheduled", rearms: MAX_REARMS });
    expect(waits[0]).toBeGreaterThanOrEqual(2 * 60_000);
    expect(waits[1] ?? 0).toBeGreaterThan(waits[0] ?? 0);
    // Past the bound it stops: failed with one plain notice, and no further run.
    expect(await a.run()).toBe("failed");
    expect(a.get()?.status).toBe("failed");
    expect(a.notes.at(-1)).toContain("is still at its usage limit, so Rewake didn't continue.");
    expect(a.get()?.attempts).toHaveLength(MAX_REARMS + 1);
  }, 30_000);

  it("asks instead of waiting when the stated reset is more than a day away", async () => {
    const a = armed(c, c.withReset(3 * 24 * H));
    expect(await a.run()).toBe("notified");
    expect(a.get()).toMatchObject({ status: "needs_attention" });
    expect(a.notes.at(-1)).toContain("limited again");
  });
});
