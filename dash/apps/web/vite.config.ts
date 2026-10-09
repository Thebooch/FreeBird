import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/*
 * Overridable so a scratch instance can be run beside a live one.
 *
 * The chat database is single-instance: a second server against the same
 * `DASH_ROOT` cannot open it and boots with chat disabled, while the port
 * check still passes because the first process is answering. Verifying
 * against a copied root on another port is the way round that, and it needs
 * the web app to be pointable at it.
 */
const PORT = Number(process.env.DASH_WEB_PORT ?? 5400);
const API = process.env.DASH_API_URL ?? "http://localhost:4600";

/*
 * The public pages (`/p/<workspace>/…`: booking, public link, approval) are
 * their own entry, `public.html`, with no Dash shell and no chat. In dev every
 * `/p/` path is answered with it; a host serving the build does the same.
 * The build also gives it a strict content policy: its own scripts only.
 */
const publicPages = (): Plugin => ({
  name: "dash-public-pages",
  configureServer(server) {
    server.middlewares.use((request, _response, next) => {
      if (request.url?.startsWith("/p/")) request.url = "/public.html";
      next();
    });
  },
  transformIndexHtml: {
    order: "post",
    handler(html, context) {
      if (!context.filename.endsWith("public.html") || context.server) return html;
      const policy = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src https://fonts.gstatic.com",
        "img-src 'self' data:",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
      ].join("; ");
      return html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
    },
  },
});

export default defineConfig({
  plugins: [react(), publicPages()],
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        public: fileURLToPath(new URL("./public.html", import.meta.url)),
      },
    },
  },
  server: {
    port: PORT,
    strictPort: true,
    proxy: {
      // Regex key, not a plain prefix: "/api" as a string would also swallow
      // app routes that merely start with those characters.
      "^/api/": {
        target: API,
        changeOrigin: true,
      },
      // Where `@freebirdai/server` is mounted. Chat streams over SSE, so this
      // must not buffer — the default proxy passes the stream through.
      "^/freebird/": {
        target: API,
        changeOrigin: true,
      },
    },
  },
});
