import type { Config } from "tailwindcss";
import freebirdPlugin from "@freebirdai/react-tailwind/plugin";

const config: Config = {
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    "../../packages/react-tailwind/dist/**/*.{js,mjs}",
  ],
  plugins: [freebirdPlugin],
};
export default config;
