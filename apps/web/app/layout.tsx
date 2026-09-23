import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shasanadesh Assistant",
  description:
    "Evidence-grounded search and Q&A for Uttar Pradesh government orders",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
