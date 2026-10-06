import { describe, expect, it } from "vitest";
import { formatWhen } from "../src/core/time.js";
import { taskEntry } from "../src/install.js";
import { parseInput } from "../src/ui/input.js";
import { projectKey } from "../src/ui/overview.js";

// What people see on each OS.

describe("the schedules-page task in Zed", () => {
  it("quotes paths with spaces for the task's shell, because Zed doesn't", () => {
    const mac = taskEntry(
      { command: "/opt/homebrew/bin/node", args: ["/Users/me/My Tools/agent-rewake.js"] },
      "darwin",
    );
    expect(mac.command).toBe("/opt/homebrew/bin/node");
    expect(mac.args).toEqual(["'/Users/me/My Tools/agent-rewake.js'", "ui"]);
    expect(mac.shell).toBeUndefined();

    const tricky = taskEntry({ command: "/n/node", args: ["/it's here/r.js"] }, "linux");
    expect(tricky.args).toEqual(["'/it'\\''s here/r.js'", "ui"]);

    const win = taskEntry(
      { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\Tools\\agent-rewake.js"] },
      "win32",
    );
    expect(win.command).toBe('"C:\\Program Files\\nodejs\\node.exe"');
    expect(win.args).toEqual(["C:\\Tools\\agent-rewake.js", "ui"]);
    expect(win.shell).toEqual({ program: "cmd" });
  });
});

describe("pasting into the schedules page", () => {
  it("treats a multi-line chunk without paste markers as one paste (Windows' console)", () => {
    expect(parseInput("first line\r\nsecond line\r\n").events).toEqual([
      { type: "paste", text: "first line\nsecond line" },
    ]);
  });

  it("still reads typing and Enter as keys", () => {
    expect(parseInput("\r").events).toEqual([{ type: "key", name: "enter" }]);
    expect(parseInput("ab").events.map((e) => (e.type === "key" ? e.ch : e.type))).toEqual([
      "a",
      "b",
    ]);
    expect(parseInput("a\r").events.at(-1)).toEqual({ type: "key", name: "enter" });
  });
});

describe("projects in the schedules list", () => {
  it("are the same folder however Windows spells it", () => {
    expect(projectKey("c:\\Work\\API", "win32")).toBe(projectKey("C:/work/api/", "win32"));
    expect(projectKey("/home/me/Api", "linux")).not.toBe(projectKey("/home/me/api", "linux"));
  });
});

describe("dates", () => {
  it("are written in English whatever the system language", () => {
    const now = new Date(2026, 9, 4, 12, 0).getTime();
    const at = new Date(2026, 9, 5, 9, 0).getTime();
    expect(formatWhen(at, now)).toMatch(/tomorrow \(Monday\)$/);
  });
});
