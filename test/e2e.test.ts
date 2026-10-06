import {
  type ChildProcessWithoutNullStreams,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// End-to-end tests against the built single-file bundle, the way Zed runs it.
const root = join(import.meta.dirname, "..");
const bundle = join(root, "dist", "agent-rewake.js");
const fakeAgent = join(root, "test", "fixtures", "fake-agent.mjs");

beforeAll(() => {
  execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], {
    cwd: root,
    stdio: "ignore",
  });
});

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "rewake-e2e-"));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

/**
 * An empty home and no credentials, like the ACP Registry's CI check. On
 * Windows the home is USERPROFILE and the per-user folders, not HOME, and a process needs
 * SystemRoot.
 */
function isolatedEnv(env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? process.env.Path ?? "",
    HOME: home,
    XDG_STATE_HOME: join(home, ".state"),
  };
  if (process.platform === "win32")
    Object.assign(base, {
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      SystemRoot: process.env.SystemRoot,
      ComSpec: process.env.ComSpec,
      PATHEXT: process.env.PATHEXT,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    });
  return { ...base, ...env };
}

/** A path as it appears inside a JSON string. */
const asJson = (path: string) => JSON.stringify(path).slice(1, -1);

/** Where the bundle keeps its state with isolatedEnv(), per OS. */
const isolatedStateDir = () =>
  process.platform === "darwin"
    ? join(home, "Library", "Application Support", "agent-rewake")
    : process.platform === "win32"
      ? join(home, "AppData", "Local", "agent-rewake")
      : join(home, ".state", "agent-rewake");

function start(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [bundle, ...args], {
    env: isolatedEnv(env),
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const lines: string[] = [];
  let buf = "";
  child.stdout.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    let i = buf.indexOf("\n");
    while (i !== -1) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
    }
  });
  const send = (m: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  const waitFor = async (pred: (l: string) => boolean, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = lines.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out; got: ${lines.join(" | ")}`);
  };
  const exited = new Promise<number>((r) => child.on("exit", (code) => r(code ?? -1)));
  return { child, lines, send, waitFor, exited };
}

describe("agent-rewake bundle", () => {
  it("prints its version and help without touching the protocol", () => {
    const v = execFileSync(process.execPath, [bundle, "--version"], { encoding: "utf8" }).trim();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("relays a full session through a wrapped agent, with only JSON-RPC on stdout", async () => {
    const p = start(["--", process.execPath, fakeAgent]);
    p.send({ id: 0, method: "initialize", params: { protocolVersion: 1 } });
    const init = JSON.parse(await p.waitFor((l) => l.includes('"id":0'))) as {
      result: Record<string, unknown>;
    };
    expect(init.result.agentInfo).toMatchObject({ name: "agent-rewake" });
    expect(init.result.authMethods).toEqual([
      { id: "login", name: "Log in", type: "terminal", args: ["--cli", "login"] },
    ]);

    p.send({ id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    await p.waitFor((l) => l.includes('"sessionId":"s-1"'));
    p.send({ id: 2, method: "session/prompt", params: { sessionId: "s-1", prompt: [] } });
    const perm = JSON.parse(await p.waitFor((l) => l.includes("request_permission"))) as {
      id: string;
    };
    p.send({ id: perm.id, result: { outcome: { outcome: "cancelled" } } });
    await p.waitFor((l) => l.includes('"stopReason":"end_turn"'));
    expect(p.lines.some((l) => l.includes('"fake/untouched":true'))).toBe(true);

    for (const l of p.lines) expect(() => JSON.parse(l)).not.toThrow();
    p.child.stdin.end();
    expect(await p.exited).toBe(0);
  });

  it("creates its log directory lazily with owner-only permissions on a cold start", async () => {
    const p = start(["--", process.execPath, fakeAgent]);
    p.send({ id: 0, method: "initialize", params: { protocolVersion: 1 } });
    await p.waitFor((l) => l.includes('"id":0'));
    p.child.stdin.end();
    await p.exited;
    const logDir = join(isolatedStateDir(), "logs");
    const logs = readdirSync(logDir);
    expect(logs.length).toBeGreaterThan(0);
    if (process.platform !== "win32") expect(statSync(logDir).mode & 0o777).toBe(0o700);
  });

  it("handles /schedule inside a session without sending it to the agent", async () => {
    const p = start(["--", process.execPath, fakeAgent]);
    p.send({ id: 0, method: "initialize", params: { protocolVersion: 1 } });
    p.send({ id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    await p.waitFor((l) => l.includes('"name":"schedule"'));
    p.send({
      id: 2,
      method: "session/prompt",
      params: {
        sessionId: "s-1",
        prompt: [{ type: "text", text: "/schedule in 2h Check the build" }],
      },
    });
    await p.waitFor((l) => l.includes("Rewake: Scheduled for"));
    const done = JSON.parse(await p.waitFor((l) => l.includes('"id":2'))) as { result: unknown };
    expect(done.result).toEqual({ stopReason: "end_turn" });
    expect(p.lines.some((l) => l.includes('"text":"hi"'))).toBe(false); // the fake agent never saw it
    p.child.stdin.end();
    await p.exited;
  });

  it("lists schedules and prints the Zed setup without touching Zed's files", () => {
    const env = { ...process.env, AGENT_REWAKE_STATE_DIR: join(home, "cli-state") };
    const list = execFileSync(process.execPath, [bundle, "schedules"], { encoding: "utf8", env });
    expect(list.trim()).toBe("No scheduled messages.");
    const setup = execFileSync(process.execPath, [bundle, "setup", "zed"], {
      encoding: "utf8",
      env,
    });
    expect(setup).toContain('"Agent Rewake: schedules"');
    expect(setup).toContain('"task::Spawn"');
    expect(setup).toContain(asJson(bundle)); // a JSON string: Windows backslashes are escaped
  });

  it("adds itself to Zed's agents and takes itself out again, asking first", () => {
    const zed = join(home, "zed-config");
    mkdirSync(zed, { recursive: true });
    const original =
      '// mine\n{ "theme": "One Dark", "agent_servers": { "claude-acp": { "type": "registry" } } }\n';
    writeFileSync(join(zed, "settings.json"), original);
    const env = {
      ...process.env,
      AGENT_REWAKE_ZED_CONFIG_DIR: zed,
      AGENT_REWAKE_ZED_DATA_DIR: join(home, "zed-data"),
      AGENT_REWAKE_STATE_DIR: join(home, "doctor-state"),
    };
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [bundle, ...args], { encoding: "utf8", env });

    const refused = cli("install"); // no terminal and no --yes: nothing is written
    expect(refused.status).toBe(1);
    expect(readFileSync(join(zed, "settings.json"), "utf8")).toBe(original);

    expect(cli("install", "--yes").status).toBe(0);
    const settings = readFileSync(join(zed, "settings.json"), "utf8");
    expect(settings).toContain("// mine");
    expect(settings).toContain('"--wrap-registry",');
    expect(settings).toContain(asJson(bundle));
    expect(settings).not.toContain('"Agent Rewake"');
    expect(readFileSync(join(zed, "tasks.json"), "utf8")).toContain("Agent Rewake: schedules");

    // doctor says which agents have Rewake, and that Zed starts it with a thread in the Agent Panel.
    // Its default output names no folders or keys.
    const doctor = cli("doctor");
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain("Rewake is on for: Claude Agent.");
    expect(doctor.stdout).toContain("Installed, but Zed hasn't started Rewake yet.");
    // The general line, or the specific one when other coding agents are on this computer.
    expect(doctor.stdout).toMatch(/Rewake works (only )?in Zed's Agent Panel/);
    expect(doctor.stdout).not.toContain(home);
    expect(doctor.stdout).not.toContain("ANTHROPIC");
    expect(cli("doctor", "--details").stdout).toContain("Details (for bug reports)");

    // An agent that refused Rewake's tool server is named.
    mkdirSync(join(home, "doctor-state", "logs"), { recursive: true });
    writeFileSync(
      join(home, "doctor-state", "logs", "rewake-2026-10-04.jsonl"),
      `${JSON.stringify({ t: "2026-10-04T10:00:00Z", level: "info", event: "agent_tools.refused", agent: "qwen-code" })}\n`,
    );
    expect(cli("doctor").stdout).toContain(
      "qwen-code didn't accept Rewake's tools, so it can't suggest schedules.",
    );

    expect(cli("uninstall", "--yes").status).toBe(0);
    const restored = readFileSync(join(zed, "settings.json"), "utf8");
    expect(restored).not.toContain("--wrap-registry");
    expect(restored).toContain('"type": "registry"');
    expect(cli("install", "--bogus").status).toBe(2);
  });

  it("wraps a registry agent that Zed installed, under its own id, and adds the Rewake menu", async () => {
    // A fake Zed data directory: the cached registry and the agent Zed installed with npm.
    const data = join(home, "zed-data-npx");
    const pkg = join(
      data,
      "external_agents",
      "registry",
      "npx",
      "fake-acp",
      "node_modules",
      "fake-acp",
    );
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "fake-acp", version: "1.0.0", bin: "agent.mjs" }),
    );
    writeFileSync(join(pkg, "agent.mjs"), readFileSync(fakeAgent, "utf8"));
    writeFileSync(
      join(data, "external_agents", "registry", "registry.json"),
      JSON.stringify({
        agents: [{ id: "fake-acp", distribution: { npx: { package: "fake-acp@1.0.0" } } }],
      }),
    );
    const env = { AGENT_REWAKE_ZED_DATA_DIR: data, FAKE_CONFIG_OPTIONS: "1" };
    const p = start(["--wrap-registry", "fake-acp"], env);
    p.send({
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientInfo: { name: "zed" },
        clientCapabilities: { elicitation: { form: {} } },
      },
    });
    await p.waitFor((l) => l.includes('"id":0'));
    p.send({ id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    const opened = JSON.parse(await p.waitFor((l) => l.includes('"sessionId":"s-1"'))) as {
      result: { configOptions: Array<{ id: string }> };
    };
    expect(opened.result.configOptions.map((o) => o.id)).toEqual(["model", "rewake"]);
    p.child.stdin.end();
    expect(await p.exited).toBe(0);

    // Zed's terminal-auth relaunch appends the auth args: the agent gets the terminal directly.
    const login = spawnSync(
      process.execPath,
      [bundle, "--wrap-registry", "fake-acp", "--cli", "login"],
      {
        encoding: "utf8",
        env: isolatedEnv(env),
      },
    );
    expect(login.stdout).toBe("fake login: --cli login\n");
    expect(login.status).toBe(0);
  });

  it("wraps a custom agent command and explains an agent it can't run", () => {
    const custom = spawnSync(
      process.execPath,
      [
        bundle,
        "--wrap-command",
        JSON.stringify({ command: process.execPath, args: [fakeAgent] }),
        "--cli",
        "x",
      ],
      { encoding: "utf8", env: isolatedEnv() },
    );
    expect(custom.stdout).toBe("fake login: --cli x\n");
    const missing = spawnSync(process.execPath, [bundle, "--wrap-registry", "nope"], {
      encoding: "utf8",
      env: isolatedEnv({ AGENT_REWAKE_ZED_DATA_DIR: join(home, "none") }),
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(`"nope" isn't in Zed's copy of the ACP Registry`);
  });

  it("serves the agent's tools over MCP (stdio)", () => {
    const lines = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_scheduled_messages", arguments: {} },
      },
    ];
    const r = spawnSync(process.execPath, [bundle, "mcp"], {
      input: `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
      encoding: "utf8",
      env: isolatedEnv({ AGENT_REWAKE_STATE_DIR: join(home, "mcp-state") }),
    });
    const out = r.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(out[0].result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "agent-rewake" },
    });
    expect(out[1].result.tools.map((t: { name: string }) => t.name)).toEqual([
      "schedule_message",
      "about_rewake",
      "list_scheduled_messages",
      "update_scheduled_message",
      "cancel_scheduled_message",
    ]);
    // Not linked to a thread (no AGENT_REWAKE_LINK): it says so instead of guessing.
    expect(out[2].result).toMatchObject({ isError: true });
    expect(r.status).toBe(0);
  });

  it("refuses to open the schedules page without a terminal", () => {
    const r = spawnSync(process.execPath, [bundle, "ui"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("needs an interactive terminal");
  });

  it("restarts a crashed agent, re-attaches the session and answers the message", async () => {
    const flag = join(home, `crash-${Date.now()}`);
    const p = start(["--", process.execPath, fakeAgent], { FAKE_CRASH_FLAG: flag });
    p.send({ id: 0, method: "initialize", params: { protocolVersion: 1 } });
    p.send({ id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    await p.waitFor((l) => l.includes('"sessionId":"s-1"'));
    p.send({
      id: 2,
      method: "session/prompt",
      params: { sessionId: "s-1", prompt: [{ type: "text", text: "crash" }] },
    });
    const done = JSON.parse(await p.waitFor((l) => l.includes('"id":2'))) as {
      result?: unknown;
      error?: unknown;
    };
    expect(done).toMatchObject({ result: { stopReason: "end_turn" } });
    p.child.stdin.end();
    expect(await p.exited).toBe(0);
  });

  it("never writes message content to its logs", async () => {
    const privateText = "PRIVATE-PROMPT-7f3a9c";
    const stateDir = join(home, "redaction-state");
    const p = start(["--", process.execPath, fakeAgent], { AGENT_REWAKE_STATE_DIR: stateDir });
    p.send({ id: 0, method: "initialize", params: { protocolVersion: 1 } });
    p.send({ id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    await p.waitFor((l) => l.includes('"sessionId":"s-1"'));
    p.send({
      id: 2,
      method: "session/prompt",
      params: { sessionId: "s-1", prompt: [{ type: "text", text: privateText }] },
    });
    const perm = JSON.parse(await p.waitFor((l) => l.includes("request_permission"))) as {
      id: string;
    };
    p.send({ id: perm.id, result: { outcome: { outcome: "cancelled" } } });
    await p.waitFor((l) => l.includes('"id":2'));
    p.send({
      id: 3,
      method: "session/prompt",
      params: {
        sessionId: "s-1",
        prompt: [{ type: "text", text: `/schedule in 2h ${privateText}` }],
      },
    });
    await p.waitFor((l) => l.includes('"id":3'));
    p.child.stdin.end();
    await p.exited;
    const logDir = join(stateDir, "logs");
    const logs = readdirSync(logDir)
      .map((f) => readFileSync(join(logDir, f), "utf8"))
      .join("\n");
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(privateText);
  });

  it.skipIf(process.platform === "win32")(
    "stops cleanly on SIGTERM: ends the agent's stdin and exits with it",
    async () => {
      const p = start(["--", process.execPath, fakeAgent]);
      p.send({ id: 0, method: "initialize", params: { protocolVersion: 1 } });
      await p.waitFor((l) => l.includes('"id":0'));
      p.child.kill("SIGTERM");
      expect(await p.exited).toBe(0); // the fake agent exits 0 on stdin EOF
    },
  );

  it("exits with the agent's status when the agent dies", async () => {
    const p = start(["--", process.execPath, "-e", "process.exit(3)"]);
    expect(await p.exited).toBe(3);
  });

  it("answers initialize through the real Claude adapter with no credentials", async () => {
    const p = start([]);
    p.send({
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: { terminal: true, _meta: { "terminal-auth": true } },
      },
    });
    const init = JSON.parse(await p.waitFor((l) => l.includes('"id":0'), 60_000)) as {
      result: { authMethods: Array<{ type?: string }>; _meta: Record<string, { name?: string }> };
    };
    // At least one terminal/agent auth method, forwarded unchanged (the registry's check).
    expect(init.result.authMethods.some((m) => m.type === "terminal" || m.type === "agent")).toBe(
      true,
    );
    expect(init.result._meta["agent-rewake/wrapped"]?.name).toContain("claude");
    p.child.stdin.end();
    await p.exited;
  }, 90_000);
});
