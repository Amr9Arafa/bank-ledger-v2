import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // AI Inbox photos: the browser shrinks them well below the server's 3 MB check;
      // this leaves room for the text and multipart overhead, under Vercel's 4.5 MB limit.
      bodySizeLimit: "4mb",
    },
  },
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
