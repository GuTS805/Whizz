import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Whizz — snap money to your friends",
  description: "Send money like a snap. Built on Monad.",
  appleWebApp: { capable: true, title: "Whizz", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full bg-black antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
