import {
  type ChildProcessWithoutNullStreams,
  execFile,
  execFileSync,
  spawn,
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { ScheduleStore } from "../src/core/store.js";
import "../src/hosts/index.js"; // registers the "qwen-code" host
import { SessionRecords } from "../src/hosts/sessions.js";
import { type Mock, startMock } from "./e2e/mock-llm.mjs";

/**
 * Qwen Code's whole loop outside Zed, offline (plan §9.5, §10.2 L3, a preview never tried against
 * a real Qwen Code limit): the real Qwen Code (pinned in test/agents) against a local mock of its
 * OpenAI-compatible wire, with Rewake installed the way a person installs it.
 *
 *   1. `agent-rewake install --only qwen-code --yes` in a terminal: it asks nothing.
 *   2. `agent-rewake continue --always`: automatic resume on.
 *   3. In Qwen Code's terminal UI, one turn is answered, then the next hits a plan quota that ran
 *      out and will reset on its own; Qwen shows its own "Quota exhausted: …" message (no dialog
 *      to answer) and the person quits with /quit.
 *   4. Rewake's hooks recorded the limit with its reset, and at the session's end armed a resume
 *      with an OS timer. `classifyQwenFailure` (core/limits/agents.ts) must read this as resumable
 *      even though the hook's own `error` field says `billing_error`: Qwen's fail-fast rethrow for
 *      this exact case drops the original HTTP status, so its own classify-api-error.ts falls
 *      through to a text match on "quota" before ever reaching "rate_limit" — confirmed against a
 *      real Qwen Code build, not assumed.
 *   5. After the reset, what the timer runs (`node <stable copy> fire <id>`, from the timer's own
 *      file) continues the same session once; firing again sends nothing.
 *
 * The terminal UI is the path: Qwen never fires StopFailure for an API error in a headless (`-p`)
 * run (confirmed empirically), so Rewake can't see a limit there.
 *
 * Auth and the API's address are env-only (OPENAI_API_KEY, OPENAI_BASE_URL, and
 * security.auth.selectedType in settings.json): the same way Rewake's own resume spawns Qwen, with
 * no CLI flags of its own to add them.
 *
 * The terminal is macOS's script(1); the run is wrapped in sandbox-exec with all outbound network
 * denied except to localhost. The credential is a made-up key only the mock sees. `launchctl` and
 * `osascript` are stand-ins on PATH that record their arguments: the real timer and notification
 * are covered by timers-os.test.ts, and this test never touches the person's own launchd or
 * desktop. Slow (about a minute: Rewake waits a minute past the reset), so it runs only with
 * REWAKE_E2E=1, on macOS.
 */
const root = join(import.meta.dirname, "..");
const bundle = join(root, "dist", "agent-rewake.js");
const agents = join(root, "test", "agents", "node_modules", ".bin");
const enabled =
  process.env.REWAKE_E2E === "1" &&
  process.platform === "darwin" &&
  existsSync(join(agents, "qwen"));

/** macOS's sandbox: no network except localhost (the guard fails the test if it can't run). */
const SANDBOX = `(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))`;

/** Records the arguments of each run, for the stand-ins of launchctl and osascript. */
const STAND_IN = `#!/bin/sh\nprintf '%s\\n' "$(basename "$0") $*" >> "$REWAKE_TEST_CALLS"\nexit 0\n`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A command in a terminal of its own (script(1)), sandboxed. `script` needs a pipe, not a socket,
 * on its input: `cat` gives it one.
 */
function terminal(command: string[], cwd: string, env: NodeJS.ProcessEnv) {
  // The terminal's own process group (script(1) starts one) is noted, so that a failed run can
  // stop everything it started: Qwen Code carries on when its terminal goes away.
  const group = join(mkdtempSync(join(env.HOME ?? tmpdir(), "terminal-")), "pgid");
  const child = spawn(
    "/bin/sh",
    [
      "-c",
      `cat | exec /usr/bin/sandbox-exec -p "$0" /usr/bin/script -q /dev/null /bin/sh -c 'echo $$ > "$REWAKE_TEST_PGID"; stty cols 140 rows 50 2>/dev/null; exec "$@"' sh "$@"`,
      SANDBOX,
      ...command,
    ],
    {
      cwd,
      env: { ...env, REWAKE_TEST_PGID: group },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    },
  ) as ChildProcessWithoutNullStreams;
  const kill = () => {
    const groups = [child.pid ?? 0];
    if (existsSync(group)) groups.push(Number(readFileSync(group, "utf8")));
    for (const g of groups)
      try {
        if (g > 0) process.kill(-g, "SIGKILL");
      } catch {
        // Already gone.
      }
  };
  let raw = "";
  child.stdout.on("data", (d: Buffer) => {
    raw += d.toString("utf8");
  });
  child.stderr.on("data", (d: Buffer) => {
    raw += d.toString("utf8");
  });
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  /** The screen as text (escape sequences out), from `from` characters of output on. */
  const screen = (from = 0) => stripVTControlCharacters(raw.slice(from));
  const until = async (ok: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!ok() && Date.now() < end) await sleep(200);
    return ok();
  };
  /** Type a line: the text, then Enter on its own, as a person does. */
  const type = async (text: string) => {
    child.stdin.write(text);
    await sleep(300);
    child.stdin.write("\r");
  };
  const end = async (ms: number) => {
    child.stdin.end();
    const code = await Promise.race([exited, sleep(ms).then(() => "timeout" as const)]);
    if (code === "timeout") kill();
    return code;
  };
  return { child, screen, until, type, end, kill, length: () => raw.length };
}

/** Qwen Code's session files: `<QWEN_HOME>/projects/<project>/chats/*.jsonl` (default `~/.qwen`). */
function sessionFiles(home: string): string[] {
  const projects = join(home, ".qwen", "projects");
  if (!existsSync(projects)) return [];
  return readdirSync(projects).flatMap((p) => {
    const chats = join(projects, p, "chats");
    return existsSync(chats)
      ? readdirSync(chats)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => join(chats, f))
      : [];
  });
}
const sessionText = (home: string) =>
  sessionFiles(home)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

describe.runIf(enabled)("Qwen Code, offline: limit → automatic resume", () => {
  it("records the limit, arms a resume at the reset, then continues the same session once", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "rewake-qwen-loop-")));
    const work = join(home, "work");
    const state = join(home, "state");
    const bin = join(home, "bin");
    const calls = join(home, "calls.log");
    mkdirSync(work);
    mkdirSync(bin);
    mkdirSync(join(home, ".qwen"));
    for (const name of ["launchctl", "osascript"])
      writeFileSync(join(bin, name), STAND_IN, { mode: 0o755 });
    // A Qwen Code user signed in with an OpenAI-compatible key, with nothing that phones home.
    writeFileSync(
      join(home, ".qwen", "settings.json"),
      JSON.stringify({
        security: { auth: { selectedType: "openai" } },
        privacy: { usageStatisticsEnabled: false },
        telemetry: { enabled: false },
      }),
    );
    let mock: Mock | undefined;
    let armed: string | undefined;
    const terminals: ReturnType<typeof terminal>[] = [];
    try {
      mock = await startMock();
      mock.set({ mode: "ok", reply: "FIRST_OK" });
      const env: NodeJS.ProcessEnv = {
        PATH: [bin, agents, "/usr/bin", "/bin", join(process.execPath, "..")].join(":"),
        HOME: home,
        TMPDIR: home,
        TERM: "xterm-256color",
        AGENT_REWAKE_STATE_DIR: state,
        REWAKE_TEST_CALLS: calls,
        // Env-only, no CLI flags: the same way Rewake's own resume spawns Qwen.
        OPENAI_BASE_URL: `${mock.url}/v1`,
        // A made-up key: it reaches only the mock.
        OPENAI_API_KEY: "fake-key-for-test",
      };
      const rewake = (...args: string[]) =>
        execFileSync(process.execPath, [bundle, ...args], { cwd: work, env, encoding: "utf8" });

      // 1. Install, in a terminal: with --yes it asks nothing (Rewake asks no question about error reports).
      const install = terminal(
        [process.execPath, bundle, "install", "--only", "qwen-code", "--yes"],
        work,
        env,
      );
      terminals.push(install);
      expect(
        await install.until(() => /Done\.|Nothing was changed/.test(install.screen()), 60_000),
      ).toBe(true);
      expect(await install.end(15_000)).toBe(0);
      expect(install.screen()).toMatch(/Done\.\s+Next, start a new Qwen Code session/);
      expect(install.screen()).not.toMatch(/\[y\/N\]|error report/i);
      const settingsAfter = readFileSync(join(home, ".qwen", "settings.json"), "utf8");
      expect(settingsAfter).toContain("hook qwen-code StopFailure");

      // 2. Automatic resume on.
      expect(rewake("continue", "--always")).toMatch(/^From now on/);

      // 3. A session in Qwen Code's terminal UI: one turn answered, the next hits the quota.
      const qwen = terminal(["qwen"], work, env);
      terminals.push(qwen);
      expect(await qwen.until(() => /Type your message/.test(qwen.screen()), 60_000)).toBe(true);
      await sleep(1_000);
      await qwen.type("say hi");
      // Qwen's own transcript shape: {"message":{"role":"model","parts":[{"text":"…"}]}}.
      expect(await qwen.until(() => /"text":"FIRST_OK"/.test(sessionText(home)), 60_000)).toBe(
        true,
      );
      await sleep(2_000);
      // `limitForce` refuses regardless of how long the UI flow below takes: `until` only sets
      // the advertised reset time (the same clock-dependent flake found in codex-loop.test.ts).
      const until = Date.now() + 20_000;
      mock.set({ mode: "limit", until, limitForce: true, profile: "qwen" });
      const from = qwen.length();
      await qwen.type("carry on");
      // Qwen shows its own "Quota exhausted" message directly: no dialog to answer.
      expect(
        await qwen.until(
          () => /Quota exhausted: 429 Your token-plan/.test(qwen.screen(from)),
          30_000,
        ),
      ).toBe(true);
      const hookFired = () => /StopFailure/.test(readLog(state));
      expect(await qwen.until(hookFired, 15_000)).toBe(true);
      // The mock refused the turn with the quota error.
      expect(mock.log().some((r) => r.limited && /\/chat\/completions$/.test(r.path))).toBe(true);
      mock.set({ limitForce: false });
      await sleep(1_000);
      await qwen.type("/quit");
      expect(await qwen.until(() => /SessionEnd/.test(readLog(state)), 30_000)).toBe(true);
      await qwen.end(15_000);

      // 4. Rewake recorded the limit with the reset Qwen gave, and armed a resume. The hook's
      // `error` was `billing_error` (Qwen's own fail-fast rethrow for this case drops the status),
      // and classifyQwenFailure still reads it as a resumable, time-boxed weekly quota — not money.
      const [record, ...more] = new SessionRecords(state, "qwen-code").list();
      expect(more).toEqual([]);
      if (!record) throw new Error("no session record");
      const sessionId = record.sessionId;
      expect(record.open).toBe(false);
      expect(record.limit?.billing).toBe(false);
      expect(Math.abs((record.limit?.resetsAt ?? 0) - until)).toBeLessThan(60_000);
      const [resume, ...others] = new ScheduleStore(state).list();
      expect(others).toEqual([]);
      if (!resume) throw new Error("no resume armed");
      armed = resume.scheduleId;
      expect(resume).toMatchObject({
        host: "qwen-code",
        kind: "limit_resume",
        status: "scheduled",
        sessionRef: { sessionId },
      });
      expect(resume.dueAt).toBe((record.limit?.resetsAt ?? 0) + 60_000);
      // The OS timer: a launchd job for the resume, from a file in Rewake's state folder.
      const plist = join(state, "timers", `codizelabs.agent-rewake.${resume.scheduleId}.plist`);
      const said = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");
      expect(said()).toContain(`launchctl bootstrap gui/${process.getuid?.()} ${plist}`);
      expect(said()).toMatch(/osascript .*Rewake will continue Qwen Code in the \\"work\\" folder/);
      // What the timer runs: its ProgramArguments.
      const job = /<key>ProgramArguments<\/key>\s*<array>(.*?)<\/array>/s.exec(
        readFileSync(plist, "utf8"),
      );
      const program = [...(job?.[1] ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map(
        (m) => m[1] ?? "",
      );
      expect(program[0]).toMatch(/node$/);
      expect(program.slice(1)).toEqual([
        join(state, "bin", "agent-rewake.mjs"),
        "fire",
        resume.scheduleId,
        "--state-dir",
        state,
      ]);

      // 5. After the reset: what the timer runs.
      await sleep(Math.max(0, resume.dueAt - 30_000 - Date.now()) + 1_000);
      mock.set({ reply: "RESUMED_OK" });
      const before = mock.log().length;
      // Not execFileSync: the mock answers from this process.
      const fire = () =>
        new Promise<void>((resolve, reject) =>
          execFile(
            "/usr/bin/sandbox-exec",
            ["-p", SANDBOX, ...program],
            { cwd: work, env, timeout: 120_000 },
            (err) => (err ? reject(err) : resolve()),
          ),
        );
      await fire();
      const sent = mock.log().slice(before);
      expect(sent.some((r) => r.limited)).toBe(false);
      // Qwen also runs its own "managed memory extraction subagent" after a turn, a separate
      // request carrying the same recent history (and so the same resume text) in its own,
      // differently-worded system prompt; excluded here as not the turn under test.
      const turns = sent.filter(
        (r) =>
          /\/chat\/completions$/.test(r.path) &&
          r.body.includes(resume.text.slice(0, 60)) &&
          !r.body.includes("managed memory extraction subagent"),
      );
      expect(turns).toHaveLength(1);
      // The same conversation: the earlier turns go with it, and the answer is added to the
      // session's own file (Qwen also starts a fresh runtime file with the same id when it resumes).
      expect(turns[0]?.body).toContain("say hi");
      const resumed = () =>
        sessionFiles(home).filter((f) => readFileSync(f, "utf8").includes("RESUMED_OK"));
      expect(resumed()).toHaveLength(1);
      const transcript = readFileSync(resumed()[0] ?? "", "utf8");
      expect(transcript).toContain(sessionId);
      // The on-screen "Quota exhausted: " prefix (already checked against the terminal above) is
      // added only for display; the saved transcript keeps the raw provider wording.
      expect(transcript).toMatch(
        /FIRST_OK[\s\S]*token-plan 1-week quota has been exhausted[\s\S]*RESUMED_OK/,
      );
      expect(transcript).toContain(resume.text.slice(0, 60));
      expect(new ScheduleStore(state).get(resume.scheduleId)?.status).toBe("sent");
      expect(existsSync(plist)).toBe(false);

      // Once: the timer again sends nothing.
      const after = mock.log().length;
      await fire();
      await sleep(3_000);
      expect(mock.log().length).toBe(after);
      expect(resumed()).toHaveLength(1);
      expect(readFileSync(resumed()[0] ?? "", "utf8").match(/"text":"RESUMED_OK"/g)).toHaveLength(
        1,
      );
      expect(new ScheduleStore(state).get(resume.scheduleId)?.status).toBe("sent");
    } finally {
      for (const t of terminals) t.kill();
      await mock?.close();
      // Nothing of this test in the person's own launchd (the stand-in took every call).
      if (armed)
        expect(() =>
          execFileSync(
            "/bin/launchctl",
            ["print", `gui/${process.getuid?.()}/codizelabs.agent-rewake.${armed}`],
            { stdio: "ignore" },
          ),
        ).toThrow();
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 300_000);
});

/** Rewake's log in the test's state folder (metadata only). */
function readLog(state: string): string {
  const dir = join(state, "logs");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("");
}
