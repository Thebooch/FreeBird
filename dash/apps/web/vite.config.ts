import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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

export default defineConfig({
  plugins: [react()],
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
