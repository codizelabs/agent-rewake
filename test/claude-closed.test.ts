import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runContinue, waiting } from "../src/continue.js";
import { DEFAULT_SETTINGS, saveSettings } from "../src/core/settings.js";
import { ScheduleStore } from "../src/core/store.js";
import { DEFAULT_RESUME_PROMPT } from "../src/core/threads.js";
import {
  CLAUDE_CODE_ID,
  CLAUDE_KEY_VARS,
  CLAUDE_SETTINGS_VARS,
  claudeCodeHost,
  findTranscript,
  limitInRun,
  resumeClaude,
} from "../src/hosts/claude-code/host.js";
import { claudeCodeRecords } from "../src/hosts/claude-code/records.js";
import {
  type ClosedDeps,
  closedAdapter,
  FIRE_ENV,
  reapClosed,
  unanswered,
} from "../src/hosts/closed.js";
import { CLOSED_HOSTS, hostAdapters } from "../src/hosts/index.js";
import { type SessionRecord, SessionRecords } from "../src/hosts/sessions.js";
import { fire } from "../src/timers/fire.js";
import { agentProcess } from "../src/util/proc.js";

/**
 * Claude Code sessions closed at a usage limit (gap G35), offline: a fake `claude`
 * (fixtures/fake-claude.mjs) stands in for the CLI, the session records are written the way
 * Rewake's plugin writes its copy (its own helpers from mod/hooks/logic.js), and everything lives in
 * temp folders: nothing here touches a real ~/.claude, a keychain or a session.
 */
const logicPath = "../src/hosts/claude-code/mod/hooks/logic.js";
const logic = (await import(logicPath)) as {
  FIRE_ENV: string;
  SETTINGS_VARS: string[];
  KEY_VARS: string[];
  limitOf: (ep: Record<string, unknown>) => Record<string, unknown> | undefined;
  parseProcess: (out: string) => { pid: number; name: string } | undefined;
  parseProgram: (out: string) => string | undefined;
  sessionVars: (get: (n: string) => string | undefined) => {
    env?: Record<string, string>;
    keysSet?: string[];
  };
};

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const NOW = new Date(2026, 9, 7, 12, 0).getTime();
const H = 3_600_000;
const SID = "5d1c2e9a-7b34-4f0e-8a61-2c9d4b7e1f03";
const FIRE_AT = NOW + 3 * H + 60_000;
const LATER = new Date(2026, 9, 7, 15, 2).getTime();

let dir: string;
let state: string;
let work: string;
let config: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "rewake-claude-")));
  state = join(dir, "state");
  work = join(dir, "shop");
  config = join(dir, "claude-config");
  mkdirSync(work);
  mkdirSync(join(config, "projects", "-shop"), { recursive: true });
  chmodSync(FAKE, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The plugin's copy of a limit record that nobody answered (mod/hooks/register.js `mirror`). */
function modCopy(over: Record<string, unknown> = {}, episode: Record<string, unknown> = {}) {
  const ep = {
    state: "armed",
    kind: "five_hour",
    createdAt: NOW,
    resetAt: NOW + 3 * H,
    fireAt: FIRE_AT,
    rehits: 0,
    attempts: 0,
    ...episode,
  };
  const limit = logic.limitOf(ep);
  const record = {
    schemaVersion: 1,
    host: "claude-code",
    sessionId: SID,
    cwd: work,
    open: true,
    agents: [{ pid: 4242, name: "claude" }],
    program: FAKE,
    ...(limit && { limit }),
    env: { CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: "https://gateway.example" },
    ...ep,
    updatedAt: NOW,
    ...over,
  };
  const folder = join(state, "hosts", "claude-code", "sessions");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${SID}.json`), `${JSON.stringify(record)}\n`);
}

function harness(settings = DEFAULT_SETTINGS, alive: () => boolean = () => false) {
  saveSettings(state, settings);
  const armed: [string, number][] = [];
  const notes: string[] = [];
  const deps = (now = NOW): ClosedDeps => ({
    stateDir: state,
    now,
    env: {},
    arm: (id, at) => armed.push([id, at]),
    disarm: () => {},
    notify: (_t, b) => notes.push(b),
    running: () => alive(),
  });
  return { armed, notes, deps };
}

const log = () => join(dir, "claude.log");
const calls = () =>
  existsSync(log())
    ? readFileSync(log(), "utf8")
        .trim()
        .split("\n")
        .map(
          (l) =>
            JSON.parse(l) as {
              args: string[];
              cwd: string;
              stdin: string;
              fire: string;
              configDir: string | null;
              baseUrl: string | null;
              hasKey: boolean;
            },
        )
    : [];
const fireDeps = (env: NodeJS.ProcessEnv, now = LATER) => ({
  stateDir: state,
  now: () => now,
  hosts: new Map([
    [
      CLAUDE_CODE_ID,
      closedAdapter(claudeCodeHost, state, { ...process.env, FAKE_CLAUDE_LOG: log(), ...env }),
    ],
  ]),
  notify: () => true,
});

/** The person runs `agent-rewake continue` and picks the one session. */
async function armedByContinue() {
  const h = harness();
  await runContinue({
    hosts: [claudeCodeHost],
    deps: h.deps(),
    interactive: true,
    out: () => {},
    ask: async () => "",
  });
  return new ScheduleStore(state).list()[0]?.scheduleId ?? "";
}

/** The transcript Claude Code keeps for the session, last written at `at`. */
function transcript(at: number): string {
  const path = join(config, "projects", "-shop", `${SID}.jsonl`);
  writeFileSync(path, '{"type":"user"}\n');
  utimesSync(path, at / 1000, at / 1000);
  return path;
}

describe("Claude Code is a closed-session host", () => {
  it("is listed with the other hosts, and fire has an adapter for it", () => {
    expect(CLOSED_HOSTS.map((h) => h.id)).toContain(CLAUDE_CODE_ID);
    expect(hostAdapters({}, process.execPath, state).get(CLAUDE_CODE_ID)?.name).toBe("Claude Code");
  });

  it("records the same variables as the plugin (mod/hooks/logic.js) and never a secret one", () => {
    expect(logic.SETTINGS_VARS).toEqual([...CLAUDE_SETTINGS_VARS]);
    expect(logic.KEY_VARS).toEqual([...CLAUDE_KEY_VARS]);
    expect(logic.FIRE_ENV).toBe(FIRE_ENV);
    expect(
      CLAUDE_SETTINGS_VARS.filter((n) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(n)),
    ).toEqual([]);
    // The plugin reads exactly these names (the mods API takes only literal names).
    const source = readFileSync(
      fileURLToPath(new URL("../src/hosts/claude-code/mod/hooks/register.js", import.meta.url)),
      "utf8",
    );
    const read = [...source.matchAll(/\$\.env\.get\("([A-Z_]+)"\)/g)].map((m) => m[1]).sort();
    expect(read).toEqual(
      [
        ...CLAUDE_SETTINGS_VARS,
        ...CLAUDE_KEY_VARS,
        "CLAUDE_CODE_ENTRYPOINT",
        "AGENT_REWAKE_FIRE",
      ].sort(),
    );
    const vars = logic.sessionVars(
      (n) => ({ ANTHROPIC_API_KEY: "sk-x", CLAUDE_CONFIG_DIR: "/c" })[n as "CLAUDE_CONFIG_DIR"],
    );
    expect(vars).toEqual({ env: { CLAUDE_CONFIG_DIR: "/c" }, keysSet: ["ANTHROPIC_API_KEY"] });
  });

  it("reads the plugin's process lookup", () => {
    expect(logic.parseProcess("4242\n/usr/local/bin/claude\n/home/me/.local/bin/claude\n")).toEqual(
      {
        pid: 4242,
        name: "claude",
      },
    );
    expect(logic.parseProcess("4242\n-zsh\n")).toEqual({ pid: 4242, name: "zsh" });
    expect(logic.parseProcess("abc\nclaude\n")).toBeUndefined();
    expect(logic.parseProcess("4242\n")).toBeUndefined();
    expect(logic.parseProgram("4242\nclaude\n/home/me/.local/bin/claude\n")).toBe(
      "/home/me/.local/bin/claude",
    );
    expect(logic.parseProgram("4242\nclaude\nclaude: not found\n")).toBeUndefined();
  });

  it("reads the plugin's copy as a session record, and doctor still reads it as before", () => {
    modCopy();
    const r = new SessionRecords(state, CLAUDE_CODE_ID).get(SID);
    expect(r).toMatchObject({
      sessionId: SID,
      cwd: work,
      open: true,
      limit: { kind: "session", billing: false, resetsAt: NOW + 3 * H, seenAt: NOW },
      env: { CLAUDE_CONFIG_DIR: config },
    });
    expect(claudeCodeRecords(state, NOW + 1000)).toMatchObject([
      { sessionId: SID, state: "armed", cwd: work },
    ]);
  });
});

describe("which Claude Code sessions agent-rewake continue offers", () => {
  it("offers a closed session whose limit nobody answered", () => {
    modCopy();
    const h = harness();
    const list = waiting({ hosts: [claudeCodeHost], deps: h.deps() });
    expect(list.map((c) => c.record.sessionId)).toEqual([SID]);
    expect(list[0]?.resetsAt).toBe(NOW + 3 * H);
  });

  it("offers one that was only offered or waiting for Claude Code's own continue, once it is closed", () => {
    for (const state_ of ["offered", "native"]) {
      modCopy({}, { state: state_ });
      expect(waiting({ hosts: [claudeCodeHost], deps: harness().deps() })).toHaveLength(1);
    }
  });

  it("leaves a session alone while Claude Code still has it open: the plugin there handles it", () => {
    modCopy();
    expect(
      waiting({ hosts: [claudeCodeHost], deps: harness(DEFAULT_SETTINGS, () => true).deps() }),
    ).toEqual([]);
  });

  it("leaves a limit that was continued, declined or answered by the person", () => {
    // The plugin writes no limit for these: sent, none (declined, cancelled, the person typed).
    for (const state_ of ["sent", "none"]) {
      modCopy({}, { state: state_ });
      expect(waiting({ hosts: [claudeCodeHost], deps: harness().deps() })).toEqual([]);
    }
    modCopy({ lastPromptAt: NOW + 1000 });
    const r = new SessionRecords(state, CLAUDE_CODE_ID).get(SID) as SessionRecord;
    expect(unanswered(state, r)).toBeUndefined();
  });

  it("leaves a limit without a reset time (waiting) and one Rewake already continued", async () => {
    modCopy({}, { state: "waiting", resetAt: undefined });
    expect(waiting({ hosts: [claudeCodeHost], deps: harness().deps() })).toEqual([]);
    modCopy();
    const id = await armedByContinue();
    expect(await fire(id, fireDeps({}))).toBe("sent");
    expect(waiting({ hosts: [claudeCodeHost], deps: harness().deps() })).toEqual([]);
  });

  it("arms at the reset when the person runs continue", async () => {
    modCopy();
    const id = await armedByContinue();
    const s = new ScheduleStore(state).get(id);
    expect(s).toMatchObject({
      host: CLAUDE_CODE_ID,
      sessionRef: { sessionId: SID, cwd: work },
      dueAt: FIRE_AT,
      status: "scheduled",
    });
  });

  it("a closed session with automatic resume on is armed when Rewake notices Claude Code is gone", () => {
    modCopy();
    const h = harness({ ...DEFAULT_SETTINGS, newThreads: "on" });
    expect(reapClosed([claudeCodeHost], { ...h.deps(), running: () => false })).toBe(1);
    expect(h.armed).toHaveLength(1);
    expect(h.armed[0]?.[1]).toBe(FIRE_AT);
    expect(new SessionRecords(state, CLAUDE_CODE_ID).get(SID)?.open).toBe(false);
  });

  it("otherwise tells the person to run continue", () => {
    modCopy();
    const h = harness();
    reapClosed([claudeCodeHost], h.deps());
    expect(h.armed).toEqual([]);
    expect(h.notes[0]).toMatch(
      /Claude Code in the "shop" folder hit its usage limit\. Run ".*continue"/,
    );
  });
});

describe("fire continues a closed Claude Code session", () => {
  it("resumes that session by id, headless, in its folder, with the settings it had", async () => {
    modCopy();
    const id = await armedByContinue();
    expect(await fire(id, fireDeps({}))).toBe("sent");
    expect(calls()).toEqual([
      {
        args: ["--resume", SID, "-p", "--output-format", "json", "--permission-prompts", "none"],
        cwd: work,
        stdin: DEFAULT_RESUME_PROMPT,
        fire: id,
        configDir: config,
        baseUrl: "https://gateway.example",
        hasKey: false,
      },
    ]);
  });

  it("never uses --continue, a permission mode or a skip-permissions flag, and the message is not an argument", async () => {
    modCopy();
    const id = await armedByContinue();
    expect(await fire(id, fireDeps({}))).toBe("sent");
    const args = calls()[0]?.args ?? [];
    expect(args.join(" ")).not.toMatch(/--continue|-c\b|skip|bypass|permission-mode|allow/i);
    for (const arg of args)
      expect(DEFAULT_RESUME_PROMPT).not.toContain(arg === "-p" ? "\u0000" : arg);
    expect(args.join("\u0000")).not.toContain(DEFAULT_RESUME_PROMPT.slice(0, 30));
  });

  // Windows: a symlink named claude to a script doesn't run there (no shebangs): not covered yet.
  it.skipIf(process.platform === "win32")(
    "finds claude on the session's PATH when the plugin recorded no program",
    async () => {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      symlinkSync(FAKE, join(bin, "claude"));
      modCopy({ program: undefined });
      const id = await armedByContinue();
      expect(
        await fire(id, fireDeps({ PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` })),
      ).toBe("sent");
      expect(calls()).toHaveLength(1);
    },
  );

  it("stops with a notice when it can't find claude at all", async () => {
    modCopy({ program: undefined });
    const id = await armedByContinue();
    expect(await fire(id, fireDeps({ PATH: join(dir, "nowhere"), HOME: join(dir, "home") }))).toBe(
      "failed",
    );
    expect(calls()).toEqual([]);
  });

  it("doesn't run claude when a key the session had was only in the person's shell", async () => {
    modCopy({ keysSet: ["ANTHROPIC_API_KEY"] });
    const id = await armedByContinue();
    expect(await fire(id, fireDeps({ ANTHROPIC_API_KEY: "" }))).toBe("failed");
    expect(calls()).toEqual([]);
    expect(new ScheduleStore(state).get(id)?.failureReason).toBe("missing-key");
  });

  // Windows can't tell which processes are agent sessions yet (gap G10): not covered there.
  it.skipIf(process.platform === "win32")(
    "only notifies when Claude Code has the session open again: never a second writer",
    async () => {
      modCopy();
      const id = await armedByContinue();
      // The plugin of a reopened session refreshes its copy: open, with the process that runs it.
      const agent = agentProcess(process.pid);
      if (!agent) throw new Error("no process to stand in for Claude Code");
      modCopy({ open: true, agents: [agent] });
      expect(await fire(id, fireDeps({}))).toBe("notified");
      expect(calls()).toEqual([]);
    },
  );

  it("waits and tries later when the run hits the limit again", async () => {
    modCopy();
    const id = await armedByContinue();
    expect(await fire(id, fireDeps({ FAKE_CLAUDE: "limited" }))).toBe("waiting");
    expect(new ScheduleStore(state).get(id)?.status).toBe("scheduled");
  });

  it("tells the person when they are signed out", async () => {
    modCopy();
    const id = await armedByContinue();
    expect(await fire(id, fireDeps({ FAKE_CLAUDE: "signedout" }))).toBe("failed");
    expect(new ScheduleStore(state).get(id)?.failureReason).toBe("signed-out");
  });

  it("tells the person when Claude Code no longer has the session", async () => {
    modCopy();
    const id = await armedByContinue();
    expect(await fire(id, fireDeps({ FAKE_CLAUDE: "gone" }))).toBe("failed");
    expect(new ScheduleStore(state).get(id)?.failureReason).toBe("deleted");
  });
});

describe("the person went on in the session", () => {
  it("doesn't write into a session whose transcript changed after the limit, and says so", async () => {
    modCopy();
    transcript(NOW + 20 * 60_000);
    const id = await armedByContinue();
    const notes: string[] = [];
    const deps = { ...fireDeps({}), notify: (_t: string, b: string) => notes.push(b) > 0 };
    expect(await fire(id, deps)).toBe("notified");
    expect(calls()).toEqual([]);
    expect(notes[0]).toMatch(
      /^Claude Code in the "shop" folder: .*changed since it stopped.*didn't send anything/,
    );
    expect(new ScheduleStore(state).get(id)?.status).toBe("needs_attention");
  });

  it("continues when the transcript was last written at the limit or just after it", async () => {
    modCopy();
    transcript(NOW + 30_000);
    const id = await armedByContinue();
    expect(await fire(id, fireDeps({}))).toBe("sent");
    expect(calls()).toHaveLength(1);
  });

  it("continues when it can't find a transcript to compare (Claude Code keeps it elsewhere)", async () => {
    modCopy();
    const id = await armedByContinue();
    expect(await fire(id, fireDeps({}))).toBe("sent");
  });

  it("a run that hit the limit again doesn't count as the person going on at the next try", async () => {
    modCopy();
    const id = await armedByContinue();
    // The first run limited again: Claude Code appended its limit message to the transcript.
    expect(await fire(id, fireDeps({ FAKE_CLAUDE: "limited" }))).toBe("waiting");
    transcript(LATER + 5_000);
    expect(await fire(id, fireDeps({}, LATER + 10 * 60_000))).toBe("sent");
  });
});

describe("transcripts and a limited run's output", () => {
  it("finds the transcript in any project folder, or in the one CLAUDE_CODE_PROJECT_DIR_NAME names", () => {
    expect(findTranscript(SID, { CLAUDE_CONFIG_DIR: config })).toBeUndefined();
    const path = transcript(NOW);
    expect(findTranscript(SID, { CLAUDE_CONFIG_DIR: config })).toBe(path);
    expect(
      findTranscript(SID, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: "-shop" }),
    ).toBe(path);
    expect(
      findTranscript(SID, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: "-other" }),
    ).toBeUndefined();
    expect(findTranscript("../../etc/passwd", { CLAUDE_CONFIG_DIR: config })).toBeUndefined();
  });

  it("reads a usage limit and its reset from a headless run, and a spending cap as billing", () => {
    const at = limitInRun("You've hit your session limit · resets 4:10pm (Asia/Dhaka)", NOW);
    expect(at?.billing).toBe(false);
    expect(at?.resetsAt).toBeGreaterThan(NOW);
    expect(limitInRun("You're out of extra usage · resets 3pm", NOW)).toEqual({ billing: true });
    expect(limitInRun("Not logged in · Please run /login", NOW)).toBeUndefined();
    expect(limitInRun("Done. You've hit your goal.", NOW)?.billing).not.toBe(true);
  });

  it("passes on the reset a limited run's message gives", async () => {
    modCopy();
    const r = new SessionRecords(state, CLAUDE_CODE_ID).get(SID) as SessionRecord;
    const result = await resumeClaude(r, "Continue.", {
      ...process.env,
      FAKE_CLAUDE: "limited",
      FAKE_CLAUDE_ERROR: "You've hit your session limit · resets 11pm (UTC)",
    });
    expect(result).toMatchObject({ ok: false, reason: "limited" });
    expect((result as { resetsAt?: number }).resetsAt).toBeGreaterThan(Date.now());
  });
});
