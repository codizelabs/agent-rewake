import { describe, expect, it } from "vitest";
import { sleepFindings } from "../src/doctor.js";
import {
  parsePmset,
  parsePowercfg,
  type Run,
  readSleepSettings,
  sleepRisks,
} from "../src/util/sleep-settings.js";

// Command outputs as each system prints them (macOS: a real run; the others: their documented shapes).
const PMSET_CUSTOM = `Battery Power:
 Sleep On Power Button 1
 powermode            1
 displaysleep         20
 sleep                5
 disksleep            10
AC Power:
 Sleep On Power Button 1
 powermode            2
 displaysleep         180
 sleep                0 (sleep prevented by zed, powerd)
 disksleep            10
`;
const PMSET_BATT = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging";
const POWERCFG = (
  ac: number,
  dc: number,
) => `Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)
  Subgroup GUID: 238c9fa8-0aad-41ed-83f4-97be242c8f20  (Sleep)
    Power Setting GUID: 29f6c1db-86da-48c5-9fdb-f2b67b1f44da  (Sleep after)
      Minimum Possible Setting: 0x00000000
      Maximum Possible Setting: 0xffffffff
      Possible Settings increment: 0x00000001
      Possible Settings units: Seconds
    Current AC Power Setting Index: 0x${ac.toString(16).padStart(8, "0")}
    Current DC Power Setting Index: 0x${dc.toString(16).padStart(8, "0")}
`;

const runner =
  (answers: Record<string, string | undefined>): Run =>
  (command, args) => {
    const key = [command, ...args].join(" ");
    const hit = Object.entries(answers).find(([k]) => key.includes(k));
    return hit && hit[1] !== undefined ? { status: 0, stdout: hit[1] } : { status: 1, stdout: "" };
  };

describe("reading this computer's sleep settings", () => {
  it("macOS: pmset's sections, sleep 0 as never, the power source", () => {
    expect(parsePmset(PMSET_CUSTOM).AC?.sleep).toBe("0");
    expect(parsePmset(PMSET_CUSTOM).AC?.["Sleep On Power Button"]).toBe("1");
    const s = readSleepSettings({
      platform: "darwin",
      run: runner({ "-g custom": PMSET_CUSTOM, "-g batt": PMSET_BATT }),
    });
    expect(s).toEqual({ os: "macos", pluggedInSleepMin: 0, batterySleepMin: 5, onBattery: true });
  });

  it("Windows: the last two hex values of powercfg, whatever the language", () => {
    expect(parsePowercfg(POWERCFG(1800, 900))).toEqual([1800, 900]);
    // The same with German labels: only the numbers are read.
    expect(
      parsePowercfg(
        "Aktueller Wechselstrom-Einstellungsindex: 0x00000000\nAktueller Gleichstrom-Einstellungsindex: 0x0000012c",
      ),
    ).toEqual([0, 300]);
    expect(parsePowercfg("Zugriff verweigert")).toBeUndefined();
    const s = readSleepSettings({
      platform: "win32",
      run: runner({
        "29f6c1db": POWERCFG(1800, 600),
        "5ca83367": POWERCFG(1, 1),
      }),
    });
    expect(s).toEqual({ os: "windows", pluggedInSleepMin: 30, batterySleepMin: 10, lid: "sleep" });
    const managed = readSleepSettings({
      platform: "win32",
      run: runner({ "29f6c1db-86da": POWERCFG(0, 0), "reg query": "ACSettingIndex REG_DWORD 0x0" }),
    });
    expect(managed.managed).toBe(true);
  });

  it("GNOME: the plugged-in suspend type and timeout", () => {
    const s = readSleepSettings({
      platform: "linux",
      env: { XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
      run: runner({
        "sleep-inactive-ac-type": "'suspend'\n",
        "sleep-inactive-ac-timeout": "uint32 900\n",
      }),
    });
    expect(s).toMatchObject({ os: "linux", desktop: "gnome", pluggedInSleepMin: 15 });
    const off = readSleepSettings({
      platform: "linux",
      env: { XDG_CURRENT_DESKTOP: "GNOME" },
      run: runner({
        "sleep-inactive-ac-type": "'nothing'\n",
        "sleep-inactive-ac-timeout": "900\n",
      }),
    });
    expect(off.pluggedInSleepMin).toBe(0);
  });

  it("KDE Plasma: powerdevilrc, with Plasma's defaults for missing keys", () => {
    const read = (rc: string) => () => rc;
    const set = readSleepSettings({
      platform: "linux",
      env: { XDG_CURRENT_DESKTOP: "KDE" },
      home: "/home/k",
      run: runner({}),
      readFile: read("[AC][SuspendAndShutdown]\nAutoSuspendAction=0\nLidAction=0\n"),
    });
    expect(set).toMatchObject({ desktop: "kde", pluggedInSleepMin: 0, lid: "nothing" });
    const defaults = readSleepSettings({
      platform: "linux",
      env: { XDG_CURRENT_DESKTOP: "KDE" },
      home: "/home/k",
      run: runner({}),
      readFile: read(""),
    });
    expect(defaults.pluggedInSleepMin).toBe(15);
  });

  it("any Linux: logind's idle action and lid on mains power", () => {
    const s = readSleepSettings({
      platform: "linux",
      env: {},
      run: runner({
        IdleActionUSec: "t 1800000000\n",
        IdleAction: 's "suspend"\n',
        HandleLidSwitchExternalPower: 's "ignore"\n',
      }),
    });
    expect(s).toMatchObject({ desktop: "logind", pluggedInSleepMin: 30, lid: "nothing" });
  });

  it("leaves out what it can't read, and never throws", () => {
    expect(readSleepSettings({ platform: "darwin", run: runner({}) })).toEqual({ os: "macos" });
    expect(readSleepSettings({ platform: "freebsd" })).toEqual({ os: "other" });
  });
});

describe("what would let the computer sleep while a resume waits", () => {
  it("counts plugged-in sleep only where Rewake can't hold, and battery unless Rewake holds always", () => {
    const s = { os: "macos" as const, pluggedInSleepMin: 10, batterySleepMin: 5, onBattery: false };
    expect(sleepRisks(s, "plugged-in")).toEqual([]);
    expect(sleepRisks(s, "none")).toEqual(["it's set to sleep after 10 minutes when plugged in"]);
    expect(sleepRisks({ ...s, onBattery: true }, "plugged-in")).toEqual([
      "it's on battery and set to sleep after 5 minutes",
    ]);
    expect(sleepRisks({ ...s, onBattery: true }, "always")).toEqual([]);
  });

  it("doctor: what to change and where, or that the organisation sets it", () => {
    const todo = sleepFindings({
      settings: { os: "windows", pluggedInSleepMin: 15, lid: "sleep" },
      hold: "none",
    });
    expect(todo.map((f) => f.level)).toEqual(["todo", "info"]);
    expect(todo[0]?.fix).toContain("#keep-your-computer-awake");
    const managed = sleepFindings({
      settings: { os: "windows", pluggedInSleepMin: 15, managed: true },
      hold: "none",
    });
    expect(managed[0]?.fix).toMatch(/^Your organisation sets this; ask your IT team/);
    expect(sleepFindings({ settings: { os: "linux" }, hold: "none" })[0]?.level).toBe("info");
    expect(
      sleepFindings({ settings: { os: "macos", pluggedInSleepMin: 10 }, hold: "plugged-in" })[0],
    ).toMatchObject({ level: "ok" });
  });
});

describe("the docs page", () => {
  it("has the section Rewake links to", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { SLEEP_DOCS_URL } = await import("../src/util/sleep-settings.js");
    const docs = readFileSync(
      join(import.meta.dirname, "..", "site/src/content/docs/docs.mdx"),
      "utf8",
    );
    expect(SLEEP_DOCS_URL.endsWith("#keep-your-computer-awake")).toBe(true);
    expect(docs).toContain("\n## Keep your computer awake\n");
  });
});
