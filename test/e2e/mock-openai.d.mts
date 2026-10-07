/** Types for test/e2e/mock-openai.mjs. */
export interface OpenAiMock {
  url: string;
  set(state: { mode?: "ok" | "limit" }): void;
  requests(): string[];
  close(): Promise<void>;
}
export function startOpenAiMock(): Promise<OpenAiMock>;
