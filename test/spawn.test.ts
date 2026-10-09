import { describe, expect, it } from "vitest";
import { launchCommand, selfCommand } from "../src/install.js";
import {
  findOnWindows,
  killPidTree,
  killTree,
  npmScript,
  resolveCommand,
  type SpawnHost,
} from "../src/util/spawn.js";
import { unpackers } from "../src/wrap.js";
import { canSymlink } from "./support.js";

// A Windows machine, simulated: files by path, so every rule runs on every OS
//.
function windows(files: Record<string, string>): SpawnHost {
  const lower = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    platform: "win32",
    exists: (p) => lower.has(p.toLowerCase()),
    read: (p) => {
      const v = lower.get(p.toLowerCase());
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    execPath: "C:\\Program Files\\nodejs\\node.exe",
  };
}
const env = { Path: "C:\\Tools;C:\\Program Files\\nodejs", PATHEXT: ".COM;.EXE;.BAT;.CMD" };

// What npm's cmd-shim writes for a globally installed package.
const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@google\\gemini-cli\\dist\\index.js" %*
`;
// Node's own npx.cmd.
const NODE_NPX = `:: Created by npm, please don't edit manually.
@ECHO OFF
SETLOCAL
SET "NODE_EXE=%~dp0\\node.exe"
IF NOT EXIST "%NODE_EXE%" (
  SET "NODE_EXE=node"
)
SET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"
"%NODE_EXE%" "%NPX_CLI_JS%" %*
`;

describe("starting a program on Windows", () => {
  it("runs an .exe found on Path directly", () => {
    const host = windows({ "C:\\Tools\\opencode.exe": "" });
    expect(resolveCommand("opencode", ["acp"], env, host)).toEqual({
      command: "C:\\Tools\\opencode.exe",
      args: ["acp"],
    });
  });

  it("runs an npm .cmd shim as node + the JS file it points at: no shell", () => {
    const host = windows({
      "C:\\Tools\\gemini.cmd": NPM_SHIM,
      "C:\\Tools\\node_modules\\@google\\gemini-cli\\dist\\index.js": "",
    });
    expect(resolveCommand("gemini", ["--experimental-acp"], env, host)).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\Tools\\node_modules\\@google\\gemini-cli\\dist\\index.js", "--experimental-acp"],
    });
  });

  it("runs Node's own npx.cmd as node + npx-cli.js", () => {
    const host = windows({
      "C:\\Program Files\\nodejs\\npx.cmd": NODE_NPX,
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js": "",
    });
    const r = resolveCommand("npx", ["--yes", "some-agent@1.0.0"], env, host);
    expect(r.command).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(r.args).toEqual([
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js",
      "--yes",
      "some-agent@1.0.0",
    ]);
  });

  it("runs any other .cmd through cmd.exe with every argument quoted and escaped", () => {
    const host = windows({ "C:\\Tools\\agent.cmd": "@echo off\r\nagent.exe %*\r\n" });
    const r = resolveCommand(
      "agent",
      ["a b", 'say "hi" & exit', "100%"],
      { ...env, ComSpec: "C:\\Windows\\system32\\cmd.exe" },
      host,
    );
    expect(r.command).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(r.windowsVerbatimArguments).toBe(true);
    expect(r.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    // cmd's metacharacters are escaped with ^, so none of them runs as cmd syntax.
    expect(r.args[3]).toBe(
      '"C:\\Tools\\agent.cmd ^"a^ b^" ^"say^ \\^"hi\\^"^ ^&^ exit^" ^"100^%^""',
    );
  });

  it("finds commands by Path and PATHEXT case-insensitively, and leaves unknown ones alone", () => {
    const host = windows({ "C:\\Tools\\x.BAT": "" });
    expect(findOnWindows("x", env, host.exists)?.toLowerCase()).toBe("c:\\tools\\x.bat");
    expect(resolveCommand("nothing-here", ["a"], env, host)).toEqual({
      command: "nothing-here",
      args: ["a"],
    });
  });

  it("changes nothing on macOS and Linux", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const host = { ...windows({}), platform };
      expect(resolveCommand("npx", ["x"], env, host)).toEqual({ command: "npx", args: ["x"] });
    }
  });
});

describe("stopping a process and what it started", () => {
  const fakeChild = () => {
    const signals: (NodeJS.Signals | undefined)[] = [];
    const kill = (s?: NodeJS.Signals) => {
      signals.push(s);
      return true;
    };
    return { signals, child: { pid: 4321, kill } };
  };
  /** A taskkill that records its arguments and exits with `status`. */
  const recorder =
    (calls: string[][], status = 0) =>
    (args: string[]) => {
      calls.push(args);
      return status;
    };

  it("on Windows, ends the whole tree with taskkill /T", () => {
    const calls: string[][] = [];
    const { child, signals } = fakeChild();
    killTree(child, "win32", "SIGTERM", recorder(calls));
    expect(calls).toEqual([["/pid", "4321", "/T", "/F"]]);
    expect(signals).toEqual([]);
  });

  it("on Windows, falls back to the child's own kill when taskkill fails", () => {
    const { child, signals } = fakeChild();
    killTree(child, "win32", "SIGTERM", () => 128);
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("on macOS and Linux, signals the child as before", () => {
    const calls: string[][] = [];
    const { child, signals } = fakeChild();
    killTree(child, "darwin", "SIGTERM", recorder(calls));
    expect(calls).toEqual([]);
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("stops a process known only by its id the same way, and ignores one already gone", () => {
    const calls: string[][] = [];
    killPidTree(4321, "win32", recorder(calls));
    expect(calls).toEqual([["/pid", "4321", "/T", "/F"]]);
    // No such process: nothing thrown.
    expect(() => killPidTree(2 ** 30, "linux")).not.toThrow();
  });
});

describe("npm and npx without shims", () => {
  it("finds npm's scripts next to Node on each OS layout", () => {
    expect(
      npmScript("npx-cli.js", "/usr/local/bin/node", (p) => p.endsWith("npx-cli.js"), "linux"),
    ).toBe("/usr/local/lib/node_modules/npm/bin/npx-cli.js");
    expect(
      npmScript(
        "npm-cli.js",
        "C:\\Program Files\\nodejs\\node.exe",
        (p) => p === "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
        "win32",
      ),
    ).toBe("C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js");
  });

  it("launches Rewake from npx's cache as node + npx-cli.js, and its tool server as itself", () => {
    const cached = "/home/me/.npm/_npx/abc/node_modules/.bin/agent-rewake";
    const npx = launchCommand("/usr/bin/node", cached, "/usr/lib/node_modules/npm/bin/npx-cli.js");
    expect(npx.command).toBe("/usr/bin/node");
    expect(npx.args.slice(0, 2)).toEqual(["/usr/lib/node_modules/npm/bin/npx-cli.js", "--yes"]);
    expect(selfCommand("/usr/bin/node", "/opt/rewake/agent-rewake.js")).toEqual({
      command: "/usr/bin/node",
      args: ["/opt/rewake/agent-rewake.js"],
    });
  });
});

describe("unpacking agents' archives", () => {
  it("uses Windows' own tar.exe by full path, never Git's GNU tar", () => {
    const [[command, args] = ["", []]] = unpackers("zip", "a.zip", "out", "win32", {
      SystemRoot: "C:\\Windows",
    });
    expect(command).toBe("C:\\Windows\\System32\\tar.exe");
    expect(args).toEqual(["-xf", "a.zip", "-C", "out"]);
  });

  it("on Linux tries unzip, bsdtar, tar, then Python for zip files", () => {
    expect(unpackers("zip", "a.zip", "out", "linux").map(([c]) => c)).toEqual([
      "unzip",
      "bsdtar",
      "tar",
      "python3",
    ]);
    expect(unpackers("gz", "a.tgz", "out", "linux")).toEqual([
      ["tar", ["-xzf", "a.tgz", "-C", "out"]],
    ]);
  });
});

describe("the Node path written into Zed's settings", () => {
  it.skipIf(!canSymlink)(
    "prefers a stable name on PATH for the same binary, else this process's own",
    async () => {
      const { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync, rmSync } =
        await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { stableNode } = await import("../src/install.js");
      const root = realpathSync(mkdtempSync(join(tmpdir(), "rewake-node-")));
      const cellar = join(root, "Cellar", "node", "24.1.0", "bin");
      const bin = join(root, "bin");
      mkdirSync(cellar, { recursive: true });
      mkdirSync(bin);
      writeFileSync(join(cellar, "node"), "");
      symlinkSync(join(cellar, "node"), join(bin, "node"));
      expect(stableNode(join(cellar, "node"), { PATH: bin }, "darwin")).toBe(join(bin, "node"));
      expect(stableNode(join(cellar, "node"), { PATH: root }, "darwin")).toBe(join(cellar, "node"));
      rmSync(root, { recursive: true, force: true });
    },
  );
});
