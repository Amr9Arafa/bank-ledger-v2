import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

// Finds src/i18n/request.ts and wires it into every request.
const withNextIntl = createNextIntlPlugin();
export default withNextIntl(nextConfig);
