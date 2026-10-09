import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentCopies,
  chooseProgram,
  claudeDesktopPrograms,
  type DetectHost,
  detectAgents,
  type Found,
  otherAgentsNote,
  terminalAgents,
  withoutInstalled,
} from "../src/install/detect.js";

let root: string;
let home: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "rewake-detect-")));
  home = join(root, "home");
  mkdirSync(home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const file = (path: string, text = "") => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
};
const link = (target: string, path: string) => {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
};
const host = (o: Partial<DetectHost> & { path?: string[] } = {}): DetectHost => ({
  env: { PATH: (o.path ?? []).join(delimiter), ...o.env },
  home,
  platform: o.platform ?? (process.platform === "win32" ? "linux" : process.platform),
  appDirs: o.appDirs ?? [join(root, "Applications")],
});
/** An npm global install: `<prefix>/bin/<cmd>` → the package's script, beside its package.json. */
const npmGlobal = (prefix: string, cmd: string, pkg: string, version: string, script: string) => {
  const dir = join(prefix, "lib", "node_modules", ...pkg.split("/"));
  file(join(dir, "package.json"), JSON.stringify({ name: pkg, version }));
  const js = file(join(dir, script), "#!/usr/bin/env node\n");
  link(js, join(prefix, "bin", cmd));
};
const posixOnly = process.platform === "win32" ? it.skip : it;

describe("detectAgents", () => {
  it("finds nothing on an empty computer", () => {
    expect(detectAgents(host())).toEqual([]);
  });

  it("never counts a settings folder alone (other apps create them)", () => {
    for (const d of [".claude", ".codex", ".copilot", ".gemini", ".grok", ".antigravity"])
      file(join(home, d, "config.json"), "{}");
    expect(detectAgents(host())).toEqual([]);
  });

  posixOnly("reads Claude Code's version from the native installer's versions folder", () => {
    const bin = file(join(home, ".local", "share", "claude", "versions", "2.1.291"));
    link(bin, join(home, ".local", "bin", "claude"));
    expect(detectAgents(host())).toEqual([
      { id: "claude-code", name: "Claude Code", version: "2.1.291", surfaces: ["terminal"] },
    ]);
  });

  posixOnly(
    "reads versions from npm global installs on PATH, and reports the first on PATH",
    () => {
      const a = join(root, "npm-a");
      const b = join(root, "npm-b");
      npmGlobal(a, "codex", "@openai/codex", "0.149.0", "bin/codex.js");
      npmGlobal(b, "codex", "@openai/codex", "0.160.1", "bin/codex.js");
      npmGlobal(a, "copilot", "@github/copilot", "1.0.92", "index.js");
      npmGlobal(a, "gemini", "@google/gemini-cli", "0.62.0", "dist/index.js");
      const found = detectAgents(host({ path: [join(a, "bin"), join(b, "bin")] }));
      expect(found.map((f) => [f.id, f.version])).toEqual([
        ["codex", "0.149.0"],
        ["copilot-cli", "1.0.92"],
        ["gemini-cli", "0.62.0"],
      ]);
    },
  );

  posixOnly("finds Grok Build in its own folder, with the version in the file name", () => {
    const bin = file(join(home, ".grok", "bin", "grok-1.0.46"));
    link(bin, join(home, ".grok", "bin", "grok"));
    expect(detectAgents(host())).toEqual([
      { id: "grok", name: "Grok Build", version: "1.0.46", surfaces: ["terminal"] },
    ]);
  });

  it("finds a program by PATH even without a version file", () => {
    file(join(root, "bin", "copilot"));
    expect(detectAgents(host({ path: [join(root, "bin")] }))).toEqual([
      { id: "copilot-cli", name: "GitHub Copilot CLI", surfaces: ["terminal"] },
    ]);
  });

  it("finds the copies inside desktop apps on macOS", () => {
    const apps = join(root, "Applications");
    file(
      join(apps, "ChatGPT.app", "Contents", "Resources", "codex-cli", "codex-package.json"),
      JSON.stringify({ version: "0.159.2" }),
    );
    mkdirSync(
      join(home, "Library", "Application Support", "Claude", "claude-code", "2.1.288", "48d5"),
      { recursive: true },
    );
    mkdirSync(
      join(
        home,
        "Library",
        "Application Support",
        "Claude",
        "claude-code",
        "2.1.288",
        "48d5",
        "claude.app",
      ),
    );
    file(
      join(apps, "Antigravity IDE.app", "Contents", "Info.plist"),
      "<plist><dict><key>CFBundleShortVersionString</key>\n<string>2.5.5</string></dict></plist>",
    );
    expect(detectAgents(host({ platform: "darwin" }))).toEqual([
      { id: "claude-code", name: "Claude Code", version: "2.1.288", surfaces: ["desktop app"] },
      { id: "codex", name: "Codex", version: "0.159.2", surfaces: ["ChatGPT app"] },
      { id: "antigravity", name: "Antigravity", version: "2.5.5", surfaces: ["IDE"] },
    ]);
    // Apps are a macOS layout: elsewhere the same folders mean nothing.
    expect(detectAgents(host({ platform: "linux" }))).toEqual([]);
  });

  it("ignores a desktop app's Claude Code folder without the app in it", () => {
    mkdirSync(join(home, "Library", "Application Support", "Claude", "claude-code", "2.1.288"), {
      recursive: true,
    });
    expect(detectAgents(host({ platform: "darwin" }))).toEqual([]);
  });

  it("finds Antigravity's CLI without running it", () => {
    file(join(home, ".local", "bin", "agy"), "#!/bin/sh\nexit 99\n");
    expect(detectAgents(host())).toEqual([
      { id: "antigravity", name: "Antigravity", surfaces: ["terminal"] },
    ]);
  });
});

describe("wording", () => {
  const claude: Found = {
    id: "claude-code",
    name: "Claude Code",
    version: "2.1.291",
    surfaces: ["terminal", "desktop app"],
  };
  const codex: Found = { id: "codex", name: "Codex", version: "0.160.1", surfaces: ["terminal"] };
  const grok: Found = { id: "grok", name: "Grok Build", surfaces: ["terminal"] };

  it("says Rewake works only in Zed's Agent Panel, with the tools found here as examples", () => {
    expect(otherAgentsNote([])).toBeUndefined();
    expect(otherAgentsNote([codex])).toBe(
      "Rewake works only in Zed's Agent Panel (not with Zed's own agent). It isn't set up for Codex used on its own in a terminal, another editor or a desktop app.",
    );
    expect(
      otherAgentsNote([
        claude,
        { ...codex, surfaces: ["ChatGPT app"] },
        grok,
        { id: "antigravity", name: "Antigravity", surfaces: ["terminal", "app", "IDE"] },
      ]),
    ).toBe(
      "Rewake works only in Zed's Agent Panel (not with Zed's own agent). It isn't set up for Claude Code, Codex, Grok Build or Antigravity used on their own in a terminal, another editor or a desktop app.",
    );
  });
});

describe("installed previews", () => {
  it("leaves out agents Rewake is already installed in", () => {
    const codex: Found = { id: "codex", name: "Codex", surfaces: ["terminal"] };
    const grok: Found = { id: "grok", name: "Grok Build", surfaces: ["terminal"] };
    expect(withoutInstalled([codex, grok], (id) => id === "codex")).toEqual([grok]);
  });
});

describe("with previews installed", () => {
  const codex: Found = { id: "codex", name: "Codex", surfaces: ["terminal"] };
  it("says where Rewake works, previews included", () => {
    expect(otherAgentsNote([codex], ["Claude Code"])).toBe(
      "Rewake works in Zed's Agent Panel (not with Zed's own agent) and, as a preview you set up, in Claude Code. It isn't set up for Codex used on its own in a terminal, another editor or a desktop app. Previews cover only the places named.",
    );
    expect(otherAgentsNote([], ["Claude Code", "Codex"])).toBe(
      "Rewake works in Zed's Agent Panel (not with Zed's own agent) and, as a preview you set up, in Claude Code and Codex. Previews cover only the places named.",
    );
  });
});

describe("the Claude desktop app's own Claude Code", () => {
  posixOnly("is a program Rewake can run, once the app has verified that build", () => {
    const base = join(home, "Library", "Application Support", "Claude", "claude-code");
    const bin = (v: string, b: string) =>
      join(base, v, b, "claude.app", "Contents", "MacOS", "claude");
    file(bin("2.1.289", "ee67"));
    file(join(base, "2.1.289", "ee67", ".verified"), "x");
    // Not verified yet (still downloading): left out.
    file(bin("2.1.290", "aa11"));
    expect(claudeDesktopPrograms({ ...host(), platform: "darwin" })).toEqual([
      { path: bin("2.1.289", "ee67"), surface: "desktop app", version: "2.1.289" },
    ]);
    expect(claudeDesktopPrograms({ ...host(), platform: "linux" })).toEqual([]);
  });
});

describe("two copies of one agent", () => {
  /** An npm Claude Code (2.1.282) first on PATH, the native 2.1.292 in ~/.local/bin. */
  const twoClaudes = () => {
    const npm = join(root, "nvm");
    npmGlobal(npm, "claude", "@anthropic-ai/claude-code", "2.1.282", "cli.js");
    const native = file(join(home, ".local", "share", "claude", "versions", "2.1.292"));
    link(native, join(home, ".local", "bin", "claude"));
    return host({ path: [join(npm, "bin")] });
  };

  posixOnly("judges and reports the copy that runs first on PATH, not the newest", () => {
    const h = twoClaudes();
    expect(terminalAgents(h)).toEqual([{ id: "claude-code", version: "2.1.282" }]);
    expect(detectAgents(h).find((f) => f.id === "claude-code")?.version).toBe("2.1.282");
  });

  posixOnly("lists every copy for doctor --details, marking the one in use", () => {
    const [c] = agentCopies(twoClaudes());
    expect(c?.name).toBe("Claude Code");
    expect(c?.copies.map((p) => p.version)).toEqual(["2.1.282", "2.1.292"]);
    expect(c?.chosen.version).toBe("2.1.282");
    expect(agentCopies(host())).toEqual([]);
  });

  it("chooses the first terminal copy, else the newest app copy", () => {
    const app = { path: "/app", surface: "ChatGPT app", version: "0.170.0" };
    const cli = (path: string, version: string) => ({ path, surface: "terminal", version });
    expect(chooseProgram([app, cli("/a", "1.0.0"), cli("/b", "2.0.0")])?.path).toBe("/a");
    expect(chooseProgram([app])?.path).toBe("/app");
    expect(chooseProgram([])).toBeUndefined();
  });
});
