import { spawnSync } from "node:child_process";
import {
  existsSync,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { registerHost, ScheduleStore } from "../src/core/store.js";
import { ThreadStore } from "../src/core/threads.js";
import {
  COMMAND_NAMES,
  COMMAND_WORDS,
  COMMANDS,
  commandHelp,
  completionScript,
  INTERNAL,
  PLACES,
} from "../src/help.js";
import { readInstalled } from "../src/util/installed.js";
import { VERSION } from "../src/version.js";

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-cli-"));
  mkdirSync(join(dir, "zed"));
  mkdirSync(join(dir, "home"));
  env = {
    AGENT_REWAKE_ZED_CONFIG_DIR: join(dir, "zed"),
    AGENT_REWAKE_ZED_DATA_DIR: join(dir, "data"),
    AGENT_REWAKE_STATE_DIR: join(dir, "state"),
    HOME: dir,
    USERPROFILE: dir,
    PATH: process.env.PATH ?? "",
  };
  // Nothing here may touch the real home folder.
  vi.stubEnv("HOME", dir);
  vi.stubEnv("USERPROFILE", dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** Run the command line in-process, capturing what it prints. */
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    out.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    err.push(String(c));
    return true;
  });
  const code = await main(argv, env);
  vi.restoreAllMocks();
  return { code, out: out.join(""), err: err.join("") };
}

describe("<command> --help (G65)", () => {
  it("every command answers --help with its own usage, and nothing is run or changed", async () => {
    for (const c of COMMANDS) {
      for (const flag of ["--help", "-h"]) {
        const r = await run([c.name, flag]);
        expect(r.code, `${c.name} ${flag}`).toBe(0);
        expect(r.out.startsWith(`Usage: agent-rewake ${c.name}`), c.name).toBe(true);
        expect(r.err).toBe("");
      }
    }
    // Nothing was written: no state folder, no launcher, no schedules.
    expect(existsSync(join(dir, "state"))).toBe(false);
  });

  it("install --help no longer fails, and doctor --help no longer runs doctor", async () => {
    const install = await run(["install", "--help"]);
    expect(install.code).toBe(0);
    expect(install.err).not.toContain("unknown option");
    expect(install.out).toContain("--only");
    expect(install.out).toContain("--dry-run");
    const doctor = await run(["doctor", "--help"]);
    expect(doctor.out).not.toContain("checking your setup");
    expect(doctor.out).toContain("--json");
    expect(doctor.out).toContain("--report");
  });

  it("names cursor among the places, and uninstall's --only, --all and --skip", async () => {
    expect((await run(["install", "--help"])).out).toContain("cursor");
    const un = (await run(["uninstall", "--help"])).out;
    for (const flag of ["--only", "--all", "--skip", "--yes", "--dry-run"])
      expect(un).toContain(flag);
    expect(un).toContain("cursor");
    expect([...PLACES]).toContain("cursor");
  });

  it("`help <command>` is the same text; an unknown name is an error", async () => {
    expect((await run(["help", "history"])).out).toBe((await run(["history", "--help"])).out);
    const bad = await run(["help", "nope"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('no command named "nope"');
  });

  it("the main help groups what you run, and keeps what Rewake runs for --help --all", async () => {
    const top = (await run(["--help"])).out;
    expect(top).toContain("Commands you run:");
    for (const name of COMMAND_NAMES) expect(top).toContain(name);
    for (const hidden of [
      "--wrap-registry",
      "--wrap-command",
      "fire <id>",
      "sweep",
      "hook <agent>",
    ])
      expect(top, hidden).not.toContain(hidden);
    const all = (await run(["--help", "--all"])).out;
    expect(all).toContain("Commands Rewake runs itself");
    for (const i of INTERNAL) expect(all).toContain(i.usage);
  });

  it("every command the dispatcher knows is in the help table", () => {
    const source = readFileSync(join(import.meta.dirname, "../src/cli.ts"), "utf8");
    const dispatched = new Set(
      [...source.matchAll(/\bfirst === "([a-z]+)"/g)].map((m) => m[1] as string),
    );
    const known = new Set([...COMMAND_NAMES, ...INTERNAL.map((i) => i.usage.split(" ")[0] ?? "")]);
    for (const name of dispatched) expect(known.has(name), name).toBe(true);
    for (const name of COMMAND_NAMES) expect(commandHelp(name), name).toBeDefined();
    expect([...COMMAND_WORDS]).toEqual(COMMAND_NAMES);
  });

  it("the schedules page's help names the plain-text command", () => {
    const page = readFileSync(join(import.meta.dirname, "../src/ui/page.ts"), "utf8");
    expect(page).toContain('"# Without this page (a screen reader, or plain text)"');
    expect(page).toContain('rewake("schedules")');
    expect(commandHelp("ui")).toContain("agent-rewake schedules");
  });
});

describe("completion (G65)", () => {
  it("prints a script per shell that knows every command and the places", async () => {
    for (const shell of ["bash", "zsh", "fish"]) {
      const r = await run(["completion", shell]);
      expect(r.code, shell).toBe(0);
      for (const name of COMMAND_NAMES) expect(r.out, `${shell} ${name}`).toContain(name);
      for (const place of PLACES) expect(r.out, `${shell} ${place}`).toContain(place);
      expect(r.out).toContain("agent-rewake");
    }
    expect(existsSync(join(dir, "state"))).toBe(false);
  });

  it("is the same text the function builds, and a bad shell is an error", async () => {
    expect((await run(["completion", "bash"])).out).toBe(completionScript("bash"));
    for (const argv of [["completion"], ["completion", "powershell"]]) {
      const r = await run(argv);
      expect(r.code).toBe(2);
      expect(r.err).toContain("completion <bash|zsh|fish>");
    }
  });

  it("the bash script is valid bash and completes commands, flags and places", () => {
    const script = join(dir, "c.bash");
    writeFileSync(script, completionScript("bash"));
    const syntax = spawnSync("bash", ["-n", script]);
    if (syntax.error) return; // no bash here (Windows)
    expect(syntax.status).toBe(0);
    const driver = join(dir, "drive.bash");
    writeFileSync(
      driver,
      `source "${script}"
t() { COMP_WORDS=("$@"); COMP_CWORD=$(( $# - 1 )); COMPREPLY=(); _agent_rewake; echo "\${COMPREPLY[*]}"; }
t agent-rewake hi
t agent-rewake install --sk
t agent-rewake uninstall --only cu
`,
    );
    const out = spawnSync("bash", [driver], { encoding: "utf8" }).stdout.trim().split("\n");
    expect(out).toEqual(["history", "--skip", "cursor"]);
  });
});

describe("doctor --json and --report (G65, G67)", () => {
  it("--json prints findings as JSON and the exit status still says if there's a problem", async () => {
    writeFileSync(join(dir, "zed", "settings.json"), JSON.stringify({ disable_ai: true }));
    const r = await run(["doctor", "--json"]);
    const parsed = JSON.parse(r.out) as { version: string; findings: { level: string }[] };
    expect(parsed.version).toBe(VERSION);
    expect(parsed.findings.some((f) => f.level === "problem")).toBe(true);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain(dir);
  });

  it("rejects options it doesn't know, and --json with --report", async () => {
    const bad = await run(["doctor", "--jsno"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("unknown option for doctor: --jsno");
    expect((await run(["doctor", "--json", "--report"])).code).toBe(2);
  });

  it("--report writes one redacted file, prints the issue link, and sends nothing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    registerHost("codex");
    const store = new ScheduleStore(join(dir, "state"));
    const made = store.create({
      sessionId: "019f3a2c-aaaa-bbbb-cccc-0123456789ab",
      cwd: join(dir, "home", "client-project"),
      text: "PRIVATE message text",
      dueAt: Date.now() + 3_600_000,
      kind: "limit_resume",
      createdBy: "auto",
      now: Date.now(),
    });
    store.put({ ...made, host: "codex", sessionRef: { threadId: "x" } });
    mkdirSync(join(dir, "state", "logs"), { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    writeFileSync(
      join(dir, "state", "logs", `rewake-${day}.jsonl`),
      `${[
        {
          t: new Date().toISOString(),
          level: "error",
          event: "agent.resolve_failed",
          agent: "codex-acp",
          message: `ENOENT ${join(dir, "home", ".secret-place")}`,
        },
        {
          t: new Date().toISOString(),
          level: "info",
          event: "fire.decide",
          host: "codex",
          action: "wait",
          why: "still-limited",
        },
        { t: new Date().toISOString(), level: "info", event: "menu.action" },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n")}\n`,
    );
    const r = await run(["doctor", "--report"]);
    expect(r.out).toContain("https://github.com/codizelabs/agent-rewake/issues/new/choose");
    expect(r.out).toContain("nothing has been sent");
    const reports = readdirSync(join(dir, "state", "reports"));
    expect(reports).toHaveLength(1);
    const file = join(dir, "state", "reports", reports[0] ?? "");
    const text = readFileSync(file, "utf8");
    expect(text).toContain("== Warnings and errors, last 14 days ==");
    expect(text).toContain("error agent.resolve_failed agent=codex-acp");
    expect(text.replaceAll("\\", "/")).toContain("ENOENT ~/home/.secret-place");
    expect(text).toContain("fire.decide host=codex action=wait why=still-limited");
    expect(text).not.toContain("menu.action");
    expect(text).toContain("Planned resumes outside Zed on file: 1");
    for (const secret of [dir, "PRIVATE", "019f3a2c-aaaa", "client-project"])
      expect(text, secret).not.toContain(secret);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
    expect(r.out).not.toContain(dir);
    // No network: nothing fetched.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("history and schedules --all (G66)", () => {
  it("history lists what happened, newest first, and checks --days", async () => {
    const state = join(dir, "state");
    new ThreadStore(state).update(
      "t1",
      join(dir, "work", "api"),
      { agentName: "Claude Agent" },
      Date.now(),
    );
    const store = new ScheduleStore(state);
    const s = store.create({
      sessionId: "t1",
      cwd: join(dir, "work", "api"),
      text: "PRIVATE",
      dueAt: Date.now() - 3600_000,
      createdBy: "command",
      now: Date.now() - 7200_000,
    });
    store.put({
      ...s,
      status: "stopped",
      failureReason: "typed",
      updatedAt: Date.now() - 3000_000,
    });
    const r = await run(["history", "--days", "3"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("The last 3 days, newest first:");
    expect(r.out).toContain(
      'Claude Agent in the "api" folder · Message: Cancelled: you typed in the session first',
    );
    expect(r.out).toContain(String(new Date().getFullYear()));
    expect(r.out).not.toContain("PRIVATE");
    for (const bad of ["0", "abc", "9999"]) {
      const b = await run(["history", "--days", bad]);
      expect(b.code, bad).toBe(2);
      expect(b.err).toContain("--days takes a whole number");
    }
    expect((await run(["history", "--day", "3"])).code).toBe(2);
  });

  it("schedules --all names the agent and lists newest first with the year", async () => {
    const state = join(dir, "state");
    new ThreadStore(state).update("t1", "/work/api", { agentName: "Codex" }, Date.now());
    const store = new ScheduleStore(state);
    for (const [text, at] of [
      ["older one", Date.now() - 5 * 86_400_000],
      ["newer one", Date.now() - 86_400_000],
    ] as const) {
      const s = store.create({
        sessionId: "t1",
        cwd: "/work/api",
        text,
        dueAt: at,
        createdBy: "command",
        now: at - 1000,
      });
      store.put({ ...s, status: "sent" });
    }
    const r = await run(["schedules", "--all"]);
    expect(r.out).toContain("Codex · Thread t1");
    expect(r.out.indexOf("newer one")).toBeLessThan(r.out.indexOf("older one"));
    expect(r.out).toContain(String(new Date().getFullYear()));
    expect(r.out).toContain("· Sent ·");
  });
});

describe("installed N days ago comes from a local record (G70)", () => {
  it("install records the version once; a dry run and uninstall don't", async () => {
    const state = join(dir, "state");
    expect((await run(["install", "--yes", "--dry-run"])).code).toBe(0);
    expect(readInstalled(state)).toBeUndefined();
    expect((await run(["install", "--yes"])).code).toBe(0);
    const first = readInstalled(state);
    expect(first?.version).toBe(VERSION);
    expect(first?.at).toBeGreaterThan(Date.now() - 60_000);
    // Running it again keeps the first time.
    await new Promise((r) => setTimeout(r, 15));
    await run(["install", "--yes"]);
    expect(readInstalled(state)).toEqual(first);
  });
});
