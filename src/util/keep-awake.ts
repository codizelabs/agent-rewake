import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { platform as osPlatform } from "node:os";
import { join } from "node:path";
import type { KeepAwake } from "../core/settings.js";

const CAFFEINATE = "/usr/bin/caffeinate";
const SYSTEMD_INHIBIT = ["/usr/bin/systemd-inhibit", "/bin/systemd-inhibit"];

/** Windows PowerShell is part of Windows; this is where it lives. */
const windowsPowerShell = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/** What Rewake needs from a keep-awake hold (so tests can pass their own). */
export interface Wake {
  readonly supported: boolean;
  /** Hold or release, as `want` and the setting say. Returns whether a hold is active. */
  set(want: boolean, mode: KeepAwake): boolean;
  release(): void;
}

/** The program and arguments that hold the computer awake until process `pid` ends. */
export function holdCommand(
  platform: NodeJS.Platform,
  mode: KeepAwake,
  pid: number,
  program?: string,
): { program: string; args: string[] } | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (platform === "darwin")
    return {
      program: program ?? CAFFEINATE,
      args: [mode === "always" ? "-i" : "-s", "-w", String(pid)],
    };
  if (platform === "linux")
    return {
      program: program ?? SYSTEMD_INHIBIT.find((p) => existsSync(p)) ?? SYSTEMD_INHIBIT[0] ?? "",
      args: [
        // Idle only: that is what is promised (the computer not idling to sleep), and what an ordinary
        // user session is allowed to block. Closing the lid or choosing Sleep still sleeps.
        "--what=idle",
        "--who=Agent Rewake",
        "--why=A planned resume is due",
        "--mode=block",
        "sh",
        "-c",
        // Until the process that asked has ended: the hold then ends with it, even after a crash.
        'while kill -0 "$0" 2>/dev/null; do sleep 5; done',
        String(pid),
      ],
    };
  if (platform === "win32")
    return {
      program: program ?? windowsPowerShell(),
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held for as long as this PowerShell runs.
        `$t = Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);' -Name W -Namespace R -PassThru; $null = $t::SetThreadExecutionState(0x80000001); while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 5 }`,
      ],
    };
  return undefined;
}

/**
 * Whether the computer runs on mains power (or has no battery, like a desktop). Unknown counts
 * as mains: "plugged-in" must not silently do nothing on a machine that can't say.
 */
export function onMains(
  platform: NodeJS.Platform,
  read: {
    sys?: string;
    windows?: () => string;
  } = {},
): boolean {
  if (platform === "linux") {
    const root = read.sys ?? "/sys/class/power_supply";
    try {
      const supplies = readdirSync(root);
      const kinds = supplies.map((n) => {
        const type = readFileSync(join(root, n, "type"), "utf8").trim();
        const online = existsSync(join(root, n, "online"))
          ? readFileSync(join(root, n, "online"), "utf8").trim()
          : "";
        return { type, online };
      });
      const hasBattery = kinds.some((k) => k.type === "Battery");
      if (!hasBattery) return true;
      return kinds.some((k) => k.type === "Mains" && k.online === "1");
    } catch {
      return true;
    }
  }
  if (platform === "win32") {
    // Win32_Battery.BatteryStatus: 2 is "AC", and no battery at all is a desktop.
    const out =
      read.windows?.() ??
      spawnSync(
        windowsPowerShell(),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$b = Get-CimInstance Win32_Battery; if ($b) { $b.BatteryStatus } else { 'none' }",
        ],
        { encoding: "utf8", timeout: 8000, windowsHide: true },
      ).stdout ??
      "";
    const text = String(out).trim();
    if (text === "" || text === "none") return true;
    return text
      .split(/\s+/)
      .some((n) => n === "2" || n === "6" || n === "7" || n === "8" || n === "9");
  }
  return true;
}

/**
 * Keeps this computer from idling to sleep while Rewake has a message to send, with the system's
 * own tool, tied to this process so the hold ends with it, even after a crash:
 *
 * - macOS: `caffeinate -w <pid>` (`-s`, honoured only on mains power, or `-i` for "always").
 * - Linux: `systemd-inhibit --what=idle` around a loop that ends with the process.
 * - Windows: a hidden PowerShell holding `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`.
 *
 * "plugged-in" holds only on mains power on every system. Closing the lid still puts the computer
 * to sleep, and none of this wakes a computer that is already asleep.
 */
export class Wakefulness implements Wake {
  private child: ChildProcess | undefined;
  private mode: KeepAwake | undefined;
  private readonly program: string | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly pid: number;
  private readonly mains: () => boolean;

  constructor(
    opts: {
      program?: string;
      platform?: NodeJS.Platform;
      pid?: number;
      /** Tests: how to tell mains power from battery. */
      mains?: () => boolean;
    } = {},
  ) {
    this.program = opts.program;
    this.platform = opts.platform ?? osPlatform();
    this.pid = opts.pid ?? process.pid;
    this.mains = opts.mains ?? (() => onMains(this.platform));
  }

  get supported(): boolean {
    const cmd = holdCommand(this.platform, "always", this.pid, this.program);
    if (!cmd) return false;
    return this.platform === "win32" && !this.program ? true : existsSync(cmd.program);
  }

  get holding(): boolean {
    return (
      this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null
    );
  }

  /** Hold or release, as `want` and the setting say. Returns whether a hold is active. */
  set(want: boolean, mode: KeepAwake): boolean {
    if (!want || mode === "never" || !this.supported) {
      this.release();
      return false;
    }
    // macOS's `-s` already means "mains only"; elsewhere Rewake looks itself.
    if (mode === "plugged-in" && this.platform !== "darwin" && !this.mains()) {
      this.release();
      return false;
    }
    if (this.holding && this.mode === mode) return true;
    this.release();
    const cmd = holdCommand(this.platform, mode, this.pid, this.program);
    if (!cmd) return false;
    try {
      const child = spawn(cmd.program, cmd.args, { stdio: "ignore", windowsHide: true });
      child.on("error", () => {
        if (this.child === child) this.child = undefined;
      });
      // Never keeps Rewake itself running.
      child.unref();
      this.child = child;
      this.mode = mode;
      return true;
    } catch {
      return false;
    }
  }

  release(): void {
    const child = this.child;
    this.child = undefined;
    this.mode = undefined;
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
  }
}
