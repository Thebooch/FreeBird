import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "FreeBird",
  tagline: "AI-driven website backbone — chat, dynamic layouts, saved tabs, digests.",
  url: "https://freebird.dev",
  baseUrl: "/",
  favicon: "img/favicon.ico",
  organizationName: "Thebooch",
  projectName: "FreeBird",
  trailingSlash: false,
  onBrokenLinks: "warn",
  markdown: { hooks: { onBrokenMarkdownLinks: "warn" } },
  i18n: { defaultLocale: "en", locales: ["en"] },
  presets: [
    [
      "classic",
      {
        docs: {
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
          editUrl: "https://github.com/Thebooch/FreeBird/tree/main/docs/",
        },
        blog: false,
        theme: { customCss: "./src/css/custom.css" },
      } satisfies Preset.Options,
    ],
  ],
  themeConfig: {
    navbar: {
      title: "FreeBird",
      items: [
        { type: "docSidebar", sidebarId: "mainSidebar", position: "left", label: "Docs" },
        { href: "https://github.com/Thebooch/FreeBird", label: "GitHub", position: "right" },
      ],
    },
    footer: {
      style: "dark",
      copyright: `MIT © ${new Date().getFullYear()} FreeBird contributors.`,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
