// A local stand-in for Anthropic's Messages API (research testing-harness §2.1, §3), so agents
// run offline in tests. Modes, set with POST /__mock {mode, until, claim}:
//   ok     — every request answers "RESUMED_OK";
//   limit  — until `until` (ms), 429 with the subscriber headers Claude Code reads
//            (anthropic-ratelimit-unified-*), then ok.
// It records each request's method and path (GET /__mock/requests), never bodies.
import { createServer } from "node:http";

export function startMock() {
  const state = { mode: "ok", until: 0, claim: "five_hour", requests: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      if (path === "/__mock" && req.method === "POST") {
        Object.assign(state, JSON.parse(body || "{}"));
        res.writeHead(204).end();
        return;
      }
      if (path === "/__mock/requests") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(state.requests));
        return;
      }
      state.requests.push(`${req.method} ${path}`);
      if (req.method === "HEAD" || path === "/api/hello") {
        res.writeHead(200).end();
        return;
      }
      if (path.endsWith("/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      if (!path.startsWith("/v1/messages")) {
        res.writeHead(404).end();
        return;
      }
      const now = Date.now();
      if (state.mode === "limit" && now < state.until) {
        const reset = String(Math.ceil(state.until / 1000));
        const short = state.claim === "seven_day" ? "7d" : "5h";
        res.writeHead(429, {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-reset": reset,
          "anthropic-ratelimit-unified-representative-claim": state.claim,
          [`anthropic-ratelimit-unified-${short}-status`]: "rejected",
          [`anthropic-ratelimit-unified-${short}-reset`]: reset,
          [`anthropic-ratelimit-unified-${short}-utilization`]: "1.0",
          "retry-after": String(Math.max(1, Math.ceil((state.until - now) / 1000))),
          "x-should-retry": "false",
        });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "Rate limited (mock)" },
          }),
        );
        return;
      }
      let stream = false;
      try {
        stream = JSON.parse(body).stream === true;
      } catch {
        // Not JSON: answer plainly.
      }
      const message = {
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: "claude-mock",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      };
      if (!stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ...message,
            content: [{ type: "text", text: "RESUMED_OK" }],
            stop_reason: "end_turn",
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", { type: "message_start", message });
      send("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      send("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "RESUMED_OK" },
      });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 3 },
      });
      send("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        set: (s) => Object.assign(state, s),
        requests: () => [...state.requests],
        close: () => new Promise((r) => server.close(() => r(undefined))),
      });
    });
  });
}
