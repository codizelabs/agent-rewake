// Documentation site for Agent Rewake. Starlight, static output, Pagefind search.
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

const SITE = "https://codizelabs.github.io";
const BASE = "/agent-rewake";
const SOCIAL_IMAGE = `${SITE}${BASE}/social-preview.png`;
const SOCIAL_ALT =
  "Agent Rewake: your Zed agent threads resume on their own when a usage limit resets.";

// Search-engine ownership tags. The values are public; the owner sets
// them as repository variables, and the tags are left out until then.
const verification = [
  ["google-site-verification", process.env.GOOGLE_SITE_VERIFICATION],
  ["msvalidate.01", process.env.BING_SITE_VERIFICATION],
]
  .filter(([, content]) => content)
  .map(([name, content]) => ({ tag: "meta", attrs: { name, content } }));

export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: "always",
  // The site used to have one page per topic; old links land on the matching section.
  redirects: Object.fromEntries(
    [
      ["overview", ""],
      ["start", "install"],
      ["guides/resume-after-limit", "resume-after-a-usage-limit"],
      ["usage-limits-in-zed", "resume-after-a-usage-limit"],
      ["guides/schedule-message", "schedule-a-message"],
      ["guides/manage-schedules", "see-and-change-scheduled-messages"],
      ["guides/uninstall", "uninstall"],
      ["agents", "agents"],
      ["how-it-works", ""],
      ["architecture", ""],
      ["security", "privacy-and-security"],
      ["faq", "troubleshooting"],
      ["status", "status"],
      ["accessibility", "status"],
      ["reference", "reference"],
    ].map(([from, to]) => [`/${from}/`, `${BASE}/docs/${to ? `#${to}` : ""}`]),
  ),
  integrations: [
    starlight({
      title: "Agent Rewake",
      logo: { src: "./src/assets/logo.svg" },
      description:
        "Resume Claude, Codex or any Zed agent automatically when its usage limit resets, and schedule messages into your threads. Independent, open source, pre-release.",
      // One image for GitHub's social preview, Open Graph and X.
      head: [
        { tag: "meta", attrs: { property: "og:image", content: SOCIAL_IMAGE } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1280" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "640" } },
        { tag: "meta", attrs: { property: "og:image:alt", content: SOCIAL_ALT } },
        { tag: "meta", attrs: { name: "twitter:image", content: SOCIAL_IMAGE } },
        { tag: "meta", attrs: { name: "twitter:image:alt", content: SOCIAL_ALT } },
        ...verification,
      ],
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/codizelabs/agent-rewake" },
        { icon: "npm", label: "npm", href: "https://www.npmjs.com/package/@codizelabs/agent-rewake" },
      ],
      components: { Footer: "./src/components/Footer.astro" },
      editLink: { baseUrl: "https://github.com/codizelabs/agent-rewake/edit/main/site/" },
      lastUpdated: true,
      customCss: ["./src/styles/tokens.css", "./src/styles/zed.css", "./src/styles/starlight.css"],
      // One docs page (owner, 2026-10-05: the landing page covers the rest).
      sidebar: [
        "docs",
        { label: "Contributing", link: "https://github.com/codizelabs/agent-rewake/blob/main/CONTRIBUTING.md" },
      ],
    }),
  ],
});
