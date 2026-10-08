import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerHost, ScheduleStore } from "../src/core/store.js";
import { when } from "../src/doctor.js";
import { diagnoseOutside, type OutsideFacts } from "../src/hosts/doctor.js";
import type { HostAdapter } from "../src/hosts/host.js";
import { hooksTurnedOff } from "../src/hosts/policy.js";

registerHost("copilot-cli");
const NOW = Date.parse("2026-10-07T12:00:00Z");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-doctor-outside-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const facts = (o: Partial<OutsideFacts> = {}): OutsideFacts => ({
  stateDir: join(dir, "state"),
  env: { HOME: dir },
  home: dir,
  now: NOW,
  platform: "linux",
  previews: [{ id: "copilot-cli", name: "GitHub Copilot CLI" }],
  hosts: new Map([["copilot-cli", { name: "GitHub Copilot CLI" } as HostAdapter]]),
  hasTimer: true,
  when,
  ...o,
});

describe("doctor: outside Zed", () => {
  it("says nothing when no preview is set up", () => {
    expect(diagnoseOutside(facts({ previews: [] }))).toEqual([]);
  });

  it("reports an agent whose own settings turn hooks off, and a computer with no timer", () => {
    mkdirSync(join(dir, ".copilot"));
    writeFileSync(join(dir, ".copilot", "settings.json"), '{ "disableAllHooks": true }');
    expect(hooksTurnedOff("copilot-cli", { HOME: dir }, dir)).toContain("disableAllHooks");
    const out = diagnoseOutside(facts({ hasTimer: false }));
    expect(out.map((f) => [f.area, f.level])).toEqual([
      ["Outside Zed", "problem"],
      ["Outside Zed", "problem"],
    ]);
    expect(out[0]?.text).toContain("GitHub Copilot CLI has its hooks turned off");
    expect(out[1]?.fix).toContain("install and start the at service");
  });

  it("names an agent too old for Rewake, set up or not, and one newer than tested", () => {
    const agents = [
      { id: "copilot-cli" as const, version: "1.0.80" },
      { id: "claude-code" as const, version: "2.1.282" },
    ];
    const out = diagnoseOutside(facts({ agents }));
    expect(out[0]).toMatchObject({
      level: "problem",
      text: "GitHub Copilot CLI 1.0.80 is too old for Rewake (it needs 1.0.92 or newer), so Rewake may miss its usage limits.",
      fix: "Update it with: copilot update (or npm install -g @github/copilot@latest)",
    });
    expect(out[1]).toMatchObject({
      level: "info",
      text: "Claude Code 2.1.282 is too old for Rewake (it needs 2.1.287 or newer), so Rewake isn't set up for it.",
      fix: "Update it with: claude update (or brew upgrade claude-code@latest), then run: agent-rewake install --only claude-code",
    });

    // With no preview set up, the too-old note still shows; a newer version is only noted when set up.
    const none = diagnoseOutside(facts({ previews: [], agents }));
    expect(none.map((f) => f.level)).toEqual(["info", "info"]);
    const newer = diagnoseOutside(
      facts({
        previews: [{ id: "codex", name: "Codex" }],
        agents: [{ id: "codex", version: "0.170.0" }],
      }),
    );
    expect(newer[0]?.text).toBe(
      "Codex 0.170.0 is newer than the versions Rewake was tested with (up to 0.160.1). It should still work; if Rewake misses a usage limit there, report it with agent-rewake doctor --details.",
    );
    expect(
      diagnoseOutside(
        facts({
          previews: [],
          agents: [{ id: "codex", version: "0.170.0" }],
        }),
      ),
    ).toEqual([]);
  });

  it("lists the next planned resume and the ones that need the person, never Zed's", () => {
    const store = new ScheduleStore(join(dir, "state"));
    const mk = (status: "scheduled" | "needs_attention", host?: string) => {
      const s = store.create({
        sessionId: "s",
        cwd: "/w",
        text: "Continue.",
        dueAt: NOW + 3_600_000,
        createdBy: "auto",
        now: NOW,
      });
      store.put({ ...s, status, ...(host && { host }) });
    };
    mk("scheduled", "copilot-cli");
    mk("needs_attention", "copilot-cli");
    mk("scheduled"); // Zed's own: reported in Zed's section
    const out = diagnoseOutside(facts());
    expect(out.map((f) => f.level)).toEqual(["ok", "todo"]);
    expect(out[0]?.text).toMatch(/^1 planned resume; the next one continues GitHub Copilot CLI /);
    expect(out[1]?.fix).toBe("Review it with: agent-rewake ui");
  });

  it("shows Claude Code's planned continues and the sessions waiting for an answer", () => {
    const sessions = join(dir, "state", "hosts", "claude-code", "sessions");
    mkdirSync(sessions, { recursive: true });
    const rec = (id: string, state: string, extra: Record<string, unknown> = {}) =>
      writeFileSync(
        join(sessions, `${id}.json`),
        JSON.stringify({
          schemaVersion: 1,
          host: "claude-code",
          sessionId: id,
          state,
          updatedAt: NOW,
          ...extra,
        }),
      );
    rec("a", "armed", { cwd: "/w/shop", fireAt: NOW + 30 * 60_000 });
    rec("b", "offered", { resetAt: NOW + 60 * 60_000, cwd: "/w/shop" });
    rec("c", "sent", { fireAt: NOW - 60_000 });
    rec("old", "armed", { fireAt: NOW + 60_000, updatedAt: NOW - 3 * 86_400_000 });
    const out = diagnoseOutside(facts({ previews: [{ id: "claude-code", name: "Claude Code" }] }));
    expect(out.map((f) => f.level)).toEqual(["ok", "todo"]);
    expect(out[0]?.text).toMatch(
      /^1 planned resume; the next one continues Claude Code .+\. Keep this computer on and awake, and Claude Code open, then\.$/,
    );
    expect(out[1]).toMatchObject({
      text: '1 Claude Code session (in the "shop" folder) is waiting for your answer: continue it after the reset?',
      fix: "Answer Rewake's question there, or type /rewake.",
    });
  });

  it("says where Rewake is set up when there's nothing else to say", () => {
    expect(diagnoseOutside(facts())).toEqual([
      {
        area: "Outside Zed",
        level: "ok",
        text: "Set up in GitHub Copilot CLI. Nothing planned right now.",
      },
    ]);
  });
});
