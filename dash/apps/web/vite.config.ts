import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5400,
    strictPort: true,
    proxy: {
      // Regex key, not a plain prefix: "/api" as a string would also swallow
      // app routes that merely start with those characters.
      "^/api/": {
        target: "http://localhost:4600",
        changeOrigin: true,
      },
      // Where `@freebirdai/server` is mounted. Chat streams over SSE, so this
      // must not buffer — the default proxy passes the stream through.
      "^/freebird/": {
        target: "http://localhost:4600",
        changeOrigin: true,
      },
    },
  },
});
