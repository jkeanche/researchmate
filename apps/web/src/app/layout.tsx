import type { Metadata, Viewport } from "next";
// Fonts are self-hosted (no third-party requests, works offline and under a strict CSP).
import "@fontsource-variable/literata/index.css";
import "@fontsource-variable/public-sans/index.css";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "ResearchMate AI", template: "%s | ResearchMate AI" },
  description: "Plan, organise and write your research — from first idea to final submission.",
};

export const viewport: Viewport = { themeColor: "#1b2a3a" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
