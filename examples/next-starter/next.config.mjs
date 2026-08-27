/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@freebirdai/core",
    "@freebirdai/react",
    "@freebirdai/react-tailwind",
    "@freebirdai/server",
    "@freebirdai/adapters-llm-openai",
  ],
};
export default nextConfig;
