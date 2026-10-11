import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeAutoContinueDisabled,
  managedSettingsFiles,
} from "../src/adapters/claude/sources.js";
import { applyPlan, planInstall } from "../src/install.js";
import {
  privateTempFile,
  readJsonFile,
  renameWithRetry,
  replaceFileExclusive,
  stripBom,
  writeTempExclusive,
} from "../src/util/fs.js";

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

describe("install's edits", () => {
  it("don't follow a symlink planted where install writes its temp file", () => {
    const zed = join(dir, "zed");
    mkdirSync(zed);
    const settings = join(zed, "settings.json");
    writeFileSync(settings, "{}\n");
    const victim = join(dir, "victim");
    writeFileSync(victim, "untouched");
    // Install's old temp name was `.settings.json.agent-rewake.<pid>.tmp`: guessable, and opened
    // with "w", so a symlink there turned an install into a write wherever it pointed.
    symlinkSync(victim, join(zed, `.settings.json.agent-rewake.${process.pid}.tmp`));
    const plan = planInstall({
      dir: zed,
      launch: { command: "/n/node", args: ["/r.js"] },
      keybinding: false,
      env: { AGENT_REWAKE_ZED_DATA_DIR: join(dir, "data") },
      stateDir: join(dir, "state"),
    });
    applyPlan(plan);
    expect(readFileSync(victim, "utf8")).toBe("untouched");
    expect(readFileSync(settings, "utf8")).toContain("--wrap-registry");
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

describe("temp files Rewake writes before replacing a file", () => {
  it("refuses a path that already exists, so nothing is overwritten", () => {
    const target = join(dir, "settings.json");
    writeFileSync(target, "{}");
    const first = writeTempExclusive(target, "a", 0o644);
    // The same name a second time is an exclusive create that has to fail (EEXIST), which is
    // what stops another process from choosing where Rewake's write lands.
    expect(() => openSync(first, "wx", 0o644)).toThrow(/EEXIST/);
    rmSync(first, { force: true });
  });

  it("never writes through a symlink planted at its temp path", () => {
    const target = join(dir, "settings.json");
    writeFileSync(target, "old");
    const victim = join(dir, "victim");
    writeFileSync(victim, "untouched");
    // The attack, with the guess already made: the exact temp name, taken by a symlink first.
    const guessed = writeTempExclusive(target, "probe", 0o644);
    rmSync(guessed, { force: true });
    symlinkSync(victim, guessed);
    expect(() => closeSync(openSync(guessed, "wx", 0o644))).toThrow(/EEXIST/);
    expect(readFileSync(victim, "utf8")).toBe("untouched");
    rmSync(guessed, { force: true });
    // And the guess can't be made: each name carries fresh random bytes.
    const names = new Set(
      Array.from({ length: 5 }, () => {
        const t = writeTempExclusive(target, "x", 0o644);
        rmSync(t, { force: true });
        return t;
      }),
    );
    expect(names.size).toBe(5);
  });

  it("replaces the file itself when a symlink stands at the target, not what it points at", () => {
    const victim = join(dir, "victim");
    writeFileSync(victim, "untouched");
    const link = join(dir, "login-item.plist");
    symlinkSync(victim, link);
    replaceFileExclusive(link, "new", 0o644);
    expect(readFileSync(link, "utf8")).toBe("new");
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe("untouched");
  });

  it("keeps the mode it is given and leaves nothing behind", () => {
    const target = join(dir, "kept");
    replaceFileExclusive(target, "x", 0o600);
    if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("a private temp file for a scheduled message", () => {
  it("is 0600, holds the message, and is gone after remove()", () => {
    const secret = "correct-horse-battery-staple";
    const file = privateTempFile("rewake-fs-test-", "message.txt", secret);
    expect(readFileSync(file.path, "utf8")).toBe(secret);
    if (process.platform !== "win32") {
      expect(statSync(file.path).mode & 0o777).toBe(0o600);
      // Its directory is the owner's alone, so the path being public costs nothing.
      expect(statSync(dirname(file.path)).mode & 0o777).toBe(0o700);
    }
    file.remove();
    expect(existsSync(file.path)).toBe(false);
    expect(existsSync(dirname(file.path))).toBe(false);
    // Removing twice is not an error: a resume may end more than one way.
    expect(() => file.remove()).not.toThrow();
  });
});

describe("backups of the person's files", () => {
  it("never overwrite each other, and only the newest few are kept", () => {
    const file = join(dir, "settings.json");
    const plan = (after: string) => ({
      changes: [{ file, existed: true, before: "", after, summary: ["x"] }],
      notes: [],
    });
    writeFileSync(file, "v0\n");
    const now = new Date("2026-10-09T10:00:00Z");
    // Two edits in the same second: two different backups, each holding the file as it was.
    const first = applyPlan(plan("v1\n"), now)[0] ?? "";
    const second = applyPlan(plan("v2\n"), now)[0] ?? "";
    expect(first).not.toBe(second);
    expect(readFileSync(first, "utf8")).toBe("v0\n");
    expect(readFileSync(second, "utf8")).toBe("v1\n");
    // Many more: the newest five stay.
    for (let i = 3; i < 12; i++) applyPlan(plan(`v${i}\n`), new Date(now.getTime() + i * 1000));
    const kept = readdirSync(dir).filter((f) => f.includes("agent-rewake-backup-"));
    expect(kept).toHaveLength(5);
    expect(readFileSync(file, "utf8")).toBe("v11\n");
  });
});
