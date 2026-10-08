import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { findOnWindows, npmShimTarget } from "../util/spawn.js";

/**
 * Which coding agents are on this computer, for `install` and `doctor`. Read-only and offline: it
 * looks for each tool's program or app where its installers put it and reads versions from files
 * next to it. It never runs another tool (some write files even for `--version`) and never treats a
 * settings folder alone as an install: other apps create `~/.codex`, `~/.copilot` and `~/.gemini`.
 *
 * Install locations (checked 2026-10-06 against each tool's installer and docs):
 *   - Claude Code: native installer `~/.local/bin/claude` → `~/.local/share/claude/versions/<v>`;
 *     npm `@anthropic-ai/claude-code`; Homebrew, apt, WinGet put `claude` on PATH. The Claude
 *     desktop app's Code tab keeps its own copy in `<app support>/Claude/claude-code/<v>/`.
 *   - Codex: npm `@openai/codex`; Homebrew cask; `${CODEX_INSTALL_DIR:-~/.local/bin}/codex`; the
 *     ChatGPT desktop app bundles it (`ChatGPT.app/Contents/Resources/codex-cli`).
 *   - GitHub Copilot CLI: npm `@github/copilot`; install script `~/.local/bin/copilot`.
 *   - Grok Build: `${GROK_BIN_DIR:-~/.grok/bin}/grok` beside `grok-<v>`; npm `@xai-official/grok`.
 *   - Gemini CLI: npm `@google/gemini-cli`; Homebrew.
 *   - Antigravity: `agy` (`~/.local/bin`, Windows `%LOCALAPPDATA%\agy\bin`), `Antigravity.app`,
 *     `Antigravity IDE.app`. Its version is read only from an app's Info.plist.
 */
export type PlaceId =
  | "claude-code"
  | "codex"
  | "copilot-cli"
  | "grok"
  | "gemini-cli"
  | "antigravity"
  | "jetbrains"
  | "devin-desktop"
  | "cursor"
  | "zed";

export interface Found {
  id: PlaceId;
  /** As people know it: "Claude Code". */
  name: string;
  /** The highest version found, when a file records it. */
  version?: string;
  /** Where it runs, when it's more than one program: "terminal", "desktop app". */
  surfaces: string[];
}

export interface DetectHost {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  /** Where macOS apps are installed (default: /Applications and ~/Applications). */
  appDirs?: string[];
}

const VERSION = /^\d+\.\d+\.\d+/;

/** -1, 0 or 1, comparing dotted version numbers (anything after a "-" or "+" ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    (v.split(/[-+ ]/)[0] ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function highest(versions: (string | undefined)[]): string | undefined {
  return versions
    .filter((v): v is string => v !== undefined && VERSION.test(v))
    .sort(compareVersions)
    .pop();
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Every file named `command` on PATH (Windows: by PATHEXT), first one first. */
export function onPath(command: string, h: DetectHost): string[] {
  if (h.platform === "win32") {
    const file = findOnWindows(command, h.env, isFile);
    return file ? [file] : [];
  }
  const path = h.env.PATH ?? "";
  return [
    ...new Set(
      path
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, command))
        .filter(isFile),
    ),
  ];
}

/**
 * The version of npm package `name` that a program belongs to: follows symlinks (and npm's `.cmd`
 * shims on Windows) and walks up to the package's own package.json.
 */
export function npmVersion(program: string, name: string): string | undefined {
  let file = realpath(program);
  if (/\.(cmd|bat)$/i.test(file)) file = npmShimTarget(file) ?? file;
  let dir = dirname(file);
  for (let i = 0; i < 6; i++) {
    const pkg = readJson(join(dir, "package.json"));
    if (pkg?.name === name && typeof pkg.version === "string") return pkg.version;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** A macOS app's version from its Info.plist (XML), when it has one. */
export function appVersion(app: string): string | undefined {
  try {
    const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  } catch {
    return undefined;
  }
}

function apps(h: DetectHost, name: string): string[] {
  if (h.platform !== "darwin") return [];
  const dirs = h.appDirs ?? ["/Applications", join(h.home, "Applications")];
  return dirs.map((d) => join(d, `${name}.app`)).filter((a) => existsSync(a));
}

/** Programs for `command`: on PATH plus the installers' own folders, without duplicates. */
function programs(command: string, h: DetectHost, extra: string[]): string[] {
  const exe = h.platform === "win32" ? [".exe", ".cmd"] : [""];
  const known = extra.flatMap((p) => exe.map((e) => p + e)).filter(isFile);
  const seen = new Set<string>();
  return [...onPath(command, h), ...known].filter((p) => {
    const real = realpath(p);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

/** A version written into a path, e.g. `…/versions/2.1.291` or `…/grok-1.0.46`. */
function versionInPath(program: string, pattern: RegExp): string | undefined {
  return pattern.exec(realpath(program))?.[1];
}

/** Every Claude Code CLI program (terminal installs), with versions where a file records them. */
export function claudePrograms(h: DetectHost): Program[] {
  const local = join(h.home, ".local", "bin", "claude");
  return programs("claude", h, [local]).map((path) => {
    const version =
      versionInPath(path, /[\\/]versions[\\/](\d+\.\d+\.\d+)/) ??
      npmVersion(path, "@anthropic-ai/claude-code");
    return { path, surface: "terminal", ...(version && { version }) };
  });
}

/**
 * The Claude desktop app's own Claude Code (macOS): `claude-code/<version>/<build>/claude.app`,
 * a full CLI that can run `claude plugin …`. Only builds the app has finished checking (a
 * `.verified` file beside them, research impl-claude-copilot A.1.1).
 */
export function claudeDesktopPrograms(h: DetectHost): Program[] {
  if (h.platform !== "darwin") return [];
  const root = join(h.home, "Library", "Application Support", "Claude", "claude-code");
  const out: Program[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(root).filter((n) => VERSION.test(n));
  } catch {
    return out;
  }
  for (const version of names) {
    let builds: string[] = [];
    try {
      builds = readdirSync(join(root, version));
    } catch {
      continue;
    }
    for (const b of builds) {
      const path = join(root, version, b, "claude.app", "Contents", "MacOS", "claude");
      if (existsSync(join(root, version, b, ".verified")) && isFile(path))
        out.push({ path, surface: "desktop app", version });
    }
  }
  return out;
}

function claudeCode(h: DetectHost): Found | undefined {
  const cli = claudePrograms(h);
  const bins = cli.map((p) => p.path);
  const versions = cli.map((p) => p.version);
  // The desktop app's Code tab: `claude-code/<version>/<build>/claude.app` (macOS).
  const desktop: string[] = [];
  if (h.platform === "darwin") {
    const root = join(h.home, "Library", "Application Support", "Claude", "claude-code");
    let names: string[] = [];
    try {
      names = readdirSync(root).filter((n) => VERSION.test(n));
    } catch {
      // No desktop app copy.
    }
    for (const v of names) {
      let builds: string[] = [];
      try {
        builds = readdirSync(join(root, v));
      } catch {
        continue;
      }
      if (builds.some((b) => existsSync(join(root, v, b, "claude.app")))) desktop.push(v);
    }
  }
  if (bins.length === 0 && desktop.length === 0) return undefined;
  const version = highest([...versions, ...desktop]);
  return {
    id: "claude-code",
    name: "Claude Code",
    ...(version && { version }),
    surfaces: [
      ...(bins.length > 0 ? ["terminal"] : []),
      ...(desktop.length > 0 ? ["desktop app"] : []),
    ],
  };
}

/** One program found on disk, with its version when a file records it. */
export interface Program {
  path: string;
  version?: string;
  /** Where it came from: "terminal" for a CLI install, "ChatGPT app" for the bundled copy. */
  surface: string;
}

/** Every Codex program: CLI installs, then the copy inside the ChatGPT desktop app (macOS). */
export function codexPrograms(h: DetectHost): Program[] {
  const dir = h.env.CODEX_INSTALL_DIR || join(h.home, ".local", "bin");
  const localAppData = h.env.LOCALAPPDATA;
  const bins = programs("codex", h, [
    join(dir, "codex"),
    ...(h.platform === "win32" && localAppData
      ? [join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex")]
      : []),
  ]);
  const found: Program[] = bins.map((path) => {
    const version =
      npmVersion(path, "@openai/codex") ??
      versionInPath(path, /[\\/]Caskroom[\\/]codex[\\/]([\d.]+)/);
    return { path, surface: "terminal", ...(version && { version }) };
  });
  for (const app of apps(h, "ChatGPT")) {
    const d = join(app, "Contents", "Resources", "codex-cli");
    if (!existsSync(d)) continue;
    const v = readJson(join(d, "codex-package.json"))?.version;
    found.push({
      path: join(d, "bin", "codex"),
      surface: "ChatGPT app",
      ...(typeof v === "string" && { version: v }),
    });
  }
  return found;
}

function codex(h: DetectHost): Found | undefined {
  const found = codexPrograms(h);
  if (found.length === 0) return undefined;
  const version = highest(found.map((p) => p.version));
  return {
    id: "codex",
    name: "Codex",
    ...(version && { version }),
    surfaces: [...new Set(found.map((p) => p.surface))],
  };
}

/** Every GitHub Copilot CLI program, with versions where a file records them. */
export function copilotPrograms(h: DetectHost): Program[] {
  const appData = h.env.APPDATA;
  const extra = [
    join(h.home, ".local", "bin", "copilot"),
    ...(h.platform === "win32" && appData ? [join(appData, "npm", "copilot")] : []),
  ];
  return programs("copilot", h, extra).map((path) => {
    const version = npmVersion(path, "@github/copilot");
    return { path, surface: "terminal", ...(version && { version }) };
  });
}

/** Every Grok Build program: `${GROK_BIN_DIR:-~/.grok/bin}/grok`, npm's launcher, or PATH. */
export function grokPrograms(h: DetectHost): Program[] {
  const grokBin = h.env.GROK_BIN_DIR || join(h.home, ".grok", "bin");
  return programs("grok", h, [join(grokBin, "grok")]).map((path) => {
    const version =
      npmVersion(path, "@xai-official/grok") ?? versionInPath(path, /[\\/]grok-(\d+\.\d+\.\d+)/);
    return { path, surface: "terminal", ...(version && { version }) };
  });
}

/** Every Gemini CLI program, with versions from its package.json (running it writes files). */
export function geminiPrograms(h: DetectHost): Program[] {
  const appData = h.env.APPDATA;
  const extra = h.platform === "win32" && appData ? [join(appData, "npm", "gemini")] : [];
  return programs("gemini", h, extra).map((path) => {
    const version = npmVersion(path, "@google/gemini-cli");
    return { path, surface: "terminal", ...(version && { version }) };
  });
}

/** Every Antigravity CLI program (`agy`); its version isn't recorded in a file. */
export function agyPrograms(h: DetectHost): Program[] {
  const localAppData = h.env.LOCALAPPDATA;
  return programs("agy", h, [
    join(h.home, ".local", "bin", "agy"),
    ...(h.platform === "win32" && localAppData ? [join(localAppData, "agy", "bin", "agy")] : []),
  ]).map((path) => ({ path, surface: "terminal" }));
}

function simpleCli(
  h: DetectHost,
  id: PlaceId,
  name: string,
  command: string,
  pkg: string,
  extra: string[],
  pathVersion?: RegExp,
): Found | undefined {
  const bins = programs(command, h, extra);
  if (bins.length === 0) return undefined;
  const version = highest(
    bins.map(
      (b) => npmVersion(b, pkg) ?? (pathVersion ? versionInPath(b, pathVersion) : undefined),
    ),
  );
  return { id, name, ...(version && { version }), surfaces: ["terminal"] };
}

function antigravity(h: DetectHost): Found | undefined {
  const localAppData = h.env.LOCALAPPDATA;
  const bins = programs("agy", h, [
    join(h.home, ".local", "bin", "agy"),
    ...(h.platform === "win32" && localAppData ? [join(localAppData, "agy", "bin", "agy")] : []),
  ]);
  const app = apps(h, "Antigravity");
  const ide = apps(h, "Antigravity IDE");
  if (bins.length === 0 && app.length === 0 && ide.length === 0) return undefined;
  // The CLI's version isn't recorded in a file, and running `agy` isn't safe offline (untested).
  const version = highest([...app, ...ide].map(appVersion));
  return {
    id: "antigravity",
    name: "Antigravity",
    ...(version && { version }),
    surfaces: [
      ...(bins.length > 0 ? ["terminal"] : []),
      ...(app.length > 0 ? ["app"] : []),
      ...(ide.length > 0 ? ["IDE"] : []),
    ],
  };
}

/** Coding agents found on this computer, other than Zed (which `doctor` checks in detail). */
/**
 * Each preview's terminal program as the person runs it (the first on PATH, else a known install
 * folder), with its version when a file records it. Desktop apps are left out: no preview runs
 * there. For `doctor`'s version notes.
 */
export function terminalAgents(h: DetectHost): { id: PlaceId; version?: string }[] {
  const found: [PlaceId, Program[]][] = [
    ["claude-code", claudePrograms(h)],
    ["codex", codexPrograms(h).filter((p) => p.surface === "terminal")],
    ["copilot-cli", copilotPrograms(h)],
    ["grok", grokPrograms(h)],
    ["gemini-cli", geminiPrograms(h)],
  ];
  return found.flatMap(([id, ps]) => {
    const p = ps[0];
    return p ? [{ id, ...(p.version && { version: p.version }) }] : [];
  });
}

export function detectAgents(h: DetectHost): Found[] {
  const local = (cmd: string) => join(h.home, ".local", "bin", cmd);
  const grokBin = h.env.GROK_BIN_DIR || join(h.home, ".grok", "bin");
  const appData = h.env.APPDATA;
  const npmWin = (cmd: string) =>
    h.platform === "win32" && appData ? [join(appData, "npm", cmd)] : [];
  return [
    claudeCode(h),
    codex(h),
    simpleCli(h, "copilot-cli", "GitHub Copilot CLI", "copilot", "@github/copilot", [
      local("copilot"),
      ...npmWin("copilot"),
    ]),
    simpleCli(
      h,
      "grok",
      "Grok Build",
      "grok",
      "@xai-official/grok",
      [join(grokBin, "grok")],
      /[\\/]grok-(\d+\.\d+\.\d+)/,
    ),
    simpleCli(h, "gemini-cli", "Gemini CLI", "gemini", "@google/gemini-cli", npmWin("gemini")),
    antigravity(h),
  ].filter((f): f is Found => f !== undefined);
}

function orList(items: string[]): string {
  return items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

/**
 * One plain sentence for `install` and `doctor` when other coding agents are here: Rewake works only
 * in Zed's Agent Panel, with the tools found on this computer named as used on their own: Codex
 * works in Zed, so the sentence speaks of Codex outside it.
 */
export function otherAgentsNote(found: Found[], previews: string[] = []): string | undefined {
  if (found.length === 0 && previews.length === 0) return undefined;
  const names = [...new Set(found.map((f) => f.name))];
  const and = (xs: string[]) =>
    xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
  const where =
    previews.length > 0
      ? `Rewake works in Zed's Agent Panel (not with Zed's own agent) and, as a preview you set up, in ${and(previews)}.`
      : "Rewake works only in Zed's Agent Panel (not with Zed's own agent).";
  const not =
    (names.length > 0
      ? ` It isn't set up for ${orList(names)} used on ${names.length === 1 ? "its" : "their"} own in a terminal, another editor or a desktop app.`
      : "") + (previews.length > 0 ? " Previews cover only the places named." : "");
  return `${where}${not}`;
}

/**
 * The agents found, minus those where Rewake is already installed as a preview (their own app
 * then isn't a place Rewake "doesn't work"). `installed(id)` says whether it is.
 */
export function withoutInstalled(found: Found[], installed: (id: PlaceId) => boolean): Found[] {
  return found.filter((f) => !installed(f.id));
}
