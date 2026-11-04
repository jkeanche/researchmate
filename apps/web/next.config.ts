import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

const csp = [
  "default-src 'self'",
  // Next.js injects inline bootstrap scripts; eval is only needed by the dev server.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  `connect-src 'self'${isDev ? " ws:" : ""}`,
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
];

const config: NextConfig = {
  output: "standalone",
  // Monorepo: trace workspace packages from the repository root.
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
  // Local storage lives outside the build; never bundle uploaded research files.
  // Citation styles and locales are read from disk at runtime.
  outputFileTracingIncludes: { "*": ["../../packages/citations/csl/**"] },
  outputFileTracingExcludes: { "*": [".data/**", "**/.data/**", "tests/**"] },
  poweredByHeader: false,
  transpilePackages: [
    "@researchmate/admin",
    "@researchmate/ai",
    "@researchmate/auth",
    "@researchmate/citations",
    "@researchmate/collaboration",
    "@researchmate/database",
    "@researchmate/documents",
    "@researchmate/entitlements",
    "@researchmate/finance",
    "@researchmate/integrations",
    "@researchmate/literature",
    "@researchmate/planning",
    "@researchmate/research",
    "@researchmate/shared",
    "@researchmate/storage",
    "@researchmate/tenancy",
    "@researchmate/toolkit",
  ],
  serverExternalPackages: ["@modelcontextprotocol/sdk", "docx", "citeproc", "pdfjs-dist", "mammoth", "@mastra/core", "pdfkit", "exceljs", "pptxgenjs", "@node-rs/argon2", "postgres", "ioredis", "bullmq"],
  experimental: {
    serverActions: { bodySizeLimit: "1mb" },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default config;
