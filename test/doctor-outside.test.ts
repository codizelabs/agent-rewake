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
