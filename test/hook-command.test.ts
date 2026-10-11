import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hookCommand } from "../src/hosts/hook-command.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-hookcmd-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a hook's command text", () => {
  it("keeps the quoted program form for sh, bash and cmd.exe, byte for byte", () => {
    expect(
      hookCommand("/opt/my node/node", "/s/bin/agent-rewake.mjs", "hook grok SessionEnd", "posix"),
    ).toBe('"/opt/my node/node" "/s/bin/agent-rewake.mjs" hook grok SessionEnd');
  });

  it("uses PowerShell's call operator, with every kind of single quote doubled", () => {
    expect(
      hookCommand(
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\Users\\O’Neil's\\l.mjs",
        "hook x Stop",
        "powershell",
      ),
    ).toBe("& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\O’’Neil''s\\l.mjs' hook x Stop");
  });

  /** A stand-in launcher, in a folder named `name`, that writes the arguments it was given. */
  const launcher = (name: string) => {
    const folder = join(dir, name);
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "agent-rewake.mjs");
    writeFileSync(
      file,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));\n`,
    );
    return file;
  };
  const argv = () => JSON.parse(readFileSync(join(dir, "argv.json"), "utf8"));

  // How Gemini CLI runs a hook on Windows: `-Command "<command>; if ($LASTEXITCODE -ne 0) …"`.
  it.runIf(process.platform === "win32")(
    "runs under Windows PowerShell as Gemini CLI starts it",
    () => {
      const command = hookCommand(
        process.execPath,
        launcher("Ünï O'Neil $HOME"),
        "hook gemini-cli SessionStart",
        "powershell",
      );
      const r = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `${command}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
        ],
        { encoding: "utf8" },
      );
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(argv()).toEqual(["hook", "gemini-cli", "SessionStart"]);
    },
  );

  it.runIf(process.platform !== "win32")("runs under sh unchanged", () => {
    const command = hookCommand(
      process.execPath,
      launcher("Ünï O'Neil"),
      "hook grok SessionEnd",
      "posix",
    );
    const r = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(argv()).toEqual(["hook", "grok", "SessionEnd"]);
  });
});
