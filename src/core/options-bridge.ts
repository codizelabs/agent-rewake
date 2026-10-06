/**
 * The Rewake menu for every agent.
 *
 * Zed shows an agent's toolbar options only if the session starts with them, and once a session
 * has any options it hides the agent's older mode picker. So for an agent that offers only the older `modes` and
 * `models` (Gemini CLI, Zed's older Claude adapter, deepagents…), Rewake shows them as toolbar
 * options itself, beside its menu, and translates a pick back to `session/set_mode` or
 * `session/set_model`. Nothing the agent had is lost, and Zed (which has no model picker for these
 * agents, Z-c) now shows one.
 */

/** The ids Rewake gives the options it makes from `modes` and `models`. */
export const BRIDGED_MODE_ID = "mode";
export const BRIDGED_MODEL_ID = "model";

export interface Bridge {
  /** The legacy mode ids the agent accepts, if it has modes. */
  modes?: Set<string>;
  /** The legacy model ids the agent accepts, if it has models. */
  models?: Set<string>;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * The agent's options as Rewake will show them, from a `session/new`, `load` or `resume` result.
 * Agents with their own `configOptions` are left as they are (`bridge` undefined). Otherwise the
 * result's `modes` and `models` become a Mode and a Model select; with neither, the list is empty.
 */
export function bridgeOptions(result: unknown): { options: unknown[]; bridge?: Bridge } {
  const r = obj(result);
  if (Array.isArray(r.configOptions)) return { options: r.configOptions };
  const options: unknown[] = [];
  const bridge: Bridge = {};

  const modes = obj(r.modes);
  const availableModes = Array.isArray(modes.availableModes) ? modes.availableModes : [];
  const modeChoices = availableModes
    .map((m) => ({
      value: str(obj(m).id),
      name: str(obj(m).name),
      description: obj(m).description,
    }))
    .filter(
      (m): m is { value: string; name: string | undefined; description: unknown } => !!m.value,
    );
  if (modeChoices.length > 0) {
    bridge.modes = new Set(modeChoices.map((m) => m.value));
    const current = str(modes.currentModeId) ?? modeChoices[0]?.value;
    options.push(select(BRIDGED_MODE_ID, "Mode", "mode", current, modeChoices));
  }

  const models = obj(r.models);
  const availableModels = Array.isArray(models.availableModels) ? models.availableModels : [];
  const modelChoices = availableModels
    .map((m) => ({
      value: str(obj(m).modelId),
      name: str(obj(m).name),
      description: obj(m).description,
    }))
    .filter(
      (m): m is { value: string; name: string | undefined; description: unknown } => !!m.value,
    );
  if (modelChoices.length > 0) {
    bridge.models = new Set(modelChoices.map((m) => m.value));
    const current = str(models.currentModelId) ?? modelChoices[0]?.value;
    options.push(select(BRIDGED_MODEL_ID, "Model", "model", current, modelChoices));
  }
  return { options, bridge };
}

function select(
  id: string,
  name: string,
  category: string,
  currentValue: string | undefined,
  choices: Array<{ value: string; name: string | undefined; description: unknown }>,
): Obj {
  return {
    id,
    name,
    category,
    type: "select",
    currentValue,
    options: choices.map((c) => ({
      value: c.value,
      name: c.name ?? c.value,
      ...(typeof c.description === "string" && c.description && { description: c.description }),
    })),
  };
}

/** The legacy request that a pick in a bridged option stands for, or undefined if it isn't one. */
export function legacyRequest(
  bridge: Bridge | undefined,
  sessionId: string,
  configId: unknown,
  value: unknown,
): { method: string; params: Obj } | undefined {
  if (!bridge || typeof value !== "string") return undefined;
  if (configId === BRIDGED_MODE_ID && bridge.modes?.has(value))
    return { method: "session/set_mode", params: { sessionId, modeId: value } };
  if (configId === BRIDGED_MODEL_ID && bridge.models?.has(value))
    return { method: "session/set_model", params: { sessionId, modelId: value } };
  return undefined;
}

/** The options with one bridged option's current value changed. */
export function withValue(options: unknown[], id: string, value: string): unknown[] {
  return options.map((o) => (obj(o).id === id ? { ...obj(o), currentValue: value } : o));
}
