import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  type DoctorContext,
  detailLines,
  diagnose,
  type Finding,
  findZedApps,
  recentLogs,
  render,
  renderJson,
  type ZedApp,
} from "../src/doctor.js";
import type { Found } from "../src/install/detect.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-doctor-"));
  mkdirSync(join(dir, "zed"));
  env = {
    AGENT_REWAKE_ZED_CONFIG_DIR: join(dir, "zed"),
    AGENT_REWAKE_ZED_DATA_DIR: join(dir, "data"),
    AGENT_REWAKE_STATE_DIR: join(dir, "state"),
    HOME: dir,
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const zed: ZedApp[] = [{ name: "Zed", version: "1.22.0" }];
const settings = (value: unknown) =>
  writeFileSync(join(dir, "zed", "settings.json"), JSON.stringify(value));
const wrapped = (id = "claude-acp", extra: Record<string, unknown> = {}) => ({
  type: "custom",
  command: process.execPath,
  args: [join(dir, "agent-rewake.js"), "--wrap-registry", id],
  ...extra,
});
const log = (...records: Record<string, unknown>[]) => {
  mkdirSync(join(dir, "state", "logs"), { recursive: true });
  writeFileSync(
    join(dir, "state", "logs", "rewake-2026-10-06.jsonl"),
    `${records.map((r) => JSON.stringify({ level: "info", ...r })).join("\n")}\n`,
  );
};
const schedule = (n: number, status: string, dueAt: number) => {
  mkdirSync(join(dir, "state", "schedules"), { recursive: true });
  const id = `00000000-0000-4000-8000-00000000000${n}`;
  writeFileSync(
    join(dir, "state", "schedules", `${id}.json`),
    JSON.stringify({
      schemaVersion: 1,
      scheduleId: id,
      sessionId: "s1",
      cwd: "/home/someone/client-project",
      kind: "user",
      text: "PRIVATE message text",
      dueAt,
      status,
      attempts: [],
      createdAt: NOW - 1e7,
      updatedAt: NOW,
    }),
  );
};

function run(apps: ZedApp[] = zed, extra: Partial<DoctorContext> = {}): Finding[] {
  writeFileSync(join(dir, "agent-rewake.js"), "");
  return diagnose({
    env,
    now: NOW,
    platform: "darwin",
    home: dir,
    zedApps: () => apps,
    version: "0.1.2",
    nodeVersion: "24.1.0",
    ...extra,
  });
}
const texts = (f: Finding[], level?: Finding["level"]) =>
  f.filter((x) => !level || x.level === level).map((x) => x.text);

describe("doctor: getting set up", () => {
  it("no Zed at all: says to install Zed", () => {
    const f = run([]);
    expect(texts(f, "problem").join()).toContain("Zed doesn't seem to be installed");
  });

  it("Zed, but never opened: open it once", () => {
    expect(texts(run(), "todo").join()).toContain("Zed hasn't saved any settings yet");
  });

  it("too old a Zed", () => {
    settings({});
    expect(texts(run([{ name: "Zed", version: "1.21.0" }]), "problem").join()).toContain(
      "Rewake needs Zed 1.22",
    );
  });

  it("settings that aren't valid JSON", () => {
    writeFileSync(join(dir, "zed", "settings.json"), '{ "agent_servers": ');
    expect(texts(run(), "problem").join()).toContain("settings file has a mistake");
  });

  it("no agents yet: run install, which offers Claude Agent", () => {
    settings({ theme: "One Dark" });
    const f = run();
    expect(texts(f, "todo").join()).toContain("Zed has no external agents yet");
    expect(f.find((x) => x.level === "todo")?.fix).toContain(
      "npx @codizelabs/agent-rewake install",
    );
  });

  it("agents, but no Rewake on them", () => {
    settings({ agent_servers: { "claude-acp": { type: "registry" } } });
    expect(texts(run(), "todo").join()).toContain(
      "Rewake isn't added to your agents yet (Claude Agent)",
    );
  });
});

describe("doctor: installed", () => {
  it("installed, never started (the Claude desktop app case): explains the Agent Panel", () => {
    settings({ agent_servers: { "claude-acp": wrapped() } });
    const f = run();
    expect(texts(f, "todo").join()).toContain("Zed hasn't started Rewake yet");
    expect(f.find((x) => x.text.includes("hasn't started"))?.fix).toContain("Agent Panel (Cmd+?)");
    expect(texts(f, "info").join()).toContain(
      "the Claude desktop app or claude.ai. Claude Code, Codex and other agents you run in a terminal are set up separately",
    );
  });

  it("working: names when Zed last started it, and nothing to do", () => {
    settings({ agent_servers: { "claude-acp": wrapped() } });
    log({
      t: "2026-10-06T10:00:00Z",
      event: "proxy.start",
      pid: 1,
      agent: "claude-acp",
      node: "24.1.0",
    });
    const f = run();
    expect(texts(f, "ok").join()).toContain("Working: Zed last started it today");
    expect(f.filter((x) => x.level === "todo" || x.level === "problem")).toEqual([]);
    expect(render(f, { version: "0.1.2", ascii: false })).toContain("All set: nothing to do.");
  });

  it("AI turned off, in the main settings or for an installed edition only", () => {
    settings({ disable_ai: true });
    expect(texts(run(), "problem").join()).toContain(
      "AI features are turned off (disable_ai in Zed's settings)",
    );
    settings({ preview: { disable_ai: true } });
    expect(texts(run(), "problem")).toEqual([]); // no Zed Preview installed
    expect(
      texts(run([...zed, { name: "Zed Preview", version: "1.23.0" }]), "problem").join(),
    ).toContain('the "preview" section');
    settings({ agent: { enabled: false } });
    expect(texts(run(), "problem").join()).toContain("Zed's agent is turned off");
  });

  it("an OS section that sets the agent again without Rewake", () => {
    settings({
      agent_servers: { "claude-acp": wrapped() },
      macos: { agent_servers: { "claude-acp": { type: "registry" } } },
    });
    expect(texts(run(), "todo").join()).toContain(
      'The "macos" section of Zed\'s settings sets Claude Agent again',
    );
  });

  it("an older pinned version in Zed's settings", () => {
    settings({
      agent_servers: {
        "claude-acp": {
          type: "custom",
          command: "npx",
          args: ["--yes", "@codizelabs/agent-rewake@0.1.0", "--wrap-registry", "claude-acp"],
        },
      },
    });
    const f = run();
    expect(texts(f, "todo").join()).toContain("Zed starts Rewake 0.1.0; this is Rewake 0.1.2.");
    expect(f.find((x) => x.text.startsWith("Zed starts Rewake 0.1.0"))?.fix).toContain(
      "npx @codizelabs/agent-rewake@latest install",
    );
    // A doctor older than the version Zed runs says so, instead of suggesting a downgrade.
    expect(texts(run(zed, { version: "0.0.9" }), "info").join()).toContain(
      "newer than this check (0.0.9)",
    );
  });

  it("a Node.js or Rewake path that's gone", () => {
    settings({
      agent_servers: {
        "claude-acp": { ...wrapped(), command: "/gone/node/22.1.0/bin/node" },
      },
    });
    expect(texts(run(), "problem").join()).toContain("has moved or been removed");
  });

  it("Zed started Rewake with too old a Node.js", () => {
    settings({ agent_servers: { "claude-acp": wrapped() } });
    log({
      t: "2026-10-06T10:00:00Z",
      event: "proxy.start",
      pid: 1,
      agent: "claude-acp",
      node: "20.11.0",
    });
    expect(texts(run(), "problem").join()).toContain("Zed starts Rewake with Node.js 20.11.0");
  });

  it("a registry agent while Zed's agent list is missing: reported once", () => {
    settings({ agent_servers: { "claude-acp": wrapped(), "codex-acp": { type: "registry" } } });
    const f = run();
    expect(texts(f, "todo").join()).toContain("Zed hasn't downloaded its list of agents yet");
    expect(texts(f).join()).not.toContain("can't have Rewake yet");
  });

  it("settings that turn off automatic resume or the agent's tools", () => {
    settings({
      agent_servers: {
        "claude-acp": wrapped("claude-acp", {
          env: { AGENT_REWAKE_ALLOW_AUTO: "0", AGENT_REWAKE_AGENT_TOOLS: "0" },
        }),
      },
    });
    const info = texts(run(), "info").join();
    expect(info).toContain("Automatic resume is off for Claude Agent");
    expect(info).toContain("Claude Agent can't suggest schedules");
  });

  it("an API key given to Claude Agent in Zed's settings: says Zed clears it, without the key", () => {
    settings({
      agent_servers: {
        "claude-acp": wrapped("claude-acp", { env: { ANTHROPIC_API_KEY: "sk-SECRET" } }),
      },
    });
    const f = run();
    expect(texts(f, "todo").join()).toContain("Zed clears that key");
    expect(render(f, { version: "0.1.2", ascii: false })).not.toContain("sk-SECRET");
  });
});

describe("doctor: other coding agents", () => {
  it("names them in one line, and says Rewake doesn't work in them yet", () => {
    const f = run(zed, {
      agents: () => [
        { id: "claude-code", name: "Claude Code", version: "2.1.291", surfaces: ["terminal"] },
      ],
    });
    expect(texts(f, "info")).toContain(
      "Rewake works only in Zed's Agent Panel (not with Zed's own agent). It isn't set up for Claude Code used on its own in a terminal, another editor or a desktop app.",
    );
    expect(texts(run()).join()).not.toContain("used on their own");
  });

  it("installed, never started: the specific line replaces the general one", () => {
    const general = "Rewake works in Zed's Agent Panel, with external agents";
    settings({ agent_servers: { "claude-acp": wrapped() } });
    expect(texts(run()).join()).toContain(general);
    const f = texts(
      run(zed, {
        agents: () => [{ id: "codex", name: "Codex", surfaces: ["terminal"] }],
      }),
    ).join();
    expect(f).not.toContain(general);
    expect(f).toContain("It isn't set up for Codex used on its own");
  });
});

describe("doctor: no Zed, agents in a terminal", () => {
  const found: Found[] = [
    { id: "claude-code", name: "Claude Code", version: "2.1.291", surfaces: ["terminal"] },
    { id: "codex", name: "Codex", version: "0.170.0", surfaces: ["terminal"] },
  ];

  it("starts from the agents found, not from Zed", () => {
    const f = run([], { agents: () => [...found], previews: () => [] });
    const todo = f.find((x) => x.level === "todo");
    expect(todo?.text).toBe("Rewake isn't set up yet. Found on this computer: Claude Code, Codex.");
    expect(todo?.fix).toBe(
      "Run: npx @codizelabs/agent-rewake install  (pick the ones you want), or name them: npx @codizelabs/agent-rewake install --only claude-code,codex",
    );
    // Not told to install Zed, or that Rewake works only there.
    expect(f.filter((x) => x.level === "problem")).toEqual([]);
    const all = texts(f).join("\n");
    expect(all).not.toContain("Open Zed once");
    expect(all).not.toContain("Install Zed");
    expect(all).not.toContain("works only in Zed");
    expect(all).not.toContain("Zed has no external agents");
    expect(texts(f, "info").join()).toContain("Zed isn't installed on this computer");
    const out = render(f, { version: "0.1.2", ascii: false });
    expect(out).toContain("Start here: Run: npx @codizelabs/agent-rewake install  (pick");
  });

  it("with Rewake already set up in a terminal agent, doesn't say it isn't set up", () => {
    const f = run([], { agents: () => [], previews: () => ["GitHub Copilot CLI"] });
    expect(texts(f).join("\n")).not.toContain("isn't set up yet");
    expect(f.filter((x) => x.level === "problem" || x.level === "todo")).toEqual([]);
  });

  it("names only the agents still to set up when another is set up", () => {
    const f = run([], { agents: () => found.slice(1), previews: () => ["Claude Code (terminal)"] });
    expect(f.find((x) => x.level === "todo")?.text).toBe("Rewake isn't set up yet for: Codex.");
  });

  it("with nothing found anywhere, still says what to install", () => {
    const f = run([], { agents: () => [], previews: () => [] });
    const problem = f.find((x) => x.level === "problem");
    expect(problem?.text).toContain("Zed doesn't seem to be installed");
    expect(problem?.fix).toContain("Install Zed from zed.dev");
    expect(problem?.fix).toContain("Claude Code, Codex, Gemini CLI or GitHub Copilot CLI");
  });

  it("with Zed, the advice is unchanged", () => {
    settings({ agent_servers: { "claude-acp": { type: "registry" } } });
    const f = run(zed, { agents: () => [...found], previews: () => [] });
    expect(f.find((x) => x.level === "todo")?.text).toContain("isn't added to your agents yet");
  });
});

describe("doctor: sign-in, schedules and recent problems", () => {
  beforeEach(() => settings({ agent_servers: { "claude-acp": wrapped() } }));

  it("reports the sign-in kind the agent last gave", () => {
    log(
      { t: "2026-10-06T10:00:00Z", event: "proxy.start", pid: 1, agent: "claude-acp" },
      { t: "2026-10-06T10:00:01Z", event: "agent.auth", pid: 1, kind: "api_key" },
    );
    expect(texts(run(), "info").join()).toContain("Claude Agent uses an API key");
    log(
      { t: "2026-10-06T10:00:00Z", event: "proxy.start", pid: 1, agent: "claude-acp" },
      { t: "2026-10-06T10:00:01Z", event: "agent.auth", pid: 1, kind: "none" },
    );
    expect(texts(run(), "todo").join()).toContain("Claude Agent wasn't signed in");
  });

  it("counts scheduled messages by state, never showing their text or folder", () => {
    log({ t: "2026-10-06T10:00:00Z", event: "proxy.start", pid: 1, agent: "claude-acp" });
    schedule(1, "scheduled", NOW - 3_600_000);
    schedule(2, "needs_attention", NOW - 7_200_000);
    schedule(3, "scheduled", NOW + 3_600_000);
    schedule(4, "missed", NOW - 86_400_000);
    const f = run();
    const all = texts(f).join("\n");
    expect(all).toContain("1 message is past due");
    expect(all).toContain("1 message needs you");
    expect(all).toContain("1 message scheduled; the next one today");
    expect(all).toContain("1 message was missed in the last 7 days");
    const out = render(f, { version: "0.1.2", ascii: false });
    expect(out).not.toContain("PRIVATE");
    expect(out).not.toContain("client-project");
  });

  it("start failures: a problem until the agent starts again", () => {
    log({
      t: "2026-10-06T09:00:00Z",
      event: "agent.resolve_failed",
      pid: 2,
      agent: "codex-acp",
      message: "x",
    });
    expect(texts(run(), "problem").join()).toContain("codex-acp couldn't start 1 time");
    log(
      {
        t: "2026-10-06T09:00:00Z",
        event: "agent.resolve_failed",
        pid: 2,
        agent: "codex-acp",
        message: "x",
      },
      { t: "2026-10-06T10:00:00Z", event: "proxy.start", pid: 3, agent: "codex-acp" },
    );
    const f = run();
    expect(texts(f, "problem")).toEqual([]);
    expect(texts(f, "info").join()).toContain("it has started since");
  });

  it("a scheduled message that failed for a reason waiting won't fix", () => {
    log({
      t: "2026-10-06T10:00:00Z",
      event: "schedule.settled",
      pid: 1,
      outcome: "not_recoverable",
    });
    expect(texts(run(), "todo").join()).toContain("waiting won't fix");
  });

  it("reads only the last 14 days of logs", () => {
    mkdirSync(join(dir, "state", "logs"), { recursive: true });
    writeFileSync(
      join(dir, "state", "logs", "rewake-2026-09-01.jsonl"),
      `${JSON.stringify({ t: "2026-09-01T10:00:00Z", event: "proxy.start" })}\n`,
    );
    log({ t: "2026-10-06T10:00:00Z", event: "proxy.start" }, { t: "garbage" });
    expect(recentLogs(join(dir, "state"), NOW).map((r) => r.event)).toEqual(["proxy.start"]);
  });
});

describe("doctor: output", () => {
  it("summarises and points at the first fix; plain marks for old consoles", () => {
    settings({ disable_ai: true });
    const out = render(run(), { version: "0.1.2", ascii: true });
    expect(out).toContain("  Problem: Zed's AI features are turned off");
    expect(out).toContain("-> Remove");
    expect(out).toContain("1 problem and 1 thing to do. Start here: Remove");
    expect(out).toContain("agent-rewake doctor --details");
  });

  it("--details shortens the home folder and never prints values", () => {
    settings({ agent_servers: { "claude-acp": wrapped() } });
    const lines = detailLines({
      env: { ...env, ANTHROPIC_API_KEY: "sk-SECRET", HTTPS_PROXY: "http://user:pw@proxy" },
      now: NOW,
      platform: "darwin",
      home: dir,
      zedApps: () => zed,
      version: "0.1.2",
      nodeVersion: "24.1.0",
    }).join("\n");
    expect(lines).toContain(`Zed settings folder: ~${sep}zed`);
    expect(lines).toContain("Anthropic API key in this shell: not passed on");
    expect(lines).toContain("A proxy is set in this shell.");
    expect(lines).not.toContain("sk-SECRET");
    expect(lines).not.toContain("user:pw");
    expect(lines).not.toContain(dir);
  });
});

describe("--details with two copies of an agent", () => {
  it("lists each copy and says which one Rewake goes by", () => {
    const first = {
      path: join(dir, "nvm", "bin", "claude"),
      surface: "terminal",
      version: "2.1.282",
    };
    const second = { path: "/elsewhere/claude", surface: "terminal", version: "2.1.292" };
    const lines = detailLines({
      env,
      now: NOW,
      platform: "darwin",
      home: dir,
      zedApps: () => zed,
      version: "0.1.2",
      nodeVersion: "24.1.0",
      copies: () => [{ name: "Claude Code", copies: [first, second], chosen: first }],
    }).join("\n");
    expect(lines).toContain(
      `Claude Code is installed 2 times; Rewake uses the first one on your PATH: ~${sep}nvm${sep}bin${sep}claude 2.1.282 (used); /elsewhere/claude 2.1.292`,
    );
  });
});

describe("doctor: levels in words (G65)", () => {
  it("says each level in words as well as a symbol, in both mark styles", () => {
    settings({ disable_ai: true });
    const f = run();
    const fancy = render(f, { version: "0.1.2", ascii: false });
    expect(fancy).toContain("✗ Problem: Zed's AI features are turned off");
    expect(fancy).toContain("! To do: Rewake isn't set up yet");
    expect(fancy).toContain("✓ OK: Found Zed 1.22.0.");
    const plain = render([{ area: "Rewake", level: "info", text: "A note." }], {
      version: "0.1.2",
      ascii: true,
    });
    expect(plain).toContain("  Note: A note.");
  });

  it("--json gives the same findings for scripts, without folders or message text", () => {
    settings({ disable_ai: true });
    schedule(1, "scheduled", NOW + 3_600_000);
    const out = JSON.parse(renderJson(run(), { version: "0.1.2" })) as {
      version: string;
      problems: number;
      todos: number;
      findings: { area: string; level: string; text: string; fix?: string }[];
      details?: string[];
    };
    expect(out.version).toBe("0.1.2");
    expect(out.problems).toBe(1);
    expect(out.todos).toBe(1);
    expect(out.findings[0]).toMatchObject({ area: "Zed", level: "ok" });
    expect(out.findings.find((x) => x.level === "problem")?.fix).toContain("disable_ai");
    expect(out.details).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("PRIVATE");
    expect(renderJson([], { version: "1", details: ["x"] })).toContain('"details"');
  });
});

describe("doctor: how old the installed version is (G70)", () => {
  const day = 86_400_000;
  const say = (installed?: { version: string; at: number }) =>
    run(zed, { installed: () => installed }).filter((f) => f.text.includes("nstalled"));

  it("says the version, its age and how to update, from the local record", () => {
    const f = run(zed, { installed: () => ({ version: "0.1.2", at: NOW - 94 * day - 3600_000 }) });
    const line = f.find((x) => x.text.startsWith("Rewake 0.1.2, installed"));
    expect(line?.text).toBe("Rewake 0.1.2, installed 94 days ago.");
    expect(line?.fix).toBe("To update: npx @codizelabs/agent-rewake@latest install");
    expect(line?.level).toBe("info");
    const out = render(f, { version: "0.1.2", ascii: false });
    expect(out).toContain("To update: npx @codizelabs/agent-rewake@latest install");
  });

  it("says today and 1 day in plain words", () => {
    expect(say({ version: "0.1.2", at: NOW - 1000 })[0]?.text).toBe(
      "Rewake 0.1.2, installed today.",
    );
    expect(say({ version: "0.1.2", at: NOW - day })[0]?.text).toBe(
      "Rewake 0.1.2, installed 1 day ago.",
    );
  });

  it("names both versions when this copy isn't the installed one", () => {
    expect(say({ version: "0.1.0", at: NOW - 5 * day })[0]?.text).toBe(
      "Rewake 0.1.0 was installed 5 days ago; this copy is 0.1.2.",
    );
  });

  it("says nothing when no install time was recorded", () => {
    expect(say(undefined).filter((f) => /^Rewake \d/.test(f.text))).toEqual([]);
  });
});

describe("helpers", () => {
  it("compares versions", () => {
    expect(compareVersions("1.21.0", "1.22.0")).toBe(-1);
    expect(compareVersions("1.22", "1.22.0")).toBe(0);
    expect(compareVersions("1.22.1-pre", "1.22.0")).toBe(1);
  });

  it("reads the version from a Zed app's Info.plist on macOS", () => {
    const plist = join(dir, "Applications", "Zed Preview.app", "Contents");
    mkdirSync(plist, { recursive: true });
    writeFileSync(
      join(plist, "Info.plist"),
      "<dict><key>CFBundleShortVersionString</key>\n<string>1.23.0</string></dict>",
    );
    expect(findZedApps("darwin", dir, {})).toContainEqual({
      name: "Zed Preview",
      version: "1.23.0",
    });
    mkdirSync(join(dir, ".local", "zed.app"), { recursive: true });
    expect(findZedApps("linux", dir, {})).toEqual([{ name: "Zed" }]);
  });
});
