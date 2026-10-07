/** Types for test/e2e/mock-llm.mjs. */
export interface MockRequest {
  method: string;
  path: string;
  /** Answered with the agent's usage-limit response. */
  limited: boolean;
  /** The request body. */
  body: string;
  /** The text of each user message in the request, in order. */
  user: string[];
}
export interface Mock {
  url: string;
  set(state: {
    mode?: "ok" | "limit";
    until?: number;
    claim?: "five_hour" | "seven_day";
    profile?: "" | "copilot" | "xai-free" | "xai-402";
    reply?: string;
  }): void;
  /** "METHOD /path" of every request, in order. */
  requests(): string[];
  log(): MockRequest[];
  close(): Promise<void>;
}
export function startMock(): Promise<Mock>;
