// A local stand-in for the model APIs the agents call (research testing-harness §2, §3), so the
// real agent programs run offline in tests. It serves Anthropic Messages, OpenAI Responses and
// Chat Completions (Codex, Copilot, Grok) and Gemini generateContent, each either answering
// `reply` or refusing with that agent's own usage-limit response until `until` (ms).
// Set the state with `set()` (or POST /__mock): mode "ok" | "limit", until, claim (Claude's
// window: five_hour | seven_day) and profile, the limit's wire format when the path alone doesn't
// say: "copilot" (a weekly limit), "xai-free" or "xai-402" (Grok). It records each request's method,
// path, whether it was refused, its body and the text of its user messages (made-up test data);
// for Anthropic Messages also Claude Code's session id and the last user message's text.
// Codex signed in with ChatGPT also reads its usage from the mock (`chatgpt_base_url` =
// `<url>/backend-api`), from the same state.
import { createServer } from "node:http";

const sec = (ms) => Math.floor(ms / 1000);
const left = (until) => Math.max(1, sec(until - Date.now()));

/** Each agent's usage-limit response, by wire. */
const LIMITS = {
  anthropic: (s) => {
    const reset = String(Math.ceil(s.until / 1000));
    const short = s.claim === "seven_day" ? "7d" : "5h";
    return {
      status: 429,
      headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": reset,
        "anthropic-ratelimit-unified-representative-claim": s.claim,
        [`anthropic-ratelimit-unified-${short}-status`]: "rejected",
        [`anthropic-ratelimit-unified-${short}-reset`]: reset,
        [`anthropic-ratelimit-unified-${short}-utilization`]: "1.0",
        "retry-after": String(left(s.until)),
        "x-should-retry": "false",
      },
      body: { type: "error", error: { type: "rate_limit_error", message: "Rate limited (mock)" } },
    };
  },
  // Codex: `usage_limit_reached` is what makes it a usage limit, not a retry (research §2.2).
  openai: (s) => ({
    status: 429,
    headers: {
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": String(sec(s.until)),
    },
    body: {
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
        plan_type: "plus",
        limit_window_minutes: 300,
        resets_at: sec(s.until),
        resets_in_seconds: left(s.until),
      },
    },
  }),
  copilot: () => ({
    status: 429,
    headers: { "x-github-request-id": "MOCK:REQ" },
    body: {
      error: {
        message: "Sorry, you've exceeded your weekly rate limit.",
        code: "user_weekly_rate_limited",
        type: "user_weekly_rate_limited",
      },
    },
  }),
  xai: (s) =>
    s.profile === "xai-402"
      ? {
          status: 402,
          headers: {},
          body: { code: "payment_required", error: "You have run out of credits (mock)." },
        }
      : {
          status: 429,
          headers: {},
          body: {
            code: "subscription:free-usage-exhausted",
            error: "Free usage exhausted (mock).",
          },
        },
  // Gemini CLI fails fast only on the "Individual quota" wording; the default one it retries
  // quietly (research §2.3).
  gemini: (s) => ({
    status: 429,
    headers: {},
    body: {
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: `Individual quota reached. Resets in ${left(s.until)}s.`,
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "QUOTA_EXHAUSTED",
            domain: "cloudcode-pa.googleapis.com",
            metadata: {
              quotaResetDelay: `${left(s.until)}s`,
              quotaResetTimeStamp: new Date(s.until).toISOString(),
            },
          },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: `${left(s.until)}s` },
        ],
      },
    },
  }),
};

/** Codex's usage endpoint (`<chatgpt_base_url>/wham/usage`): the same limit, as a usage window. */
function codexUsage(refused, s) {
  const reset = refused ? s.until : Date.now() + 5 * 3_600_000;
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: !refused,
      limit_reached: refused,
      primary_window: {
        used_percent: refused ? 100 : 0,
        limit_window_seconds: 18_000,
        reset_after_seconds: left(reset),
        reset_at: sec(reset),
      },
      secondary_window: null,
    },
  };
}

/** The text of a message's content: a string, or the text of each of its parts. */
const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("")
      : "";

/** The user messages of a request, in order: Chat Completions, Responses, Messages or Gemini. */
function userTexts(body) {
  const turns = body.messages ?? (Array.isArray(body.input) ? body.input : body.contents) ?? [];
  if (!Array.isArray(turns)) return [];
  return turns
    .filter((m) => m?.role === "user")
    .map((m) => textOf(m.content ?? m.parts))
    .filter(Boolean);
}

/** The usage-limit response for a request: by its API family, and the profile on OpenAI's wire. */
function limitFor(family, s) {
  if (family === "anthropic") return LIMITS.anthropic(s);
  if (family === "gemini") return LIMITS.gemini(s);
  if (s.profile === "copilot") return LIMITS.copilot(s);
  if (s.profile.startsWith("xai")) return LIMITS.xai(s);
  return LIMITS.openai(s);
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const [event, data] of events)
    res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
  res.end();
};

function anthropic(res, req, text) {
  const usage = { input_tokens: 10, output_tokens: 3 };
  const message = {
    id: "msg_mock",
    type: "message",
    role: "assistant",
    model: "claude-mock",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage,
  };
  if (req.stream !== true)
    return json(res, 200, {
      ...message,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
    });
  sse(res, [
    ["message_start", { type: "message_start", message }],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage },
    ],
    ["message_stop", { type: "message_stop" }],
  ]);
}

function responses(res, req, text) {
  const item = {
    id: "msg_mock",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const done = {
    id: "resp_mock",
    object: "response",
    status: "completed",
    model: req.model ?? "mock-model",
    output: [item],
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 12,
    },
  };
  if (req.stream !== true) return json(res, 200, done);
  sse(res, [
    [
      "response.created",
      { type: "response.created", response: { ...done, status: "in_progress", output: [] } },
    ],
    [
      "response.output_item.added",
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      },
    ],
    [
      "response.output_text.delta",
      {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: text,
      },
    ],
    ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
    ["response.completed", { type: "response.completed", response: done }],
  ]);
}

function chat(res, req, text) {
  const base = {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: sec(Date.now()),
    model: req.model ?? "mock-model",
  };
  const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
  if (req.stream !== true)
    return json(res, 200, {
      ...base,
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage,
    });
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (choice, extra = {}) =>
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, ...choice }], ...extra })}\n\n`,
    );
  chunk({ delta: { role: "assistant", content: text }, finish_reason: null });
  chunk({ delta: {}, finish_reason: "stop" }, { usage });
  res.end("data: [DONE]\n\n");
}

function gemini(res, path, req, reply) {
  const gc = req.generationConfig ?? {};
  // Gemini CLI's router asks for JSON first; its schema wants a complexity score.
  const text =
    gc.responseMimeType !== "application/json"
      ? reply
      : JSON.stringify(gc.responseJsonSchema ?? gc.responseSchema ?? {}).includes(
            "complexity_score",
          )
        ? JSON.stringify({ complexity_reasoning: "mock", complexity_score: 10 })
        : "{}";
  const body = {
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
    modelVersion: "mock",
  };
  if (path.includes(":streamGenerateContent")) return sse(res, [[null, body]]);
  json(res, 200, body);
}

/** Claude Code's session id (in metadata.user_id) and the text of the last user message. */
function anthropicContext(req) {
  let session;
  try {
    session = JSON.parse(req.metadata?.user_id ?? "{}").session_id;
  } catch {
    // Not Claude Code's JSON user id.
  }
  const last = (Array.isArray(req.messages) ? req.messages : []).findLast((m) => m.role === "user");
  const content = last?.content;
  const prompt =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n")
        : undefined;
  return { session, prompt: prompt?.slice(-4000) };
}

export function startMock() {
  const state = {
    mode: "ok",
    until: 0,
    claim: "five_hour",
    profile: "",
    reply: "RESUMED_OK",
    log: [],
  };
  const limited = () => state.mode === "limit" && Date.now() < state.until;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        // Not JSON: answer plainly.
      }
      if (path === "/__mock" && req.method === "POST") {
        Object.assign(state, body);
        res.writeHead(204).end();
        return;
      }
      if (path === "/__mock/requests") return json(res, 200, state.log);
      const family = /\/messages/.test(path)
        ? "anthropic"
        : /generatecontent|counttokens/i.test(path)
          ? "gemini"
          : /\/responses|\/chat\/completions/.test(path)
            ? "openai"
            : undefined;
      const refused =
        family !== undefined && limited() && !/count_?tokens/i.test(path) && req.method === "POST";
      state.log.push({
        method: req.method,
        path,
        limited: refused,
        body: raw,
        user: userTexts(body),
        ...(family === "anthropic" && anthropicContext(body)),
      });
      if (req.method === "HEAD" || path === "/api/hello") return res.writeHead(200).end();
      if (/\/messages\/count_tokens$/.test(path)) return json(res, 200, { input_tokens: 10 });
      if (/:countTokens$/.test(path)) return json(res, 200, { totalTokens: 10 });
      if (refused) {
        const l = limitFor(family, state);
        return json(res, l.status, l.body, l.headers);
      }
      if (family === "anthropic") return anthropic(res, body, state.reply);
      if (path.includes("/responses")) return responses(res, body, state.reply);
      if (path.includes("/chat/completions")) return chat(res, body, state.reply);
      if (family === "gemini") return gemini(res, path, body, state.reply);
      // Grok lists models first and needs these fields on each (research §2.5).
      if (path.endsWith("/models"))
        return json(res, 200, {
          object: "list",
          data: [
            {
              id: "mock-model",
              object: "model",
              created: 1_700_000_000,
              owned_by: "mock",
              context_length: 128_000,
            },
          ],
        });
      if (path.endsWith("/api-key")) return json(res, 200, { api_key_id: "mock", acls: [] });
      // Codex signed in with ChatGPT reads its usage here (`account/rateLimits/read`).
      if (/\/(wham|api\/codex)\/usage$/.test(path))
        return json(res, 200, codexUsage(limited(), state));
      if (path === "/") return json(res, 200, {});
      json(res, 404, { error: { message: `mock: no route for ${path}` } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        set: (s) => Object.assign(state, s),
        requests: () => state.log.map((r) => `${r.method} ${r.path}`),
        log: () => state.log.map((r) => ({ ...r })),
        close: () => new Promise((r) => server.close(() => r(undefined))),
      });
    });
  });
}
