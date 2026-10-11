import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";

/** Where the docs explain the best sleep settings for each system. */
export const SLEEP_DOCS_URL = "https://rewake.js.org/docs/#keep-your-computer-awake";

/**
 * This computer's own sleep settings, as far as they can be read without admin rights. Anything
 * that can't be read is left out: Rewake never guesses, and never changes these settings.
 */
export interface SleepSettings {
  os: "macos" | "windows" | "linux" | "other";
  /** Minutes of inactivity before the computer sleeps when plugged in: 0 is never. */
  pluggedInSleepMin?: number;
  /** The same on battery. */
  batterySleepMin?: number;
  /** Running on battery right now (macOS). */
  onBattery?: boolean;
  /** What closing the lid does when plugged in (Windows, Linux). */
  lid?: "sleep" | "nothing" | "other";
  /** The organisation sets the sleep timeout (Windows policy). */
  managed?: boolean;
  /** Which settings were read on Linux. */
  desktop?: "gnome" | "kde" | "logind";
}

export type Run = (command: string, args: string[]) => { status: number | null; stdout: string };

const run: Run = (command, args) => {
  const r = spawnSync(command, args, { encoding: "utf8", timeout: 3000, windowsHide: true });
  return {
    status: r.error ? null : r.status,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
  };
};

/** Read the settings. Each command is bounded (3 s) and its failure only leaves a value out. */
export function readSleepSettings(
  o: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
    run?: Run;
    readFile?: (path: string) => string | undefined;
  } = {},
): SleepSettings {
  const p = o.platform ?? osPlatform();
  const exec = o.run ?? run;
  const read =
    o.readFile ??
    ((path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    });
  if (p === "darwin") {
    const custom = exec("/usr/bin/pmset", ["-g", "custom"]);
    const batt = exec("/usr/bin/pmset", ["-g", "batt"]);
    return {
      os: "macos",
      ...(custom.status === 0 ? macSleep(custom.stdout) : {}),
      ...(batt.status === 0 ? macSource(batt.stdout) : {}),
    };
  }
  if (p === "win32") return { os: "windows", ...windowsSleep(exec) };
  if (p === "linux")
    return { os: "linux", ...linuxSleep(exec, o.env ?? process.env, o.home ?? homedir(), read) };
  return { os: "other" };
}

/** `pmset -g custom`: "AC Power:" and "Battery Power:" sections, each `key value` per line. */
export function parsePmset(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section: Record<string, string> | undefined;
  for (const line of text.split("\n")) {
    const head = /^(AC|Battery|UPS) Power:\s*$/.exec(line);
    if (head?.[1]) {
      section = {};
      out[head[1]] = section;
      continue;
    }
    // Keys can contain spaces ("Sleep On Power Button"); a "(sleep prevented by …)" tail is dropped.
    const kv = /^\s+(.+?)\s+(\S+)\s*(?:\(.*\))?\s*$/.exec(line);
    if (section && kv?.[1] && kv[2] !== undefined) section[kv[1]] = kv[2];
  }
  return out;
}

function macSleep(text: string): Partial<SleepSettings> {
  const s = parsePmset(text);
  const minutes = (v: string | undefined) =>
    v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
  const ac = minutes(s.AC?.sleep);
  const battery = minutes(s.Battery?.sleep);
  return {
    ...(ac !== undefined && { pluggedInSleepMin: ac }),
    ...(battery !== undefined && { batterySleepMin: battery }),
  };
}

function macSource(text: string): Partial<SleepSettings> {
  const m = /Now drawing from '(AC|Battery|UPS) Power'/.exec(text);
  return m ? { onBattery: m[1] === "Battery" } : {};
}

const SUB_SLEEP = "238c9fa8-0aad-41ed-83f4-97be242c8f20";
const STANDBYIDLE = "29f6c1db-86da-48c5-9fdb-f2b67b1f44da";
const SUB_BUTTONS = "4f971e89-eebd-4455-a8de-9e59040e7347";
const LIDACTION = "5ca83367-6e45-459f-a27b-476b1d01c936";

/**
 * `powercfg /query`'s AC and DC values: its labels are in the system's language, so only the last
 * two hexadecimal numbers are read (AC first, then DC).
 */
export function parsePowercfg(text: string): [number, number] | undefined {
  const hex = [...text.matchAll(/0x([0-9a-fA-F]{1,8})\b/g)].map((m) =>
    Number.parseInt(m[1] ?? "", 16),
  );
  if (hex.length < 2) return undefined;
  return [hex[hex.length - 2] as number, hex[hex.length - 1] as number];
}

function windowsSleep(exec: Run): Partial<SleepSettings> {
  const out: Partial<SleepSettings> = {};
  const sleep = exec("powercfg", ["/query", "SCHEME_CURRENT", SUB_SLEEP, STANDBYIDLE]);
  const s = sleep.status === 0 ? parsePowercfg(sleep.stdout) : undefined;
  if (s) {
    out.pluggedInSleepMin = Math.ceil(s[0] / 60);
    out.batterySleepMin = Math.ceil(s[1] / 60);
  }
  const lid = exec("powercfg", ["/query", "SCHEME_CURRENT", SUB_BUTTONS, LIDACTION]);
  const l = lid.status === 0 ? parsePowercfg(lid.stdout) : undefined;
  if (l) out.lid = l[0] === 0 ? "nothing" : l[0] === 1 ? "sleep" : "other";
  const policy = exec("reg", [
    "query",
    `HKLM\\SOFTWARE\\Policies\\Microsoft\\Power\\PowerSettings\\${STANDBYIDLE.toUpperCase()}`,
  ]);
  if (policy.status === 0) out.managed = true;
  return out;
}

function linuxSleep(
  exec: Run,
  env: NodeJS.ProcessEnv,
  home: string,
  read: (path: string) => string | undefined,
): Partial<SleepSettings> {
  const desktops = (env.XDG_CURRENT_DESKTOP ?? "").toLowerCase().split(":");
  const out: Partial<SleepSettings> = {};
  if (desktops.includes("gnome")) {
    const g = (key: string) =>
      exec("gsettings", ["get", "org.gnome.settings-daemon.plugins.power", key]);
    const type = g("sleep-inactive-ac-type");
    const timeout = g("sleep-inactive-ac-timeout");
    if (type.status === 0 && timeout.status === 0) {
      const kind = type.stdout.trim().replace(/^'|'$/g, "");
      const seconds = Number(/(\d+)\s*$/.exec(timeout.stdout.trim())?.[1]);
      out.desktop = "gnome";
      if (Number.isFinite(seconds))
        out.pluggedInSleepMin =
          kind === "nothing" || kind === "blank" ? 0 : Math.ceil(seconds / 60);
    }
  } else if (desktops.includes("kde")) {
    const rc = read(join(env.XDG_CONFIG_HOME || join(home, ".config"), "powerdevilrc"));
    out.desktop = "kde";
    const group = /\[AC\]\[SuspendAndShutdown\]([\s\S]*?)(?:\n\[|$)/.exec(rc ?? "")?.[1] ?? "";
    const key = (k: string) => new RegExp(`^${k}=(\\S+)`, "m").exec(group)?.[1];
    // A missing key is Plasma's default: suspend (1) after 900 s.
    const action = Number(key("AutoSuspendAction") ?? 1);
    const seconds = Number(key("AutoSuspendIdleTimeoutSec") ?? 900);
    out.pluggedInSleepMin =
      [1, 2, 8, 16].includes(action) && seconds > 0 ? Math.ceil(seconds / 60) : 0;
    const lid = key("LidAction");
    if (lid !== undefined) out.lid = lid === "0" ? "nothing" : lid === "1" ? "sleep" : "other";
  }
  const bus = (prop: string) =>
    exec("busctl", [
      "get-property",
      "org.freedesktop.login1",
      "/org/freedesktop/login1",
      "org.freedesktop.login1.Manager",
      prop,
    ]);
  const idle = bus("IdleAction");
  if (out.pluggedInSleepMin === undefined && idle.status === 0) {
    const action = /"([^"]*)"/.exec(idle.stdout)?.[1];
    const usec = Number(/(\d+)\s*$/.exec(bus("IdleActionUSec").stdout.trim())?.[1]);
    out.desktop = "logind";
    if (action === "ignore" || action === "lock") out.pluggedInSleepMin = 0;
    else if (action && Number.isFinite(usec)) out.pluggedInSleepMin = Math.ceil(usec / 60_000_000);
  }
  if (out.lid === undefined) {
    const lid = bus("HandleLidSwitchExternalPower");
    const action = lid.status === 0 ? /"([^"]*)"/.exec(lid.stdout)?.[1] : undefined;
    if (action)
      out.lid = action === "ignore" ? "nothing" : action === "suspend" ? "sleep" : "other";
  }
  return out;
}

/**
 * What in these settings would let the computer sleep while a resume waits, in plain words, given
 * whether Rewake can hold it awake itself (macOS, and how: while plugged in or always). Closing the
 * lid is left out: it sleeps almost every laptop, and `doctor` mentions it on its own.
 */
export function sleepRisks(s: SleepSettings, hold: "plugged-in" | "always" | "none"): string[] {
  const risks: string[] = [];
  const after = (m: number) => `after ${m} minute${m === 1 ? "" : "s"}`;
  if (s.pluggedInSleepMin !== undefined && s.pluggedInSleepMin > 0 && hold === "none")
    risks.push(`it's set to sleep ${after(s.pluggedInSleepMin)} when plugged in`);
  if (
    s.onBattery === true &&
    s.batterySleepMin !== undefined &&
    s.batterySleepMin > 0 &&
    hold !== "always"
  )
    risks.push(`it's on battery and set to sleep ${after(s.batterySleepMin)}`);
  return risks;
}
