// A local stand-in for an OpenAI-style chat completions API (Copilot CLI's offline BYOK
// provider; research testing-harness §2.4). `set({ mode: "limit" })` answers 429 with Copilot's
// coded weekly limit; "ok" answers RESUMED_OK. Records method and path only.
import { createServer } from "node:http";

export function startOpenAiMock() {
  const state = { mode: "ok", requests: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      state.requests.push(`${req.method} ${(req.url ?? "").split("?")[0]}`);
      if (state.mode === "limit") {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "Sorry, you've exceeded your weekly rate limit.",
              code: "user_weekly_rate_limited",
              type: "user_weekly_rate_limited",
            },
          }),
        );
        return;
      }
      const chunk = (delta, finish) =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-4.1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      if (body.includes('"stream":true')) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(chunk({ role: "assistant", content: "RESUMED_OK" }, null));
        res.write(chunk({}, "stop"));
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          created: 1,
          model: "gpt-4.1",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "RESUMED_OK" },
              finish_reason: "stop",
            },
          ],
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1`,
        set: (s) => Object.assign(state, s),
        requests: () => [...state.requests],
        close: () => new Promise((r) => server.close(() => r(undefined))),
      });
    });
  });
}
