import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CloudAIr",
  description:
    "The access layer between your website and AI agents: llms.txt, MCP endpoints, agent analytics, and rate limiting.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
