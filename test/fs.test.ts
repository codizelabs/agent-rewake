import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeAutoContinueDisabled,
  managedSettingsFiles,
} from "../src/adapters/claude/sources.js";
import { applyPlan, planInstall } from "../src/install.js";
import { readJsonFile, renameWithRetry, stripBom } from "../src/util/fs.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "rewake-fs-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const busy = (code: string) => Object.assign(new Error(code), { code });

describe("replacing a file another program briefly holds (Windows)", () => {
  it("retries EPERM/EACCES/EBUSY with backoff, then succeeds", () => {
    const errors = ["EPERM", "EBUSY", "EACCES"];
    const waits: number[] = [];
    renameWithRetry(
      "a",
      "b",
      "win32",
      () => {
        const next = errors.shift();
        if (next) throw busy(next);
      },
      (ms) => waits.push(ms),
    );
    expect(waits).toEqual([10, 20, 40]);
  });

  it("gives up after about 2 seconds and reports the error", () => {
    let waited = 0;
    expect(() =>
      renameWithRetry(
        "a",
        "b",
        "win32",
        () => {
          throw busy("EPERM");
        },
        (ms) => {
          waited += ms;
        },
      ),
    ).toThrow("EPERM");
    expect(waited).toBeGreaterThanOrEqual(2000);
    expect(waited).toBeLessThan(2600);
  });

  it("doesn't retry on macOS or Linux, where these errors are real", () => {
    let calls = 0;
    expect(() =>
      renameWithRetry("a", "b", "linux", () => {
        calls++;
        throw busy("EPERM");
      }),
    ).toThrow("EPERM");
    expect(calls).toBe(1);
  });
});

describe("files saved with a byte-order mark", () => {
  it("are read as JSON", () => {
    const f = join(dir, "x.json");
    writeFileSync(f, '\uFEFF{"a":1}');
    expect(readJsonFile(f)).toEqual({ a: 1 });
    expect(stripBom("plain")).toBe("plain");
  });

  it("still let an administrator turn automatic continuation off", () => {
    const claude = join(dir, "claude");
    mkdirSync(claude);
    writeFileSync(join(claude, "settings.json"), '\uFEFF{ "autoContinueAtUsageLimit": false }');
    expect(claudeAutoContinueDisabled({ CLAUDE_CONFIG_DIR: claude }, "")).toBe(true);
  });

  it("are edited by install, and keep their mark", () => {
    const zed = join(dir, "zed");
    mkdirSync(zed);
    writeFileSync(
      join(zed, "settings.json"),
      '\uFEFF{\r\n  "theme": "One Dark",\r\n  "agent_servers": { "my-agent": { "type": "custom", "command": "my-agent" } }\r\n}\r\n',
    );
    const plan = planInstall({
      dir: zed,
      launch: { command: "/n/node", args: ["/r.js"] },
      keybinding: false,
      env: { AGENT_REWAKE_ZED_DATA_DIR: join(dir, "data") },
      stateDir: join(dir, "state"),
    });
    expect(plan.changes.some((c) => c.file.endsWith("settings.json"))).toBe(true);
    applyPlan(plan);
    const text = readFileSync(join(zed, "settings.json"), "utf8");
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('"theme": "One Dark"');
    expect(text).toContain("--wrap-command");
  });
});

describe("Claude's managed settings", () => {
  it("are read from both Windows locations", () => {
    expect(managedSettingsFiles({}, "win32")).toEqual([
      "C:\\Program Files\\ClaudeCode\\managed-settings.json",
      "C:\\ProgramData\\ClaudeCode\\managed-settings.json",
    ]);
    expect(managedSettingsFiles({}, "linux")).toEqual(["/etc/claude-code/managed-settings.json"]);
  });
});
