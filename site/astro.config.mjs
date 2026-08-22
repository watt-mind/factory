// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
  site: "https://watt-mind.github.io",
  base: "/factory",
  vite: {
    // getting-started/quickstart.mdx imports docs/onboarding/connect-repo.md
    // from the repository root with ?raw. `factory onboard` prints the same
    // file, so the onboarding prompt has exactly one copy; without this, dev
    // refuses to serve it (build resolves it either way).
    server: { fs: { allow: [".."] } },
  },
  integrations: [
    starlight({
      title: "factory",
      description:
        "The factory that builds software — and itself. A runtime for self-improving agentic loops.",
      logo: {
        src: "./src/assets/watt-mind-logo.svg",
        alt: "Watt Mind",
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/watt-mind/factory",
        },
      ],
      customCss: ["./src/styles/tokens.css", "./src/styles/custom.css"],
      components: {
        Hero: "./src/components/HomeHero.astro",
      },
      head: [
        {
          tag: "script",
          attrs: {
            src: "/factory/diagrams/theme-sync.js",
            defer: true,
          },
        },
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [{ autogenerate: { directory: "getting-started" } }],
        },
        {
          label: "Core Concepts",
          items: [{ autogenerate: { directory: "concepts" } }],
        },
        {
          label: "Harnesses & Models",
          items: [{ autogenerate: { directory: "harnesses" } }],
        },
        {
          label: "Packs & Extensions",
          items: [{ autogenerate: { directory: "packs" } }],
        },
        {
          label: "Operator Guide",
          items: [{ autogenerate: { directory: "operator" } }],
        },
        {
          label: "Contributor Hub",
          items: [{ autogenerate: { directory: "contributing" } }],
        },
        {
          label: "Reference",
          items: [{ autogenerate: { directory: "reference" } }],
        },
      ],
    }),
  ],
});
