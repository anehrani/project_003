import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "BudgetGuard — Autopilot for Meta Budget",
  description:
    "Give us your ad + budget. We spend it optimally on Meta, 24/7. BudgetGuard pauses losers, scales winners and hard-caps your spend — no rule builder required.",
  keywords: [
    "Meta ads",
    "Facebook ads automation",
    "ad budget guard",
    "ROAS",
    "autopilot bidding",
    "Shopify ads",
  ],
  openGraph: {
    title: "BudgetGuard — Autopilot for Meta Budget",
    description:
      "Pauses losers. Scales winners. Hard-caps your spend while you sleep.",
    siteName: "BudgetGuard",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
      </body>
    </html>
  );
}
