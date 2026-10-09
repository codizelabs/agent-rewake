import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { holdCommand, onMains, Wakefulness } from "../src/util/keep-awake.js";

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

describe("Wakefulness", () => {
  it("does nothing where it isn't supported, or when the setting says never", () => {
    const off = new Wakefulness({ platform: "linux", program: "/nonexistent/systemd-inhibit" });
    expect(off.supported).toBe(false);
    expect(off.set(true, "plugged-in")).toBe(false);
    const missing = new Wakefulness({ platform: "darwin", program: "/nonexistent/caffeinate" });
    expect(missing.supported).toBe(false);
    expect(missing.set(true, "always")).toBe(false);
  });

  it.runIf(process.platform === "darwin")(
    "holds with caffeinate tied to a process, lets go, and ends with that process",
    async () => {
      // A stand-in for Rewake, so the test never ties a hold to the test runner itself.
      const owner = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
      if (owner.pid === undefined) throw new Error("no stand-in process");
      const wake = new Wakefulness({ pid: owner.pid });
      expect(wake.supported).toBe(true);
      expect(wake.set(true, "never")).toBe(false);
      expect(wake.set(true, "always")).toBe(true);
      await settle();
      expect(wake.holding).toBe(true);
      // Same mode again: the same hold, not a second one.
      expect(wake.set(true, "always")).toBe(true);
      wake.release();
      await settle();
      expect(wake.holding).toBe(false);
      // Taken again, then the owner dies: caffeinate -w ends on its own.
      expect(wake.set(true, "plugged-in")).toBe(true);
      owner.kill("SIGKILL");
      await settle(2500);
      expect(wake.holding).toBe(false);
    },
    10_000,
  );
});

describe("how each system is told to hold", () => {
  it("builds the command for macOS, Linux and Windows, tied to the owner's process", () => {
    expect(holdCommand("darwin", "always", 42, "/usr/bin/caffeinate")).toEqual({
      program: "/usr/bin/caffeinate",
      args: ["-i", "-w", "42"],
    });
    expect(holdCommand("darwin", "plugged-in", 42, "c")?.args).toEqual(["-s", "-w", "42"]);
    const linux = holdCommand("linux", "always", 42, "/usr/bin/systemd-inhibit");
    expect(linux?.program).toBe("/usr/bin/systemd-inhibit");
    expect(linux?.args.slice(0, 4)).toEqual([
      "--what=idle",
      "--who=Agent Rewake",
      "--why=A planned resume is due",
      "--mode=block",
    ]);
    expect(linux?.args.at(-1)).toBe("42");
    expect(linux?.args.at(-2)).toContain("kill -0");
    const win = holdCommand("win32", "always", 42, "powershell.exe");
    expect(win?.args).toContain("Hidden");
    expect(win?.args.at(-1)).toContain("SetThreadExecutionState(0x80000001)");
    expect(win?.args.at(-1)).toContain("Get-Process -Id 42");
    expect(holdCommand("freebsd", "always", 42)).toBeUndefined();
    expect(holdCommand("linux", "always", 0)).toBeUndefined();
  });

  it("tells mains power from battery on Linux, and counts a desktop or an unknown as mains", () => {
    const sys = mkdtempSync(join(tmpdir(), "rewake-power-"));
    try {
      const supply = (name: string, type: string, online?: string) => {
        mkdirSync(join(sys, name));
        writeFileSync(join(sys, name, "type"), `${type}\n`);
        if (online !== undefined) writeFileSync(join(sys, name, "online"), `${online}\n`);
      };
      expect(onMains("linux", { sys })).toBe(true); // nothing listed: a desktop
      supply("BAT0", "Battery");
      supply("AC", "Mains", "0");
      expect(onMains("linux", { sys })).toBe(false); // a laptop on battery
      writeFileSync(join(sys, "AC", "online"), "1\n");
      expect(onMains("linux", { sys })).toBe(true);
      expect(onMains("linux", { sys: join(sys, "missing") })).toBe(true); // can't tell
    } finally {
      rmSync(sys, { recursive: true, force: true });
    }
  });

  it("reads Windows' battery status: AC or charging is mains, discharging is not, none is a desktop", () => {
    expect(onMains("win32", { windows: () => "none" })).toBe(true);
    expect(onMains("win32", { windows: () => "" })).toBe(true);
    expect(onMains("win32", { windows: () => "2" })).toBe(true);
    expect(onMains("win32", { windows: () => "1" })).toBe(false);
  });

  it("only holds on mains power when the setting says plugged-in (Linux, Windows)", () => {
    const wake = new Wakefulness({
      platform: "linux",
      program: process.execPath,
      mains: () => false,
    });
    expect(wake.set(true, "plugged-in")).toBe(false);
  });

  const inhibitWorks =
    process.platform === "linux" &&
    spawnSync("systemd-inhibit", ["--what=idle", "--mode=block", "true"], { timeout: 5000 })
      .status === 0;
  it.runIf(inhibitWorks)(
    "holds with systemd-inhibit until its owner ends (Linux)",
    async () => {
      const owner = spawn("sleep", ["30"], { stdio: "ignore" });
      if (owner.pid === undefined) throw new Error("no stand-in process");
      const wake = new Wakefulness({ pid: owner.pid, mains: () => true });
      expect(wake.set(true, "always")).toBe(true);
      await settle();
      expect(wake.holding).toBe(true);
      wake.release();
      await settle();
      expect(wake.holding).toBe(false);
      owner.kill("SIGKILL");
    },
    15_000,
  );

  it.runIf(process.platform === "win32")(
    "holds with PowerShell until released (Windows)",
    async () => {
      const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        stdio: "ignore",
      });
      if (owner.pid === undefined) throw new Error("no stand-in process");
      const wake = new Wakefulness({ pid: owner.pid, mains: () => true });
      expect(wake.supported).toBe(true);
      expect(wake.set(true, "always")).toBe(true);
      await settle(1500);
      expect(wake.holding).toBe(true);
      wake.release();
      await settle(1000);
      expect(wake.holding).toBe(false);
      owner.kill();
    },
    30_000,
  );
});

/** The Claude Code plugin keeps its own copy of the hold commands (mod/hooks/logic.js). */
const modPath = "../src/hosts/claude-code/mod/hooks/logic.js";
const mod = (await import(modPath)) as {
  holdArgv: (kind: string, mode: string, pid: string, program: string) => string[];
  mainsFrom: (kind: string, out: string) => boolean;
  parseWake: (out: string) => { kind: string; pid: string; program: string } | undefined;
  WINDOWS_POWERSHELL: string;
  WINDOWS_MAINS: string;
};

describe("the Claude Code plugin's hold", () => {
  it("runs the same commands as Rewake's own", () => {
    const cases = [
      ["darwin", "/usr/bin/caffeinate"],
      ["linux", "/usr/bin/systemd-inhibit"],
      ["win32", mod.WINDOWS_POWERSHELL],
    ] as const;
    for (const mode of ["plugged-in", "always"] as const) {
      for (const [kind, program] of cases) {
        const own = holdCommand(kind, mode, 4242, program);
        expect([own?.program, ...(own?.args ?? [])]).toEqual(
          mod.holdArgv(kind, mode, "4242", program),
        );
      }
    }
  });

  it("reads Windows power the way Rewake does, and asks the same question", () => {
    for (const out of ["", "none", "1", "2", "6", "7", "8", "9", "1 2", "3"]) {
      expect(mod.mainsFrom("win32", out)).toBe(onMains("win32", { windows: () => out }));
    }
    expect(mod.WINDOWS_MAINS).toContain("Get-CimInstance Win32_Battery");
  });

  it("holds only where the computer has a hold program", () => {
    expect(mod.parseWake("4242\nDarwin\n/usr/bin/caffeinate\n")?.kind).toBe("darwin");
    expect(mod.parseWake("4242\nLinux\n/bin/systemd-inhibit\n")?.kind).toBe("linux");
    expect(mod.parseWake("4242\nLinux\n")).toBeUndefined();
    expect(mod.parseWake("4242\nDarwin\n")).toBeUndefined();
    expect(mod.parseWake("x\nLinux\n/usr/bin/systemd-inhibit\n")).toBeUndefined();
  });
});
