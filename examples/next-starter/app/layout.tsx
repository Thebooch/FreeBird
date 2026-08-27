import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "FreeBird — Next starter",
  description: "An AI-driven website backbone, wired up with FreeBird.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
