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
import "../src/hosts/index.js"; // registers the "gemini-cli" host
import { SessionRecords } from "../src/hosts/sessions.js";
import { type Mock, startMock } from "./e2e/mock-llm.mjs";

/**
 * Gemini CLI's whole loop outside Zed, offline (plan §9.5, §10.2 L3): the real Gemini CLI (pinned
 * in test/agents) against a local mock of Google's API, with Rewake installed the way a person
 * installs it.
 *
 *   1. `agent-rewake install --only gemini-cli --yes` in a terminal: Gemini's own
 *      `extensions link` runs and asks its own two questions (trust the folder, allow hooks),
 *      answered "y" as a person would.
 *   2. `agent-rewake continue --always`: automatic resume on.
 *   3. In Gemini's terminal UI, one turn is answered, then the next hits the "Individual quota"
 *      limit; the person picks "Stop" in Gemini's usage-limit dialog and quits with /quit.
 *   4. Rewake's hooks recorded the limit with its reset, and at the session's end armed a resume
 *      with an OS timer.
 *   5. After the reset, what the timer runs (`node <stable copy> fire <id>`, from the timer's own
 *      file) continues the same session once; firing again sends nothing.
 *
 * The terminal UI is the path: in headless runs (`gemini -p`) Gemini never records the error in the
 * session file and never runs the AfterAgent hook after an API error (and with `-o json`, not the
 * SessionEnd hook either), so Rewake can't see a limit there.
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
  existsSync(join(agents, "gemini"));

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
  // stop everything it started: Gemini CLI carries on when its terminal goes away.
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

/** Gemini CLI's session files: `<GEMINI_CLI_HOME>/.gemini/tmp/<project>/chats/*.jsonl`. */
function sessionFiles(home: string): string[] {
  const tmp = join(home, ".gemini", "tmp");
  if (!existsSync(tmp)) return [];
  return readdirSync(tmp).flatMap((p) => {
    const chats = join(tmp, p, "chats");
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

describe.runIf(enabled)("Gemini CLI, offline: limit → automatic resume", () => {
  it("records the limit, arms a resume at the reset, then continues the same session once", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "rewake-gemini-loop-")));
    const work = join(home, "work");
    const state = join(home, "state");
    const bin = join(home, "bin");
    const calls = join(home, "calls.log");
    mkdirSync(work);
    mkdirSync(bin);
    mkdirSync(join(home, ".gemini"));
    for (const name of ["launchctl", "osascript"])
      writeFileSync(join(bin, name), STAND_IN, { mode: 0o755 });
    // A Gemini CLI user signed in with an API key, with nothing that phones home. One model, as
    // chosen with /model: Gemini's quotas are per model, and with "auto" its router would ask the
    // (limited) mock first.
    writeFileSync(
      join(home, ".gemini", "settings.json"),
      JSON.stringify({
        security: { auth: { selectedType: "gemini-api-key" } },
        model: { name: "gemini-3.8-flash" },
        general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
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
        GEMINI_CLI_HOME: home,
        AGENT_REWAKE_STATE_DIR: state,
        REWAKE_TEST_CALLS: calls,
        GOOGLE_GEMINI_BASE_URL: mock.url,
        // A made-up key: it reaches only the mock.
        GEMINI_API_KEY: "fake-key-for-test",
        NO_BROWSER: "true",
      };
      const rewake = (...args: string[]) =>
        execFileSync(process.execPath, [bundle, ...args], { cwd: work, env, encoding: "utf8" });

      // 1. Install, in a terminal: Gemini asks its own questions, answered "y"; Rewake's own
      // error-reports question (interactive installs only) defaults to "no", left at that.
      const install = terminal(
        [process.execPath, bundle, "install", "--only", "gemini-cli", "--yes"],
        work,
        env,
      );
      terminals.push(install);
      let answered = 0;
      let declined = 0;
      expect(
        await install.until(() => {
          const asked = install.screen().match(/\[Y\/n\]/g)?.length ?? 0;
          for (; answered < asked; answered++) install.child.stdin.write("y\r");
          const asksNo = install.screen().match(/\[y\/N\]/g)?.length ?? 0;
          for (; declined < asksNo; declined++) install.child.stdin.write("\r");
          return /Done\.|Nothing was changed/.test(install.screen());
        }, 90_000),
      ).toBe(true);
      expect(await install.end(15_000)).toBe(0);
      expect(install.screen()).toMatch(/"agent-rewake" linked successfully/);
      expect(install.screen()).toMatch(/Done\.\s+Next, start a new Gemini CLI session/);
      expect(answered).toBe(2);
      expect(existsSync(join(home, ".gemini", "extensions", "agent-rewake"))).toBe(true);

      // 2. Automatic resume on.
      expect(rewake("continue", "--always")).toMatch(/^From now on/);

      // 3. A session in Gemini's terminal UI: one turn answered, the next stopped by the limit.
      const gemini = terminal(["gemini"], work, env);
      terminals.push(gemini);
      expect(await gemini.until(() => /Type your message/.test(gemini.screen()), 60_000)).toBe(
        true,
      );
      await sleep(1_000);
      await gemini.type("say hi");
      expect(
        await gemini.until(
          () => /"type":"gemini","content":"FIRST_OK"/.test(sessionText(home)),
          60_000,
        ),
      ).toBe(true);
      await sleep(2_000);
      // `limitForce` refuses regardless of how long the UI flow below takes: `until` only sets
      // the advertised reset time (the same clock-dependent flake found in codex-loop.test.ts).
      const until = Date.now() + 20_000;
      mock.set({ mode: "limit", until, limitForce: true });
      const from = gemini.length();
      await gemini.type("carry on");
      // Gemini's usage-limit dialog: the person picks "Stop".
      const errorRecord = () => /"type":"error"/.test(sessionText(home));
      expect(
        await gemini.until(
          () => /Usage limit reached[\s\S]*2\. Stop/.test(gemini.screen(from)),
          30_000,
        ),
      ).toBe(true);
      await sleep(500);
      await gemini.type("2");
      await gemini.until(errorRecord, 15_000);
      expect(errorRecord()).toBe(true);
      expect(sessionText(home)).toMatch(/Individual quota reached\. Resets in \d+s/);
      // The mock refused the turn with the quota error.
      expect(mock.log().some((r) => r.limited && /:streamGenerateContent$/.test(r.path))).toBe(
        true,
      );
      mock.set({ limitForce: false });
      await sleep(1_000);
      await gemini.type("/quit");
      expect(await gemini.until(() => /SessionEnd/.test(readLog(state)), 30_000)).toBe(true);
      await gemini.end(15_000);

      // 4. Rewake recorded the limit with the reset Gemini gave, and armed a resume.
      const [record, ...more] = new SessionRecords(state, "gemini-cli").list();
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
        host: "gemini-cli",
        kind: "limit_resume",
        status: "scheduled",
        sessionRef: { sessionId },
      });
      expect(resume.dueAt).toBe((record.limit?.resetsAt ?? 0) + 60_000);
      // The OS timer: a launchd job for the resume, from a file in Rewake's state folder.
      const plist = join(state, "timers", `codizelabs.agent-rewake.${resume.scheduleId}.plist`);
      const said = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");
      expect(said()).toContain(`launchctl bootstrap gui/${process.getuid?.()} ${plist}`);
      expect(said()).toMatch(
        /osascript .*Rewake will continue Gemini CLI in the \\"work\\" folder/,
      );
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
      const turns = sent.filter(
        (r) => /:streamGenerateContent$/.test(r.path) && r.body.includes(resume.text.slice(0, 60)),
      );
      expect(turns).toHaveLength(1);
      // The same conversation: the earlier turns go with it, and the answer is added to the
      // session's own file (Gemini also starts an empty file with the same id when it resumes).
      expect(turns[0]?.body).toContain("say hi");
      const resumed = () =>
        sessionFiles(home).filter((f) => readFileSync(f, "utf8").includes("RESUMED_OK"));
      expect(resumed()).toHaveLength(1);
      const transcript = readFileSync(resumed()[0] ?? "", "utf8");
      expect(JSON.parse(transcript.split("\n")[0] ?? "{}").sessionId).toBe(sessionId);
      expect(transcript).toMatch(/FIRST_OK[\s\S]*Individual quota reached[\s\S]*RESUMED_OK/);
      expect(transcript).toContain(resume.text.slice(0, 60));
      expect(new ScheduleStore(state).get(resume.scheduleId)?.status).toBe("sent");
      expect(existsSync(plist)).toBe(false);

      // Once: the timer again sends nothing.
      const after = mock.log().length;
      await fire();
      await sleep(3_000);
      expect(mock.log().length).toBe(after);
      expect(resumed()).toHaveLength(1);
      expect(
        readFileSync(resumed()[0] ?? "", "utf8").match(/"content":"RESUMED_OK"/g),
      ).toHaveLength(1);
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
