import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScheduleStore } from "../src/core/store.js";
import { armClosed, type ClosedDeps, closedAdapter } from "../src/hosts/closed.js";
import { copilotHost } from "../src/hosts/copilot/host.js";
import { runCopilotInstall } from "../src/hosts/copilot/install.js";
import "../src/hosts/index.js"; // registers the hosts
import { SessionRecords } from "../src/hosts/sessions.js";
import { fire } from "../src/timers/fire.js";
import { type OpenAiMock, startOpenAiMock } from "./e2e/mock-openai.mjs";

/**
 * GitHub Copilot CLI, the whole loop offline (plan §10.2 L3; research testing-harness §2.4): the real
 * Copilot CLI (REWAKE_COPILOT_BIN) with its offline provider pointed at a local mock. Rewake's hooks,
 * installed by Rewake's own installer and run from the built bundle, record a weekly limit; the
 * resume, armed as `agent-rewake continue` arms it, continues the same session through `fire` once
 * the mock answers again. A made-up key that only the mock sees; COPILOT_OFFLINE turns off GitHub
 * sign-in, telemetry and updates.
 */
const bin = process.env.REWAKE_COPILOT_BIN;
const root = join(import.meta.dirname, "..");

describe.runIf(bin)("Copilot CLI, offline: limit → resume", () => {
  it("records the weekly limit from its hooks and continues the same session", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rewake-copilot-loop-")));
    const home = join(dir, "home");
    const state = join(dir, "state");
    const work = join(dir, "work");
    mkdirSync(work, { recursive: true });
    execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], {
      cwd: root,
      stdio: "ignore",
    });
    let mock: OpenAiMock | undefined;
    try {
      mock = await startOpenAiMock();
      const env: NodeJS.ProcessEnv = {
        // Rewake finds the agent on the session's PATH, as it would on a real computer.
        PATH: `${dirname(bin as string)}${delimiter}${process.env.PATH ?? ""}`,
        HOME: home,
        COPILOT_HOME: join(home, ".copilot"),
        AGENT_REWAKE_STATE_DIR: state,
        COPILOT_OFFLINE: "true",
        COPILOT_PROVIDER_BASE_URL: mock.url,
        COPILOT_PROVIDER_API_KEY: "sk-test-not-a-real-key",
        COPILOT_MODEL: "gpt-4.1",
        COPILOT_AUTO_UPDATE: "false",
      };
      // Rewake's own installer writes the hooks, pointing at the built bundle's stable copy.
      expect(
        await runCopilotInstall({
          uninstall: false,
          yes: true,
          dryRun: false,
          env,
          stateDir: state,
          node: process.execPath,
          bundle: join(root, "dist", "agent-rewake.js"),
          interactive: false,
          out: () => {},
          ask: async () => true,
          programs: [{ path: bin as string, surface: "terminal", version: "1.0.92" }],
        }),
      ).toBe(0);
      // A weekly limit: Copilot retries, fires errorOccurred each time, then ends the session.
      mock.set({ mode: "limit" });
      // Async: the mock answers from this process, so a blocking spawn would starve it.
      const stdout = await new Promise<string>((resolve) => {
        let out = "";
        const child = spawn(
          bin as string,
          ["-p", "say hi", "--output-format", "json", "--allow-all-tools"],
          { cwd: work, env, stdio: ["ignore", "pipe", "ignore"] },
        );
        child.stdout.on("data", (d: Buffer) => {
          out += d.toString("utf8");
        });
        child.on("close", () => resolve(out));
      });
      const sessionId = /"sessionId":"([^"]+)"/.exec(stdout)?.[1] ?? "";
      expect(sessionId).not.toBe("");
      const record = new SessionRecords(state, "copilot-cli").get(sessionId);
      expect(record).toMatchObject({ open: false, limit: { kind: "weekly", billing: false } });

      // `agent-rewake continue` with a time, then the timer's `fire` once usage is back.
      const deps: ClosedDeps = {
        stateDir: state,
        now: Date.now(),
        env,
        arm: () => {},
        disarm: () => {},
        notify: () => {},
      };
      const resume = armClosed(copilotHost, record as NonNullable<typeof record>, Date.now(), deps);
      mock.set({ mode: "ok" });
      const before = mock.requests().length;
      const outcome = await fire(resume.scheduleId, {
        stateDir: state,
        now: () => Date.now() + 1000,
        hosts: new Map([["copilot-cli", closedAdapter(copilotHost, state, env)]]),
        notify: () => true,
      });
      process.stderr.write(
        `DBG ${JSON.stringify(new SessionRecords(state, "copilot-cli").get(sessionId))} ${JSON.stringify(new ScheduleStore(state).get(resume.scheduleId)?.attempts)}\n`,
      );
      expect(outcome).toBe("sent");
      expect(mock.requests().length).toBeGreaterThan(before);
      expect(new ScheduleStore(state).get(resume.scheduleId)?.status).toBe("sent");
      // Rewake's own resume run isn't taken for the person typing in the session.
      const after = new SessionRecords(state, "copilot-cli").get(sessionId);
      expect(after?.lastPromptAt ?? 0).toBeLessThan(resume.createdAt);
    } finally {
      await mock?.close();
      if (process.env.KEEP) process.stderr.write(`KEPT ${dir}\n`);
      else rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 240_000);
});
