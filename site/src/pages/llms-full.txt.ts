// /llms-full.txt: the agent guide (src/guide.ts, the same text the agent's about_rewake tool
// returns) followed by every docs page, for assistants that read one file. Generated at build time.
import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { AGENT_GUIDE } from "../../../src/guide.ts";

export const GET: APIRoute = async ({ site }) => {
  const base = new URL("/", site);
  const pages = (await getCollection("docs")).sort((a, b) => a.id.localeCompare(b.id));
  const body = [
    AGENT_GUIDE.trim(),
    "",
    ...pages.flatMap((p) => [
      "",
      "---",
      "",
      `# ${p.data.title}`,
      "",
      `Source: ${new URL(`${p.id}/`, base)}`,
      "",
      // MDX imports and components are left out; the prose and tables stay.
      (p.body ?? "")
        .split("\n")
        .filter((l) => !/^import\s/.test(l) && !/^<[A-Z]/.test(l.trim()))
        .join("\n")
        .trim(),
    ]),
    "",
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
