import {
  type ChildProcessWithoutNullStreams,
  execFile,
  execFileSync,
  spawn,
} from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { type Mock, startMock } from "./e2e/mock-llm.mjs";

/**
 * The whole loop in Claude Code's terminal, offline: `agent-rewake install --only claude-code`
 * adds the mod with Claude Code's own plugin commands, then the real Claude Code (pinned in
 * test/agents) runs interactively in a pseudo-terminal against a local mock of Anthropic's API.
 * The mock answers with a subscriber's session limit; the mod asks, the person picks "from now on"
 * (automatic continue); a minute after the reset the mod sends its continue into the same session,
 * once: in the same process when the terminal was left open, or, when it was closed and the session
 * reopened (`claude --resume <id>`) before then, from the reopened one.
 *
 * Only an interactive session counts: in `claude -p` and the stream-json (SDK) mode the mod sees
 * the limit (StopFailure, session.measure) but stands aside by design (isInteractive is false), so
 * nothing is recorded there and a later `--resume` has nothing to pick up.
 *
 * Claude Code's own "continue automatically at usage limit" is turned off in its settings, as a
 * person who wants Rewake to ask would: with it on, Claude Code continues by itself and the mod
 * stands aside. Offline by construction, as in claude-loop.test.ts: the agent's only endpoint is
 * the mock, macOS's sandbox denies every other connection, and the token is made up. Needs the
 * pinned agents (`npm ci` in test/agents). About 75 seconds (the two cases run side by side, and
 * the mod continues a minute after the reset), so it runs only with REWAKE_E2E=1.
 */
const enabled =
  process.env.REWAKE_E2E === "1" &&
  (process.platform === "darwin" ||
    (process.platform === "linux" && process.env.REWAKE_E2E_UNGUARDED === "1"));
const root = join(import.meta.dirname, "..");
const bundle = join(root, "dist", "agent-rewake.js");
const agents = join(root, "test", "agents", "node_modules", ".bin");
const claude = join(agents, "claude");

/** macOS's sandbox: no network except localhost. */
const SANDBOX = `(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))`;
const CONTINUE = "[Sent automatically by Agent Rewake after the usage limit reset]";
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** A terminal's control sequences: titles (OSC), CSI sequences and character-set switches. */
const CONTROL = new RegExp(
  `${ESC}\\][^${BEL}]*${BEL}|${ESC}\\[[0-9;?<>=]*[ -/]*[@-~]|${ESC}[()][0-9A-Za-z]`,
  "g",
);
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** `argv` behind the macOS sandbox (elsewhere unguarded). */
const guarded = (argv: string[]) =>
  process.platform === "darwin" ? ["/usr/bin/sandbox-exec", "-p", SANDBOX, ...argv] : argv;

function run(argv: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const [command, ...args] = guarded(argv);
  return new Promise<{ status: number; out: string }>((resolve) => {
    execFile(command as string, args, { env, cwd, timeout: 120_000 }, (err, stdout, stderr) =>
      resolve({ status: err ? 1 : 0, out: `${stdout}${stderr}` }),
    );
  });
}

/** Every process descending from `pid`, from ps. */
function descendants(pid: number): number[] {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number));
  const found: number[] = [];
  for (let i = 0, next = [pid]; i < next.length; i++)
    for (const [p, parent] of rows)
      if (parent === next[i] && p !== undefined) {
        found.push(p);
        next.push(p);
      }
  return found;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Claude Code in a pseudo-terminal, through script(1). script wants a pipe or a terminal on stdin,
 * not the socket Node gives a child, hence `cat |`. Keys go in as a person types them.
 */
function terminal(env: NodeJS.ProcessEnv, cwd: string, args: string[] = []) {
  const cmd = guarded([claude, ...args])
    .map(quote)
    .join(" ");
  const pty =
    process.platform === "darwin"
      ? `/usr/bin/script -q /dev/null ${cmd}`
      : `script -qfec ${quote(cmd)} /dev/null`;
  const child = spawn("/bin/sh", ["-c", `cat | exec ${pty}`], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  }) as ChildProcessWithoutNullStreams;
  let raw = "";
  child.stdout.on("data", (c: Buffer) => {
    raw += c.toString("utf8");
  });
  child.stderr.on("data", (c: Buffer) => {
    raw += c.toString("utf8");
  });
  /** What was drawn, without the terminal's control sequences. */
  const screen = () => raw.replace(CONTROL, "");
  /** Whether `re` matches what was drawn, spaces left out (the terminal moves the cursor for them). */
  const sees = (re: RegExp) => re.test(screen().replace(/\s+/g, ""));
  const keys = async (...ks: string[]) => {
    for (const k of ks) {
      child.stdin.write(k);
      await new Promise((r) => setTimeout(r, 400));
    }
  };
  const kill = () => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  };
  /** The processes running under this terminal (Claude Code among them). */
  const processes = () => (child.pid ? descendants(child.pid) : []);
  return { screen, sees, keys, kill, processes };
}

const until = async (ok: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 250));
  return ok();
};
const ENTER = "\r";
const DOWN = "\x1b[B";

type Episode = {
  state?: string;
  kind?: string;
  resetAt?: number;
  fireAt?: number;
  sentAt?: number;
};

type Store = Record<string, Episode & { autoContinue?: string }>;

/**
 * A person who already uses Claude Code (onboarded, this folder trusted), with Claude Code's own
 * "continue automatically at usage limit" turned off in /config, installs Rewake for Claude Code;
 * a session hits its limit and the person turns automatic continue on when Rewake asks. Returns
 * once the mod has armed the continue.
 */
async function limitedSession(home: string, mock: Mock) {
  const work = join(home, "work");
  mkdirSync(work);
  const config = join(home, ".claude");
  const state = join(home, "state");
  const env: NodeJS.ProcessEnv = {
    PATH: [agents, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: home,
    TERM: "xterm-256color",
    COLUMNS: "120",
    LINES: "40",
    CLAUDE_CONFIG_DIR: config,
    AGENT_REWAKE_STATE_DIR: state,
    ANTHROPIC_BASE_URL: mock.url,
    // A made-up subscriber token: it reaches only the mock.
    CLAUDE_CODE_OAUTH_TOKEN: "rewake-test-not-a-real-token",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  };

  // Rewake adds its mod with Claude Code's own plugin commands, into the temporary config.
  const install = await run(
    [process.execPath, bundle, "install", "--only", "claude-code", "--yes"],
    env,
    home,
  );
  expect(install.status, install.out).toBe(0);
  expect(install.out).toMatch(/Done\./);
  expect(readFileSync(join(config, "plugins", "installed_plugins.json"), "utf8")).toContain(
    '"rewake@agent-rewake"',
  );
  const profile = join(config, ".claude.json");
  writeFileSync(
    profile,
    JSON.stringify({
      ...JSON.parse(readFileSync(profile, "utf8")),
      hasCompletedOnboarding: true,
      theme: "dark",
      projects: {
        [realpathSync(work)]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
      },
    }),
  );
  const settings = join(config, "settings.json");
  writeFileSync(
    settings,
    JSON.stringify({
      ...JSON.parse(readFileSync(settings, "utf8")),
      autoContinueAtUsageLimit: false,
    }),
  );

  const t = terminal(env, work);
  try {
    expect(await until(() => t.sees(/ClaudeCodev\d/), 30_000), t.screen()).toBe(true);
    await new Promise((r) => setTimeout(r, 2_000));

    // The session hits its limit, resetting a few seconds from now.
    mock.set({ mode: "limit", until: Date.now() + 5_000, claim: "five_hour" });
    await t.keys("say hi", ENTER);
    expect(await until(() => t.sees(/hityoursessionlimit/), 30_000), t.screen()).toBe(true);
    const limited = mock.log().filter((r) => r.limited && r.path.startsWith("/v1/messages"));
    expect(limited).toHaveLength(1);
    const sessionId = limited[0]?.session as string;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

    // Claude Code's own question first ("Stop and wait for limit to reset"), then Rewake's: the
    // person turns automatic continue on, "from now on in every session".
    expect(await until(() => t.sees(/Whatdoyouwanttodo\?/), 15_000), t.screen()).toBe(true);
    await t.keys(ENTER);
    expect(await until(() => t.sees(/Continuethissessionautomatically/), 15_000), t.screen()).toBe(
      true,
    );
    await t.keys(DOWN, ENTER);

    // The mod recorded the limit and armed the continue: in its store, and in Rewake's copy.
    const mirror = join(state, "hosts", "claude-code", "sessions", `${sessionId}.json`);
    const mirrored = () => {
      try {
        return JSON.parse(readFileSync(mirror, "utf8")) as Episode;
      } catch {
        return undefined;
      }
    };
    expect(await until(() => mirrored()?.state === "armed", 15_000), t.screen()).toBe(true);
    const armed = mirrored() as Episode;
    expect(armed.kind).toBe("five_hour");
    expect(armed.fireAt).toBe((armed.resetAt ?? 0) + 60_000);
    const stores = join(config, "plugins", "store");
    const file = readdirSync(stores).find((f) => f.startsWith("rewake_")) ?? "-";
    const store = JSON.parse(readFileSync(join(stores, file), "utf8")) as Store;
    expect(store.prefs?.autoContinue).toBe("always");
    expect(store[`limit:${sessionId}`]?.state).toBe("armed");
    return { env, work, t, sessionId, armed, mirrored };
  } catch (err) {
    t.kill();
    throw err;
  }
}

/** The continue reached the mock in `sessionId`, after its time, once, and the mod recorded it. */
async function continuedOnce(
  mock: Mock,
  s: Awaited<ReturnType<typeof limitedSession>>,
  t: ReturnType<typeof terminal>,
) {
  const continues = () =>
    mock.log().filter((r) => r.path.startsWith("/v1/messages") && r.prompt?.includes(CONTINUE));
  expect(await until(() => continues().length > 0, 100_000), t.screen()).toBe(true);
  expect(await until(() => t.sees(/RESUMED_OK/), 15_000), t.screen()).toBe(true);
  const sent = continues()[0];
  expect(sent?.limited).toBe(false);
  expect(sent?.session).toBe(s.sessionId);
  expect(Date.now()).toBeGreaterThanOrEqual(s.armed.fireAt ?? 0);
  expect(s.mirrored()).toMatchObject({ state: "sent", sentAt: expect.any(Number) });
  // Once: no second continue, and the limit was hit only the once.
  await new Promise((r) => setTimeout(r, 3_000));
  expect(continues()).toHaveLength(1);
  expect(mock.log().filter((r) => r.limited)).toHaveLength(1);
}

describe.runIf(enabled)("Claude Code's terminal, offline: limit → continue (the mod)", () => {
  beforeAll(() => {
    execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], {
      cwd: root,
      stdio: "ignore",
    });
  });

  it.concurrent("continues the same session once after the reset, with the terminal left open", async () => {
    const home = mkdtempSync(join(tmpdir(), "rewake-cc-loop-"));
    let mock: Mock | undefined;
    let s: Awaited<ReturnType<typeof limitedSession>> | undefined;
    try {
      mock = await startMock();
      s = await limitedSession(home, mock);
      // A minute after the reset the continue goes into the same session, from this process.
      await continuedOnce(mock, s, s.t);
    } finally {
      s?.t.kill();
      await mock?.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 240_000);

  it.concurrent("closed and reopened before the reset: the reopened session continues once", async () => {
    const home = mkdtempSync(join(tmpdir(), "rewake-cc-reopen-"));
    let mock: Mock | undefined;
    let s: Awaited<ReturnType<typeof limitedSession>> | undefined;
    let again: ReturnType<typeof terminal> | undefined;
    try {
      mock = await startMock();
      s = await limitedSession(home, mock);
      // The person closes the terminal (Claude Code exits with it); the continue stays armed.
      const closed = s.t.processes();
      expect(closed.length).toBeGreaterThan(0);
      s.t.kill();
      expect(await until(() => !closed.some(alive), 10_000)).toBe(true);
      expect(s.mirrored()?.state).toBe("armed");
      const before = mock.log().length;
      // ...and reopens the session before it is due: the mod arms it again in the new process.
      again = terminal(s.env, s.work, ["--resume", s.sessionId]);
      const t = again;
      expect(await until(() => t.sees(/sayhi/), 30_000), t.screen()).toBe(true);
      expect(Date.now()).toBeLessThan(s.armed.fireAt ?? 0);
      expect(mock.log().length).toBe(before);
      await continuedOnce(mock, s, t);
    } finally {
      s?.t.kill();
      again?.kill();
      await mock?.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 240_000);
});
