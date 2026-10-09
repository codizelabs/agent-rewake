import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScheduleStore } from "../src/core/store.js";
import { resumeAgy } from "../src/hosts/antigravity/host.js";
import { armClosed, closedAdapter } from "../src/hosts/closed.js";
import { copilotHost, resumeCopilot } from "../src/hosts/copilot/host.js";
import { resumeGemini } from "../src/hosts/gemini/host.js";
import { resumeGrok } from "../src/hosts/grok/host.js";
import { folderGone } from "../src/hosts/host.js";
import { type SessionRecord, SessionRecords } from "../src/hosts/sessions.js";
import "../src/hosts/index.js"; // registers the hosts
import { fire, notice } from "../src/timers/fire.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const NOW = new Date(2026, 9, 7, 15, 2).getTime();
const SID = "8a3c1f2e-0b5d-4c7a-9e21-3f6b8d0c4a17";
const FOLDER_GONE = { ok: false, reason: "failed", detail: "folder-gone" };

let dir: string;
let state: string;
let shop: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "rewake-folder-")));
  state = join(dir, "state");
  shop = join(dir, "shop");
  mkdirSync(shop);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A closed session's record whose folder was moved: nothing exists at its recorded folder. */
function movedRecord(host: string, program: string): SessionRecord {
  const r = new SessionRecords(state, host).update(SID, shop, NOW, (x) => ({ ...x, program }));
  if (!r) throw new Error("no session record");
  renameSync(shop, join(dir, "shop-renamed"));
  return r;
}

describe("a project folder that moved", () => {
  it("is told apart from one that is there, or none recorded", () => {
    writeFileSync(join(dir, "file"), "x");
    expect(folderGone(shop)).toBe(false);
    expect(folderGone(join(dir, "nope"))).toBe(true);
    expect(folderGone(join(dir, "file"))).toBe(true);
    expect(folderGone("")).toBe(false);
    expect(folderGone(undefined)).toBe(false);
  });

  it("stops each host's resume before it starts the agent", async () => {
    const log = join(dir, "agent.log");
    const env = {
      ...process.env,
      FAKE_COPILOT_LOG: log,
      FAKE_RESUME_LOG: log,
      FAKE_GROK_LOG: log,
      GROK_HOME: join(dir, "grok"),
    };
    const runs: [string, (r: SessionRecord) => Promise<unknown>, string][] = [
      ["copilot-cli", (r) => resumeCopilot(r, "Continue.", env), "fake-copilot.mjs"],
      ["gemini-cli", (r) => resumeGemini(r, "Continue.", env), "fake-resume.mjs"],
      ["grok", (r) => resumeGrok(r, "Continue.", env), "fake-grok.mjs"],
      ["antigravity", (r) => resumeAgy(r, "Continue.", env), "fake-resume.mjs"],
    ];
    for (const [host, resume, program] of runs) {
      mkdirSync(shop, { recursive: true });
      const r = movedRecord(host, fixture(program));
      expect(await resume(r)).toEqual(FOLDER_GONE);
      rmSync(join(dir, "shop-renamed"), { recursive: true, force: true });
    }
    // None of them started the agent.
    expect(existsSync(log)).toBe(false);
  });

  it("tells the person to open the session from its new folder, and never sends", async () => {
    const log = join(dir, "copilot.log");
    const env = { ...process.env, FAKE_COPILOT_LOG: log };
    const r = movedRecord("copilot-cli", fixture("fake-copilot.mjs"));
    const due = armClosed(copilotHost, r, NOW - 60_000, {
      stateDir: state,
      now: NOW - 3 * 60_000,
      env,
      arm: () => {},
      disarm: () => {},
      notify: () => {},
    });
    const told: string[] = [];
    const outcome = await fire(due.scheduleId, {
      stateDir: state,
      now: () => NOW,
      hosts: new Map([["copilot-cli", closedAdapter(copilotHost, state, env)]]),
      notify: (_title, body) => {
        told.push(body);
        return true;
      },
    });
    expect(outcome).toBe("failed");
    const settled = new ScheduleStore(state).get(due.scheduleId);
    expect(settled).toMatchObject({ status: "failed", failureReason: "folder-gone" });
    expect(told).toEqual([
      'GitHub Copilot CLI in the "shop" folder: Rewake couldn\'t continue the session because the project folder is gone (moved, renamed or deleted). Open the session from its new folder to continue.',
    ]);
    expect(existsSync(log)).toBe(false);
  });

  it("has its own notice wording, not the generic one", () => {
    const text = notice("failed", "Grok Build", NOW, {
      noun: "session",
      agentName: "Grok Build",
      cause: "folder-gone",
    });
    expect(text).toContain("the project folder is gone");
    expect(text).not.toContain("couldn't continue the session. ");
  });
});
