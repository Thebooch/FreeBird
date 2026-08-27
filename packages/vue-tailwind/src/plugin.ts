/**
 * Optional Tailwind plugin that exposes the FreeBird CSS variables as
 * first-class Tailwind colors. This lets you use classes like
 * `bg-freebird-accent` inside your own components while keeping the
 * CSS-variable theming story.
 *
 * Usage in your tailwind.config.ts:
 *
 *   import freebirdPlugin from "@freebirdai/vue-tailwind/plugin";
 *   export default { plugins: [freebirdPlugin] };
 */

type PluginApi = {
  addBase: (styles: Record<string, unknown>) => void;
  addUtilities: (u: Record<string, unknown>) => void;
  theme: (path: string) => unknown;
};

const varColor = (name: string) => `var(--freebird-${name})`;

export const freebirdColors = {
  "freebird-bg": varColor("bg"),
  "freebird-fg": varColor("fg"),
  "freebird-muted": varColor("muted"),
  "freebird-border": varColor("border"),
  "freebird-accent": varColor("accent"),
  "freebird-accent-fg": varColor("accent-fg"),
  "freebird-danger": varColor("danger"),
};

export const freebirdPlugin = ({ addBase, addUtilities }: PluginApi) => {
  addBase({
    ":root": {
      "--freebird-bg": "#ffffff",
      "--freebird-fg": "#111827",
      "--freebird-muted": "#6b7280",
      "--freebird-border": "#e5e7eb",
      "--freebird-accent": "#4f46e5",
      "--freebird-accent-fg": "#ffffff",
      "--freebird-danger": "#dc2626",
      "--freebird-radius": "0.75rem",
      "--freebird-radius-sm": "0.375rem",
    },
    '[data-theme="dark"]': {
      "--freebird-bg": "#0b1020",
      "--freebird-fg": "#e5e7eb",
      "--freebird-muted": "#9ca3af",
      "--freebird-border": "#1f2937",
      "--freebird-accent": "#818cf8",
      "--freebird-accent-fg": "#111827",
      "--freebird-danger": "#f87171",
    },
  });

  addUtilities({
    ".fb-surface": {
      "background-color": "var(--freebird-bg)",
      color: "var(--freebird-fg)",
      border: "1px solid var(--freebird-border)",
      "border-radius": "var(--freebird-radius)",
    },
    ".fb-accent": {
      "background-color": "var(--freebird-accent)",
      color: "var(--freebird-accent-fg)",
    },
  });
};

// Default export a Tailwind plugin descriptor. We don't `require("tailwindcss/plugin")`
// at module scope so the package is safe to import in ESM projects without Tailwind.
const withPluginFactory = () => {
  try {
     
    const pluginFactory = require("tailwindcss/plugin");
    return pluginFactory(freebirdPlugin, {
      theme: {
        extend: {
          colors: freebirdColors,
          borderRadius: {
            freebird: "var(--freebird-radius)",
            "freebird-sm": "var(--freebird-radius-sm)",
          },
        },
      },
    });
  } catch {
    return freebirdPlugin;
  }
};

export default withPluginFactory();
