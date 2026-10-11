import { execFileSync, spawn } from "node:child_process";
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
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { type Mock, startMock } from "./e2e/mock-llm.mjs";

/**
 * The whole loop with the real Codex CLI (test/agents, pinned), offline: Rewake is installed into an
 * isolated Codex the way a person installs it, automatic resume is turned on, and a `codex exec` turn
 * hits a local mock of OpenAI's API that answers with Codex's usage-limit response. Rewake's
 * SessionEnd hook reads the limit from the thread's session file and arms a resume at the reset;
 * at that time `agent-rewake fire <id>` (what the OS timer runs) queues the continue message into
 * the same thread with `codex queue`, once; the thread, opened again, runs it and the mock answers.
 *
 * Codex is signed in with a made-up ChatGPT login (an unsigned token that only the mock sees),
 * because Codex reads its usage (`account/rateLimits/read`, which `fire` checks) only when signed in
 * with ChatGPT, and only ChatGPT plans have these limits. `chatgpt_base_url` points that at the mock
 * too. Offline by construction: on macOS every Codex and Rewake run is wrapped in sandbox-exec with
 * all outbound network denied except to localhost; launchd refuses jobs from sandboxed processes,
 * so there a stand-in `launchctl` takes the timer (fakeLaunchctl). Slow (about 40 seconds: Rewake
 * continues a minute after the reset, and `fire` may run 30 seconds early), so it runs only with
 * REWAKE_E2E=1, after `npm ci --prefix test/agents`.
 */
// The network guard exists on macOS only; elsewhere the test runs only when asked to run unguarded.
const enabled =
  process.env.REWAKE_E2E === "1" &&
  (process.platform === "darwin" || process.env.REWAKE_E2E_UNGUARDED === "1");
const root = join(import.meta.dirname, "..");
const bundle = join(root, "dist", "agent-rewake.js");
const agents = join(root, "test", "agents", "node_modules", ".bin");

/** macOS's sandbox: no network except localhost (the guard fails the test if it can't run). */
const SANDBOX = `(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))`;
/** `fire` treats a run this long before the resume's time as early (src/timers/fire.ts). */
const EARLY_MS = 30_000;
/** Rewake continues this long after the reset (src/core/resume.ts RESET_MARGIN_MS). */
const MARGIN_MS = 60_000;

/** A program inside the network guard. */
function guarded(command: string, args: string[]): [string, string[]] {
  return process.platform === "darwin"
    ? ["/usr/bin/sandbox-exec", ["-p", SANDBOX, command, ...args]]
    : [command, args];
}

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const [c, a] = guarded(command, args);
  return new Promise((resolve) => {
    const child = spawn(c, a, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/**
 * Open a thread in Codex as its own apps do (`codex app-server`, `thread/resume`): Codex starts a
 * queued message as a normal turn. Resolves once a turn has completed and a few quiet seconds
 * passed (a second queued message would start in them), or after `ms` with no turn.
 */
function openThread(env: NodeJS.ProcessEnv, cwd: string, threadId: string, ms: number) {
  const [c, a] = guarded(join(agents, "codex"), ["app-server", "--listen", "stdio://"]);
  const child = spawn(c, a, { env, cwd, stdio: ["pipe", "pipe", "ignore"] });
  const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
  return new Promise<number>((resolve) => {
    let turns = 0;
    let quiet: NodeJS.Timeout | undefined;
    const done = () => {
      clearTimeout(timer);
      clearTimeout(quiet);
      child.kill();
      resolve(turns);
    };
    const timer = setTimeout(done, ms);
    createInterface({ input: child.stdout }).on("line", (line) => {
      let m: { id?: number; method?: string };
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.id === 1) {
        send({ method: "initialized" });
        send({ id: 2, method: "thread/resume", params: { threadId } });
      } else if (m.method === "turn/started") clearTimeout(quiet);
      else if (m.method === "turn/completed") {
        turns++;
        quiet = setTimeout(done, 5_000);
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "rewake_test", title: "Rewake test", version: "0" } },
    });
  });
}

/** An unsigned JWT with made-up claims: Codex reads the claims and never checks a signature. */
function fakeJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({
    email: "rewake-test@example.invalid",
    exp: 4_102_444_800,
    "https://api.openai.com/auth": {
      chatgpt_plan_type: "plus",
      chatgpt_account_id: "rewake-test-account",
      chatgpt_user_id: "rewake-test-user",
    },
  })}.not-a-signature`;
}

type Line = { type?: string; payload?: Record<string, unknown> };
const lines = (file: string): Line[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Line);

/** The texts of the person's messages in a session file (`item_completed` UserMessage items). */
function userTexts(file: string, threadId: string): string[] {
  return lines(file)
    .map((l) => l.payload)
    .filter((p) => p?.type === "item_completed" && p.thread_id === threadId)
    .map((p) => p?.item as { type?: string; content?: { text?: string }[] })
    .filter((i) => i?.type === "UserMessage")
    .map((i) => (i.content ?? []).map((c) => c.text ?? "").join(""));
}

function rollouts(codexHome: string): string[] {
  const dir = join(codexHome, "sessions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f));
}

interface StoredResume {
  scheduleId: string;
  host?: string;
  kind: string;
  status: string;
  dueAt: number;
  text: string;
  attempts: unknown[];
  sessionRef?: { threadId?: string; transcript?: string; codexHome?: string };
}

function resumes(state: string): StoredResume[] {
  const dir = join(state, "schedules");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as StoredResume);
}

/** Rewake's metadata-only log lines (src/util/log.ts). */
function logged(state: string): { event?: string; via?: string; outcome?: string }[] {
  const dir = join(state, "logs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) =>
    readFileSync(join(dir, f), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
  );
}

/**
 * A stand-in for macOS's `launchctl`, first on PATH. launchd refuses jobs from a sandboxed process,
 * and every Rewake hook runs inside the network guard, so the guarded run can't arm a real timer.
 * The stand-in keeps what Rewake loads (`bootstrap`), answers `print` and removes on `bootout`, and
 * logs each call; the test then runs exactly what the loaded timer would run. The person's own
 * launchd is never touched.
 */
function fakeLaunchctl(dir: string): { log: string; loaded: string } {
  const bin = join(dir, "bin");
  const loaded = join(dir, "launchd");
  const log = join(dir, "launchctl.log");
  mkdirSync(bin);
  mkdirSync(loaded);
  writeFileSync(
    join(bin, "launchctl"),
    [
      "#!/bin/sh",
      `echo "$*" >> '${log}'`,
      'case "$1" in',
      `  bootstrap) cp "$3" '${loaded}/'"$(basename "$3" .plist)" ;;`,
      `  bootout) f='${loaded}/'"\${2##*/}"; [ -f "$f" ] || exit 3; rm -f "$f" ;;`,
      `  print) [ -f '${loaded}/'"\${2##*/}" ] || exit 113 ;;`,
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { log, loaded };
}

const waitFor = async (ok: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 250));
  return ok();
};

describe.runIf(enabled)("Codex CLI, offline: limit → automatic resume", () => {
  it("arms at the limit, then continues the same thread once at the reset", async () => {
    // Real path: Codex records session files under its canonical CODEX_HOME (/private/var on macOS).
    const home = realpathSync(mkdtempSync(join(tmpdir(), "rewake-codex-loop-")));
    const work = join(home, "work");
    const codexHome = join(home, ".codex");
    const state = join(home, "state");
    mkdirSync(work);
    mkdirSync(codexHome);
    const launchd = process.platform === "darwin" ? fakeLaunchctl(home) : undefined;
    let mock: Mock | undefined;
    const env: NodeJS.ProcessEnv = {
      PATH: [...(launchd ? [join(home, "bin")] : []), agents, process.env.PATH ?? ""].join(
        process.platform === "win32" ? ";" : ":",
      ),
      HOME: home,
      CODEX_HOME: codexHome,
      AGENT_REWAKE_STATE_DIR: state,
    };
    const rewake = (...args: string[]) => run(process.execPath, [bundle, ...args], env, work);
    try {
      mock = await startMock();
      // Codex as a person has it: signed in with ChatGPT, here against the mock. Codex keeps the
      // login in auth.json (file storage, so the keychain isn't touched).
      writeFileSync(
        join(codexHome, "config.toml"),
        [
          'model = "mock-model"',
          'model_provider = "mock"',
          `chatgpt_base_url = "${mock.url}/backend-api"`,
          'cli_auth_credentials_store = "file"',
          "",
          "[model_providers.mock]",
          'name = "Mock"',
          `base_url = "${mock.url}/v1"`,
          "requires_openai_auth = true",
          'wire_api = "responses"',
          "",
        ].join("\n"),
      );
      const jwt = fakeJwt();
      writeFileSync(
        join(codexHome, "auth.json"),
        JSON.stringify({
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: {
            id_token: jwt,
            access_token: jwt,
            refresh_token: "rewake-test-not-a-real-token",
            account_id: "rewake-test-account",
          },
          last_refresh: new Date().toISOString(),
        }),
      );

      // 1. Install, as a person would: Codex's own plugin commands record it in config.toml.
      const installed = await rewake("install", "--only", "codex", "--yes");
      expect(installed.stdout).toMatch(/Done\./);
      expect(installed.status).toBe(0);
      expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toContain(
        '[plugins."agent-rewake@agent-rewake"]',
      );
      // 2. Automatic resume on.
      const always = await rewake("continue", "--always");
      expect(always.status).toBe(0);
      expect(JSON.parse(readFileSync(join(state, "settings.json"), "utf8")).newThreads).toBe("on");

      // 3. A turn at the usage limit. A person trusts the hooks once in Codex's hook review;
      // headless, this run bypasses that review instead.
      // `limitForce` refuses regardless of how long the process takes to start: `until` only sets
      // the advertised reset time (this test's own clock-dependent flake, found 2026-10-08).
      const until = Date.now() + 5_000;
      mock.set({ mode: "limit", until, limitForce: true, reply: "RESUMED_OK" });
      const exec = await run(
        join(agents, "codex"),
        ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-hook-trust", "say hi"],
        env,
        work,
      );
      mock.set({ limitForce: false });
      expect(exec.status).not.toBe(0);
      expect(exec.stdout).toMatch(/"type":"turn\.failed"/);
      const thread = /"thread_id":"([0-9a-f-]{36})"/.exec(exec.stdout)?.[1] ?? "";
      expect(thread).toMatch(/^[0-9a-f-]{36}$/);
      expect(mock.log().some((r) => r.path === "/v1/responses" && r.limited)).toBe(true);
      const [rollout, ...others] = rollouts(codexHome);
      expect(others).toHaveLength(0);
      expect(rollout).toContain(thread);
      const turn = lines(rollout ?? "").map((l) => l.payload);
      expect(
        turn.some(
          (p) => p?.type === "task_complete" && JSON.stringify(p).includes("usage_limit_exceeded"),
        ),
      ).toBe(true);

      // 4. Rewake recorded the limit at its reset and armed a resume of this thread.
      const [armed, ...more] = resumes(state);
      expect(more).toHaveLength(0);
      expect(armed).toMatchObject({
        host: "codex",
        kind: "limit_resume",
        status: "scheduled",
        sessionRef: { threadId: thread, transcript: rollout, codexHome },
      });
      const id = armed?.scheduleId ?? "";
      const dueAt = armed?.dueAt ?? 0;
      expect(Math.abs(dueAt - MARGIN_MS - until)).toBeLessThanOrEqual(60_000);
      expect(
        logged(state).some(
          (l) => l.event === "hook.arm" && l.via !== "no-scheduler" && l.via !== "failed",
        ),
      ).toBe(true);
      // What the timer runs: `<node> <state>/bin/agent-rewake.mjs fire <id> --state-dir <state>`, from the loaded plist
      // on macOS (checked with Apple's plutil), at the minute of the resume.
      const launcher = join(state, "bin", "agent-rewake.mjs");
      let command = [process.execPath, launcher, "fire", id, "--state-dir", state];
      if (launchd) {
        const label = `codizelabs.agent-rewake.${id}`;
        const plist = join(launchd.loaded, label);
        expect(readFileSync(launchd.log, "utf8")).toContain(
          `bootstrap gui/${process.getuid?.()} ${join(state, "timers", `${label}.plist`)}`,
        );
        execFileSync("plutil", ["-lint", plist], { stdio: "ignore" });
        const xml = readFileSync(plist, "utf8");
        const args = /<key>ProgramArguments<\/key>\s*<array>(.*?)<\/array>/s.exec(xml)?.[1] ?? "";
        command = [...args.matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1] ?? "");
        expect(command.slice(1)).toEqual([launcher, "fire", id, "--state-dir", state]);
        const due = new Date(Math.ceil(dueAt / 60_000) * 60_000);
        expect(xml).toContain(
          `<key>Hour</key><integer>${due.getHours()}</integer><key>Minute</key><integer>${due.getMinutes()}</integer>`,
        );
      }
      const [node = "", ...args] = command;

      // 5. At the resume's time, the timer's command, with the same environment.
      await waitFor(() => Date.now() >= dueAt - EARLY_MS + 1_000, dueAt - Date.now());
      const before = mock.log().length;
      expect((await run(node, args, env, work)).status).toBe(0);
      // It asked Codex whether usage is back (Codex read it from the mock) before sending.
      expect(
        mock
          .log()
          .slice(before)
          .some((r) => r.path === "/backend-api/wham/usage"),
      ).toBe(true);
      const sent = resumes(state)[0];
      expect(sent?.status).toBe("sent");
      expect(sent?.attempts).toHaveLength(1);
      // Once: a second run (a timer firing late, a sweep) sends nothing.
      expect((await run(node, args, env, work)).status).toBe(0);
      expect(resumes(state)[0]?.attempts).toHaveLength(1);
      expect(
        logged(state)
          .filter((l) => l.event === "fire.done")
          .map((l) => l.outcome),
      ).toEqual(["sent", "gone"]);

      // The thread, opened again, runs the queued message: one turn, in the same session file.
      const text = armed?.text ?? "";
      expect(await openThread(env, work, thread, 45_000)).toBe(1);
      const asked = mock.log().filter((r) => r.path === "/v1/responses" && r.body.includes(text));
      expect(asked).toHaveLength(1);
      expect(asked[0]?.limited).toBe(false);
      expect(rollouts(codexHome)).toEqual([rollout]);
      expect(userTexts(rollout ?? "", thread)).toEqual(["say hi", text]);
      expect(readFileSync(rollout ?? "", "utf8")).toContain('"last_agent_message":"RESUMED_OK"');

      // `fire` removed its timer (from a detached child, two seconds after it exits).
      if (launchd)
        expect(await waitFor(() => readdirSync(launchd.loaded).length === 0, 10_000)).toBe(true);
    } finally {
      await rewake("uninstall", "--only", "codex", "--yes");
      await mock?.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 180_000);
});
