import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform as osPlatform } from "node:os";
import type { KeepAwake } from "../core/settings.js";

const CAFFEINATE = "/usr/bin/caffeinate";

/** What Rewake needs from a keep-awake hold (so tests can pass their own). */
export interface Wake {
  readonly supported: boolean;
  /** Hold or release, as `want` and the setting say. Returns whether a hold is active. */
  set(want: boolean, mode: KeepAwake): boolean;
  release(): void;
}

/**
 * Keeps this computer from idling to sleep while Rewake has a message to send, with the system's
 * own tool. The hold is tied to this process (`caffeinate -w <pid>`), so it ends with it, even
 * after a crash. "plugged-in" uses `-s`, which macOS honours only on mains power; "always" uses
 * `-i`. Closing the lid still puts the computer to sleep.
 *
 * macOS only for now: Linux and Windows have equivalents that haven't been tried on real machines,
 * so `supported` is false there and nothing is started.
 */
export class Wakefulness implements Wake {
  private child: ChildProcess | undefined;
  private mode: KeepAwake | undefined;
  private readonly program: string;
  private readonly platform: NodeJS.Platform;
  private readonly pid: number;

  constructor(opts: { program?: string; platform?: NodeJS.Platform; pid?: number } = {}) {
    this.program = opts.program ?? CAFFEINATE;
    this.platform = opts.platform ?? osPlatform();
    this.pid = opts.pid ?? process.pid;
  }

  get supported(): boolean {
    return this.platform === "darwin" && existsSync(this.program);
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
    if (this.holding && this.mode === mode) return true;
    this.release();
    try {
      const child = spawn(this.program, [mode === "always" ? "-i" : "-s", "-w", String(this.pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
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
