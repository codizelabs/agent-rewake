import { SETTING_NAMES } from "./settings-command.js";
import { VERSION } from "./version.js";

/**
 * What `agent-rewake --help`, `<command> --help` and `completion <shell>` say, from one table, so
 * the help and the completion scripts can't drift apart. Commands people type come first; the ones
 * Rewake starts itself are listed only by `--help --all`.
 */

/** The places `install --only` and `uninstall --only` take: Zed (the default) and the previews. */
export const PLACES = [
  "zed",
  "claude-code",
  "codex",
  "copilot-cli",
  "grok",
  "gemini-cli",
  "antigravity",
  "jetbrains",
  "devin-desktop",
  "cursor",
] as const;

export const SHELLS = ["bash", "zsh", "fish"] as const;

export interface OptionInfo {
  flag: string;
  /** A short form such as `-y`. */
  alias?: string;
  /** What follows the flag, as help shows it: `<place>[,<place>...]`. */
  arg?: string;
  /** The words completion offers after the flag. */
  values?: readonly string[];
  text: string;
}

export interface CommandInfo {
  name: string;
  /** One line for the command list. */
  summary: string;
  /** Usage lines after "agent-rewake". */
  usage: string[];
  /** A paragraph or two for `<command> --help`. */
  about: string[];
  options: OptionInfo[];
  /** Words that follow the command and aren't options (completion offers them). */
  words?: readonly string[];
  /** Said after the options. */
  footer?: string[];
}

const PLACE_LIST = PLACES.join(", ");

/** What `help` completes to: every command below (a test keeps the two in step). */
export const COMMAND_WORDS = [
  "install",
  "uninstall",
  "doctor",
  "ui",
  "schedules",
  "history",
  "continue",
  "settings",
  "setup",
  "help",
  "completion",
] as const;

/** The commands a person types, in the order help lists them. */
export const COMMANDS: CommandInfo[] = [
  {
    name: "install",
    summary: "Add Rewake to Zed and to the agents you pick",
    usage: [
      "install [--only <place>[,<place>...] | --all | --skip <place>[,<place>...]]",
      "        [--agent <id>]... [--yes] [--dry-run] [--keybinding]",
    ],
    about: [
      "Adds Rewake to the places you use, keeping your agents' threads. It shows every change and",
      "asks once before writing. Run in a terminal with no options, it shows what it found and lets",
      "you pick the places. Without a terminal, or with --yes, it sets up Zed only.",
    ],
    options: [
      {
        flag: "--only",
        arg: "<place>[,<place>...]",
        values: PLACES,
        text: "Set up only these places",
      },
      { flag: "--all", text: "Set up every place it found" },
      { flag: "--skip", arg: "<place>[,<place>...]", values: PLACES, text: "Leave these out" },
      {
        flag: "--agent",
        arg: "<id>",
        text: "Zed: put Rewake in front of only this agent (repeat)",
      },
      { flag: "--yes", alias: "-y", text: "Don't ask; apply the changes shown" },
      { flag: "--dry-run", text: "Show the changes and write nothing" },
      { flag: "--keybinding", text: "Zed: also add a keybinding for the schedules page" },
    ],
    footer: [`Places: ${PLACE_LIST}.`],
  },
  {
    name: "uninstall",
    summary: "Take Rewake out of the places it's set up in",
    usage: [
      "uninstall [--only <place>[,<place>...] | --all | --skip <place>[,<place>...]]",
      "          [--yes] [--dry-run]",
    ],
    about: [
      "Takes Rewake out of every place it's set up in (Zed, your agents' hooks and plugins, the",
      "login item). It shows every change and asks once. Your scheduled messages stay in Rewake's",
      "own folder, which `doctor --details` names; delete it to finish.",
    ],
    options: [
      {
        flag: "--only",
        arg: "<place>[,<place>...]",
        values: PLACES,
        text: "Take it out of only these places",
      },
      { flag: "--all", text: "Every place it's set up in (the default)" },
      { flag: "--skip", arg: "<place>[,<place>...]", values: PLACES, text: "Keep these" },
      { flag: "--yes", alias: "-y", text: "Don't ask; apply the changes shown" },
      { flag: "--dry-run", text: "Show the changes and write nothing" },
    ],
    footer: [`Places: ${PLACE_LIST}.`],
  },
  {
    name: "doctor",
    summary: "Check your setup, in plain words (no network access)",
    usage: ["doctor [--details] [--json] [--report]", 'doctor --limit-sample "<message>"'],
    about: [
      "Looks at every place you set up and says what works and what's left to do. It works offline",
      "and prints no folders, accounts or keys. Exit status 1 when something is a problem.",
    ],
    options: [
      { flag: "--details", text: "Add versions and folders, for a bug report" },
      { flag: "--json", text: "Print the findings as JSON, for scripts" },
      {
        flag: '--limit-sample "<message>"',
        text: "See how Rewake reads a limit message it missed, and get a link to report it (nothing is sent or opened)",
      },
      {
        flag: "--report",
        text: "Write one text file for a bug report: for you to read and attach, nothing is sent",
      },
    ],
    footer: [
      "The report shows your home folder as ~, hides session ids and leaves out message text.",
    ],
  },
  {
    name: "ui",
    summary: "The schedules page: a table you can click",
    usage: ["ui [--inline] [--thread <id>]"],
    about: [
      "Opens the schedules page in this terminal: every thread's scheduled messages in a table you",
      "can click or drive with the keys (? shows them). In Zed it runs from the task panel.",
      "For a screen reader or plain text, use `agent-rewake schedules`: the same list, no page.",
    ],
    options: [
      { flag: "--inline", text: "Draw it inside a thread instead of full screen" },
      { flag: "--thread", arg: "<id>", text: "Show only this thread" },
    ],
  },
  {
    name: "schedules",
    summary: "Print the scheduled messages as plain text",
    usage: ["schedules [--all] [--json]"],
    about: [
      "Lists the scheduled messages, by project and thread, as text a screen reader can read.",
      "Without --all only what's still planned is listed.",
    ],
    options: [
      { flag: "--all", text: "Include finished ones too, newest first, with the year" },
      { flag: "--json", text: "Print JSON instead of text" },
    ],
  },
  {
    name: "history",
    summary: "What Rewake did lately, newest first",
    usage: ["history [--days <n>]"],
    about: [
      "Lists what happened to each scheduled message and resume in the last days, newest first:",
      "the agent and folder, and what happened and why (sent, cancelled, too late, still limited,",
      "failed and the reason).",
    ],
    options: [{ flag: "--days", arg: "<n>", text: "How many days back (default 7)" }],
  },
  {
    name: "continue",
    summary: "Continue a closed agent session after its usage limit",
    usage: ["continue [--always | --ask | --cancel [<id>]]"],
    about: [
      "Continues a session you closed at its usage limit, when the limit resets. Run alone, it asks",
      "which session and when.",
    ],
    options: [
      { flag: "--always", text: "Continue sessions by itself from now on" },
      { flag: "--ask", text: "Go back to asking each time" },
      {
        flag: "--cancel",
        text: "Cancel a planned resume: pick it, or give its id",
      },
    ],
    footer: [
      "With several planned and a terminal, --cancel lists them to pick one, or all. The ids are",
      "in square brackets in `agent-rewake schedules`.",
    ],
  },
  {
    name: "settings",
    summary: "See and change Rewake's settings",
    usage: ["settings [<name> [<value>]]", "settings change", "settings --reset <name>"],
    about: [
      "Lists Rewake's settings with their values and what each does: the same settings as Zed's",
      "Rewake menu → Settings…, shared by every agent Rewake is set up in. `settings <name>`",
      "shows the values one takes; `settings change` lets you pick one by its number.",
    ],
    options: [
      {
        flag: "--reset",
        arg: "<name>",
        values: SETTING_NAMES,
        text: "Go back to the default",
      },
    ],
    words: ["change", ...SETTING_NAMES],
    footer: [`Settings: ${SETTING_NAMES.join(", ")}.`],
  },
  {
    name: "setup",
    summary: "Print the Zed settings, to add by hand",
    usage: ["setup zed"],
    about: ["Prints the Zed settings, task and keybinding that `install` would write."],
    options: [],
    words: ["zed"],
  },
  {
    name: "help",
    summary: "Show help for a command",
    usage: ["help [command]"],
    about: [
      "Shows the commands you run, or the options of one command: the same as",
      "`agent-rewake <command> --help`.",
    ],
    options: [],
    words: COMMAND_WORDS,
  },
  {
    name: "completion",
    summary: "Print a shell completion script",
    usage: [`completion <${SHELLS.join("|")}>`],
    about: [
      "Prints a script that completes Rewake's commands and options in your shell. Nothing is",
      "installed or written; you decide where it goes. For example:",
    ],
    options: [],
    words: SHELLS,
    footer: [
      "  bash:  echo 'source <(agent-rewake completion bash)' >> ~/.bashrc",
      "  zsh:   echo 'source <(agent-rewake completion zsh)' >> ~/.zshrc",
      "  fish:  agent-rewake completion fish > ~/.config/fish/completions/agent-rewake.fish",
    ],
  },
];

/** What Rewake and your agents start themselves: listed by `--help --all`. */
export const INTERNAL: { usage: string; text: string }[] = [
  {
    usage: "--wrap-registry <id>",
    text: "Run in front of a registry agent, e.g. claude-acp, codex-acp (Zed launches this)",
  },
  {
    usage: "--wrap-command <json>",
    text: 'Run in front of a custom agent: {"command": "...", "args": [...]}',
  },
  { usage: "(no arguments)", text: "Run in front of the Claude adapter" },
  { usage: "-- <cmd> [args...]", text: "Run in front of another ACP agent command" },
  { usage: "mcp", text: "The agent's scheduling tools (the agent starts it)" },
  { usage: "fire <id>", text: "Run by Rewake's timers at a resume's time (safe to run any time)" },
  { usage: "sweep", text: "Run at login by Rewake's login item: sets planned resumes again" },
  { usage: "wait", text: "Rewake's own timer where Linux has no other" },
  { usage: "hook <agent> <event>", text: "Run by an agent's hooks outside Zed" },
];

const INTERNAL_NAMES = ["fire", "sweep", "wait", "hook", "mcp"];

/** Every command name the command line takes (for completion and tests). */
export const COMMAND_NAMES = COMMANDS.map((c) => c.name);

const flagText = (o: OptionInfo) =>
  `${o.alias ? `${o.alias}, ` : ""}${o.flag}${o.arg ? ` ${o.arg}` : ""}`;

/** The top-level help. `all` adds the commands Rewake runs itself. */
export function usageText(all = false): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length)) + 2;
  const lines = [
    `agent-rewake ${VERSION}`,
    "",
    "Resumes your agent threads when a usage limit resets, and sends scheduled messages.",
    "",
    "Commands you run:",
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}${c.summary}`),
    "",
    'Run "agent-rewake <command> --help" for a command\'s options.',
    "  agent-rewake --version",
    "  agent-rewake --help --all   Also the commands Rewake runs itself",
  ];
  if (all) {
    const w = Math.max(...INTERNAL.map((i) => i.usage.length)) + 2;
    lines.push(
      "",
      "Commands Rewake runs itself (you don't type these):",
      ...INTERNAL.map((i) => `  ${i.usage.padEnd(w)}${i.text}`),
      "",
      "In add-on mode, stdout carries the Agent Client Protocol: nothing else is printed there.",
    );
  }
  return lines.join("\n");
}

/** `agent-rewake <command> --help`; undefined for a name that isn't a command. */
export function commandHelp(name: string): string | undefined {
  const c = COMMANDS.find((x) => x.name === name);
  if (!c) {
    if (!INTERNAL_NAMES.includes(name)) return undefined;
    const i = INTERNAL.find((x) => x.usage.split(" ")[0] === name);
    return `Usage: agent-rewake ${i?.usage ?? name}\n\n${i?.text ?? ""}.\nRewake runs this itself: you don't need to type it.`;
  }
  const head = "Usage: agent-rewake ";
  const [firstUsage, ...moreUsage] = c.usage;
  const lines = [
    `${head}${firstUsage}`,
    ...moreUsage.map((u) => `${" ".repeat(head.length)}${u}`),
    "",
    ...c.about,
  ];
  if (c.options.length > 0) {
    const w = Math.max(...c.options.map((o) => flagText(o).length)) + 2;
    lines.push("", "Options:", ...c.options.map((o) => `  ${flagText(o).padEnd(w)}${o.text}`));
  }
  if (c.footer) lines.push("", ...c.footer);
  return lines.join("\n");
}

/** A description safe inside the completion scripts' quotes and brackets. */
const plain = (s: string) => s.replace(/['"`$\\[\]()]/g, "");

/** `agent-rewake completion <shell>`: the script for bash, zsh or fish. */
export function completionScript(shell: (typeof SHELLS)[number]): string {
  const names = COMMANDS.map((c) => c.name);
  if (shell === "bash") {
    const cases = COMMANDS.map((c) => {
      const words = [
        ...c.options.flatMap((o) => [o.flag, ...(o.alias ? [o.alias] : [])]),
        ...(c.words ?? []),
      ];
      return `    ${c.name}) COMPREPLY=( $(compgen -W "${words.join(" ")}" -- "$cur") ) ;;`;
    });
    const values = new Map<string, readonly string[]>();
    for (const c of COMMANDS) for (const o of c.options) if (o.values) values.set(o.flag, o.values);
    const prevCases = [...values].map(
      ([flag, v]) =>
        `    ${flag}) COMPREPLY=( $(compgen -W "${v.join(" ")}" -- "$cur") ); return ;;`,
    );
    return [
      "# bash completion for agent-rewake",
      "_agent_rewake() {",
      `  local cur="\${COMP_WORDS[COMP_CWORD]}" prev="\${COMP_WORDS[COMP_CWORD-1]}"`,
      '  if [ "$COMP_CWORD" -eq 1 ]; then',
      `    COMPREPLY=( $(compgen -W "${[...names, "--help", "--version"].join(" ")}" -- "$cur") )`,
      "    return",
      "  fi",
      '  case "$prev" in',
      ...prevCases,
      "  esac",
      `  case "\${COMP_WORDS[1]}" in`,
      ...cases,
      "  esac",
      "}",
      "complete -F _agent_rewake agent-rewake",
      "",
    ].join("\n");
  }
  if (shell === "zsh") {
    const specs = COMMANDS.map((c) => {
      const args = c.options.map((o) => {
        const forms = o.alias ? `{${o.alias},${o.flag}}` : o.flag;
        const what = o.values === PLACES ? "place" : "name";
        const tail = o.values ? `:${what}:(${o.values.join(" ")})` : o.arg ? ":value:" : "";
        return `        '${forms}[${plain(o.text)}]${tail}'`;
      });
      if (c.words) args.push(`        '1:word:(${c.words.join(" ")})'`);
      return args.length > 0
        ? `    ${c.name}) _arguments \\\n${args.join(" \\\n")} ;;`
        : `    ${c.name}) ;;`;
    });
    return [
      "#compdef agent-rewake",
      "# zsh completion for agent-rewake",
      "_agent_rewake() {",
      "  local -a commands",
      "  commands=(",
      ...COMMANDS.map((c) => `    '${c.name}:${plain(c.summary)}'`),
      "  )",
      "  if (( CURRENT == 2 )); then",
      "    _describe 'command' commands",
      "    return",
      "  fi",
      '  case "$words[2]" in',
      ...specs,
      "  esac",
      "}",
      'if [ "$funcstack[1]" = "_agent_rewake" ]; then _agent_rewake "$@"; else compdef _agent_rewake agent-rewake; fi',
      "",
    ].join("\n");
  }
  const lines = [
    "# fish completion for agent-rewake",
    "complete -c agent-rewake -f",
    ...COMMANDS.map(
      (c) =>
        `complete -c agent-rewake -n '__fish_use_subcommand' -a ${c.name} -d '${plain(c.summary)}'`,
    ),
  ];
  for (const c of COMMANDS) {
    const when = `-n '__fish_seen_subcommand_from ${c.name}'`;
    for (const o of c.options)
      lines.push(
        `complete -c agent-rewake ${when} -l ${o.flag.slice(2)}${o.alias ? ` -s ${o.alias.slice(1)}` : ""}${o.arg ? " -r" : ""}${o.values ? ` -a '${o.values.join(" ")}'` : ""} -d '${plain(o.text)}'`,
      );
    if (c.words) lines.push(`complete -c agent-rewake ${when} -a '${c.words.join(" ")}'`);
  }
  return `${lines.join("\n")}\n`;
}
