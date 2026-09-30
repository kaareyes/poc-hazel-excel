import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AR Intelligence",
  description: "Turn your existing AR reports into actionable collections intelligence.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
