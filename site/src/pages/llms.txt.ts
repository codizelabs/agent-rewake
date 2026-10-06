// /llms.txt (llmstxt.org): a plain list of the docs pages for coding agents that read it.
// Generated from the pages themselves, so it can't go stale. No search engine is known to use it
//; it costs nothing.
import type { APIRoute } from "astro";
import { getCollection } from "astro:content";

export const GET: APIRoute = async ({ site }) => {
  const base = new URL("/agent-rewake/", site);
  const pages = (await getCollection("docs")).sort((a, b) => a.id.localeCompare(b.id));
  const line = (p: (typeof pages)[number]) =>
    `- [${p.data.title}](${new URL(`${p.id}/`, base)}): ${p.data.description ?? ""}`;
  const home = pages.find((p) => p.id === "docs");
  const body = [
    "# Agent Rewake",
    "",
    `> ${home?.data.description ?? ""}`,
    "",
    "Agent Rewake is an independent open-source project, not affiliated with Anthropic or Zed Industries. Source: https://github.com/codizelabs/agent-rewake",
    "",
    `Home: ${base}`,
    `Everything in one file, including how Rewake behaves in every case: ${new URL("llms-full.txt", base)}`,
    "",
    "## Docs",
    "",
    ...pages.map(line),
    "",
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
