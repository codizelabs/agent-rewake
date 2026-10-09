import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/core/settings.js";
import { ScheduleStore } from "../src/core/store.js";
import { DEFAULT_RESUME_PROMPT } from "../src/core/threads.js";
// Registers the hosts, so stored resumes for Grok read back as valid.
import "../src/hosts/index.js";
import { SessionRecords } from "../src/hosts/sessions.js";
import { type Mock, type MockRequest, startMock } from "./e2e/mock-llm.mjs";

/**
 * The whole loop in a terminal, offline, with the real Grok Build (the pinned test/agents version)
 * against a local mock of xAI's API: Rewake is installed into Grok as a person would, with
 * automatic resume on. Grok hits its free usage limit, which says nothing of when it resets, so
 * Rewake doesn't guess: when the session ends it tells the person to run "agent-rewake continue".
 * They do, and pick a time; at that time the timer's own command continues the same Grok session
 * headless, once.
 *
 * Offline by construction: the credential is a made-up string, every xAI endpoint Grok uses is the
 * mock, and each process runs in macOS's sandbox-exec with all outbound network denied except to
 * localhost. Nothing reaches the person's desktop: `osascript` (notifications) and `launchctl`
 * (timers) are stand-ins on PATH that record what Rewake asked of them. A real launchd job would
 * run `fire` at load in launchd's environment, against the person's own state folder.
 *
 * Grok's billing log line (the reset of a weekly limit) needs a grok.com sign-in, which Grok 1.0.46
 * doesn't fetch with an API key or an external auth provider: the arm-at-the-reset path is covered
 * by the unit tests (test/grok.test.ts). Slow (about a minute: a chosen time is at least a minute
 * away), so it runs only with REWAKE_E2E=1, and on macOS only (the network guard and the launchd
 * timer are macOS's).
 */
const enabled = process.env.REWAKE_E2E === "1" && process.platform === "darwin";
const root = join(import.meta.dirname, "..");
const bundle = join(root, "dist", "agent-rewake.js");
const grok =
  process.env.REWAKE_GROK_BIN ?? join(root, "test", "agents", "node_modules", ".bin", "grok");

/** macOS's sandbox: no network except localhost. */
const SANDBOX = `(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))`;

interface Run {
  child: ChildProcessWithoutNullStreams;
  output: () => string;
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

function start(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Run {
  const child = spawn("/usr/bin/sandbox-exec", ["-p", SANDBOX, command, ...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => {
    stdout += d.toString("utf8");
  });
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString("utf8");
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on("close", (code) => resolve({ code, stdout, stderr })),
  );
  return { child, output: () => stdout, done };
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const r = start(command, args, env, cwd);
  r.child.stdin.end();
  return r.done;
}

/**
 * A terminal for commands that only ask questions in one: `script` gives them a pty. Its input
 * comes through `cat`, because macOS's `script` can't take Node.js's socket as its input. The
 * shell runs in the sandbox, and so does everything it starts.
 */
function inTerminal(args: string[], env: NodeJS.ProcessEnv, cwd: string): Run {
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const command = [process.execPath, ...args].map(quote).join(" ");
  return start("/bin/sh", ["-c", `cat | exec /usr/bin/script -q /dev/null ${command}`], env, cwd);
}

const until = async (ok: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
  return ok();
};

/**
 * Stand-ins for the desktop: each records its arguments. `launchctl` keeps a copy of every plist
 * it is given and answers `print` for the labels loaded and not booted out.
 */
function stubs(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const note = `#!/bin/sh\nprintf '%s\\n' "$*" >> "$(dirname "$0")/notifications.log"\n`;
  const launchctl = `#!/bin/sh
d="$(dirname "$0")"
printf '%s\\n' "$*" >> "$d/launchctl.log"
case "$1" in
  bootstrap) cp "$3" "$d/loaded-$(basename "$3")" ;;
  bootout) rm -f "$d/loaded-\${2##*/}.plist" ;;
  print) test -f "$d/loaded-\${2##*/}.plist"; exit $? ;;
esac
exit 0
`;
  for (const [name, body] of [
    ["osascript", note],
    ["launchctl", launchctl],
  ] as const) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

/** The plist's ProgramArguments: what launchd would run. */
const programArguments = (plist: string) =>
  [
    ...(/<key>ProgramArguments<\/key>\s*<array>(.*?)<\/array>/s.exec(plist)?.[1] ?? "").matchAll(
      /<string>(.*?)<\/string>/g,
    ),
  ].map((m) =>
    (m[1] ?? "")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&"),
  );

/** Grok's request for a turn: its last user message is the prompt itself, in Grok's query tag. */
const turnFor = (r: MockRequest, text: string) =>
  /\/(responses|chat\/completions)$/.test(r.path) &&
  (r.user.at(-1) ?? "").trim() === `<user_query>\n${text}\n</user_query>`;

describe.runIf(enabled)("Grok Build in a terminal, offline: limit → continue (real Grok)", () => {
  it("asks about a limit without a reset time, then continues the same session once", async () => {
    expect(existsSync(grok), `Grok Build not found at ${grok}: run "npm ci" in test/agents`).toBe(
      true,
    );
    const home = mkdtempSync(join(tmpdir(), "rewake-grok-loop-"));
    const work = join(home, "work");
    const state = join(home, "state");
    const desk = join(home, "desk");
    mkdirSync(work);
    stubs(desk);
    let mock: Mock | undefined;
    try {
      mock = await startMock();
      const env: NodeJS.ProcessEnv = {
        // The stand-ins first; only the pinned Grok, Node.js and the system's own programs.
        PATH: [
          desk,
          dirname(grok),
          dirname(process.execPath),
          "/usr/bin",
          "/bin",
          "/usr/sbin",
          "/sbin",
        ].join(":"),
        HOME: home,
        GROK_HOME: join(home, ".grok"),
        AGENT_REWAKE_STATE_DIR: state,
        // A made-up key: it reaches only the mock.
        XAI_API_KEY: "rewake-test-not-a-real-key",
        GROK_CLI_CHAT_PROXY_BASE_URL: mock.url,
        GROK_XAI_API_BASE_URL: mock.url,
        GROK_MODELS_BASE_URL: mock.url,
        GROK_CLI_BASE_URL: mock.url,
        GROK_CODE_BACKEND_URL: mock.url,
        GROK_DISABLE_AUTOUPDATER: "1",
        GROK_TELEMETRY_ENABLED: "0",
        DISABLE_TELEMETRY: "1",
      };

      // 1. Install into Grok, as a person would.
      const installed = await run(
        process.execPath,
        [bundle, "install", "--only", "grok", "--yes"],
        env,
        work,
      );
      expect(installed.code, installed.stdout + installed.stderr).toBe(0);
      expect(installed.stdout).toMatch(/Grok Build \(version 1\.0\.\d+ found\)/);
      const hooks = read(join(home, ".grok", "hooks", "agent-rewake.json"));
      expect(hooks).toContain(join(state, "bin", "agent-rewake.mjs"));

      // 2. Automatic resume on.
      const always = await run(process.execPath, [bundle, "continue", "--always"], env, work);
      expect(always.code).toBe(0);
      expect(loadSettings(state).newThreads).toBe("on");

      // 3. Grok's free usage runs out: the turn fails at the limit.
      mock.set({ mode: "limit", until: Date.now() + 20_000, profile: "xai-free" });
      const limited = await run(grok, ["-p", "say hi", "--output-format", "json"], env, work);
      expect(limited.code).toBe(1);
      expect(JSON.parse(limited.stdout.trim().split("\n").at(-1) ?? "{}")).toMatchObject({
        type: "error",
        message: expect.stringMatching(/^You’ve reached your free Grok Build usage limit/),
      });
      expect(mock.log().some((r) => r.limited && turnFor(r, "say hi"))).toBe(true);

      // 4. Rewake recorded the limit (no reset time: Grok's text has none) and, as the session
      // ended, told the person how to continue instead of guessing a time.
      const records = new SessionRecords(state, "grok");
      expect(await until(() => records.list().some((r) => !r.open && r.limit), 15_000)).toBe(true);
      const [record] = records.list();
      expect(records.list()).toHaveLength(1);
      expect(record?.limit).toMatchObject({ kind: "other", billing: false });
      expect(record?.limit?.resetsAt).toBeUndefined();
      expect(record?.program).toBeTruthy();
      const sessionId = record?.sessionId ?? "";
      expect(
        await until(
          () =>
            // The command as this computer runs it: npx when agent-rewake isn't on PATH (CI).
            /Grok Build in the \\"work\\" folder hit its usage limit\. Run \\"(npx @codizelabs\/)?agent-rewake continue\\" and choose when to continue it\./.test(
              read(join(desk, "notifications.log")),
            ),
          10_000,
        ),
      ).toBe(true);
      const store = new ScheduleStore(state);
      expect(store.list()).toHaveLength(0);
      expect(read(join(desk, "launchctl.log"))).not.toMatch(/^bootstrap/m);

      // 5. The person runs "agent-rewake continue" and picks a time a minute away.
      const term = inTerminal([bundle, "continue"], env, work);
      expect(await until(() => /Choose 1-4/.test(term.output()), 15_000)).toBe(true);
      expect(term.output()).toMatch(
        /When should Rewake continue Grok Build in the "work" folder\?/,
      );
      term.child.stdin.write("4\n");
      expect(await until(() => /Which time\?/.test(term.output()), 10_000)).toBe(true);
      term.child.stdin.write("in 1m\n");
      expect(await until(() => /Rewake will continue/.test(term.output()), 10_000)).toBe(true);
      term.child.stdin.end();
      const chose = await term.done;
      expect(chose.stdout).toMatch(/Rewake will continue Grok Build in the "work" folder/);
      const [resume] = store.list();
      expect(store.list()).toHaveLength(1);
      expect(resume).toMatchObject({
        host: "grok",
        kind: "limit_resume",
        status: "scheduled",
        sessionRef: { sessionId },
      });
      const id = resume?.scheduleId ?? "";
      const dueAt = resume?.dueAt ?? 0;

      // Armed with the OS timer: the plist names what launchd runs at that minute.
      const label = `codizelabs.agent-rewake.${id}`;
      expect(read(join(desk, "launchctl.log"))).toMatch(
        new RegExp(`^bootstrap gui/\\d+ ${join(state, "timers", `${label}.plist`)}$`, "m"),
      );
      const timer = programArguments(read(join(desk, `loaded-${label}.plist`)));
      expect(timer.slice(1)).toEqual([
        join(state, "bin", "agent-rewake.mjs"),
        "fire",
        id,
        "--state-dir",
        state,
      ]);

      // 6. At that time, with the limit reset, run what the timer runs.
      await until(() => Date.now() >= dueAt, 90_000);
      const before = mock.log().length;
      const fired = await run(timer[0] ?? "", timer.slice(1), env, work);
      expect(fired.code).toBe(0);
      expect(store.get(id)?.status).toBe("sent");

      // The continue message reached the model once, in the same session: Grok sent it with the
      // earlier prompt as history, and made no new session.
      const after = mock.log().slice(before);
      const turns = after.filter((r) => turnFor(r, DEFAULT_RESUME_PROMPT));
      expect(turns).toHaveLength(1);
      expect(turns[0]?.limited).toBe(false);
      expect(turns[0]?.user.some((u) => u.includes("say hi"))).toBe(true);
      const sessions = join(home, ".grok", "sessions");
      const ids = readdirSync(sessions, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .flatMap((d) => readdirSync(join(sessions, d.name)))
        .filter((n) => /^[0-9a-f]{8}-/.test(n));
      expect(ids).toEqual([sessionId]);
      // Its timer is gone: the plist removed, then the job booted out (from a detached child, as
      // launchd can't boot out the job that is running).
      expect(existsSync(join(state, "timers", `${label}.plist`))).toBe(false);
      const bootedOut = () =>
        read(join(desk, "launchctl.log"))
          .split(/^bootstrap .*$/m)[1]
          ?.includes(`bootout gui/${process.getuid?.()}/${label}`) === true;
      expect(await until(bootedOut, 10_000)).toBe(true);

      // Once: the timer running again sends nothing.
      const again = await run(timer[0] ?? "", timer.slice(1), env, work);
      expect(again.code).toBe(0);
      expect(mock.log().filter((r) => turnFor(r, DEFAULT_RESUME_PROMPT))).toHaveLength(1);
    } finally {
      await mock?.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 240_000);
});
