import type { Config } from "tailwindcss";
import freebirdPlugin from "@freebirdai/react-tailwind/plugin";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "../../guide/packages/react-tailwind/dist/**/*.{js,mjs}",
  ],
  plugins: [freebirdPlugin],
};
export default config;
