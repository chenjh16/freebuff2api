import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "freebuff2api — OpenAI-compatible Freebuff API",
  description:
    "OpenAI-compatible reverse proxy for the Freebuff coding API. One endpoint, free models, streaming support.",
  metadataBase: new URL("https://freebuff2api.freebuff.app"),
  openGraph: {
    title: "freebuff2api",
    description: "OpenAI-compatible reverse proxy for the Freebuff coding API.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#070b14",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
