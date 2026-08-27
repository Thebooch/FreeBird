import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  mainSidebar: [
    "intro",
    "quickstart",
    {
      type: "category",
      label: "Concepts",
      items: [
        "concepts/component-registry",
        "concepts/chat-engine",
        "concepts/actions",
        "concepts/layout-solver",
        "concepts/locking-and-tabs",
        "concepts/knowledge-and-references",
        "concepts/digests",
        "concepts/support",
        "concepts/conversation-review",
      ],
    },
    {
      type: "category",
      label: "Frameworks",
      items: [
        "packages/react",
        "packages/react-tailwind",
        "frameworks/vue",
        "frameworks/angular",
        "frameworks/embed-widget",
      ],
    },
    {
      type: "category",
      label: "Server & data",
      items: [
        "packages/core",
        "packages/server",
        "server/multi-tenancy-and-auth",
        "packages/adapters",
        "packages/digest-worker",
        "packages/core-state",
      ],
    },
    {
      type: "category",
      label: "Tooling",
      items: [
        "tooling/manifest-and-codegen",
        "tooling/create-freebird",
        "tooling/mcp",
      ],
    },
    {
      type: "category",
      label: "Integrations",
      items: ["integrations/wordpress"],
    },
    "recipes",
    "contributing",
  ],
};

export default sidebars;
