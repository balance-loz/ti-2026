import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin", "cyrillic"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin", "cyrillic"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL || "http://159.194.202.215"),
  title: "TI 2026 Predictor — швейцарка и плей-офф",
  description: "Вероятностный прогноз The International 2026: 100 000 симуляций, живая швейцарка, стыки, история модели и плей-офф.",
  openGraph: {
    title: "TI 2026 Predictor",
    description: "Швейцарка, стыки и плей-офф — с живыми результатами и историей прогнозов.",
    type: "website",
    locale: "ru_RU",
    images: [{ url: "/og.png", width: 1728, height: 907, alt: "TI 2026 Predictor" }],
  },
  twitter: { card: "summary_large_image", title: "TI 2026 Predictor", description: "100 000 симуляций швейцарки, стыков и плей-офф.", images: ["/og.png"] },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
