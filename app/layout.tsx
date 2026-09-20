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

const TITLE = "Dota Predictor — автоматический прогноз турниров";
const DESCRIPTION = "Система сама находит новые турниры Dota 2, каждый день собирает сыгранные матчи, переобучается на статистике и прогнозирует каждую серию — от первого матча до чемпиона. Идущие матчи оцениваются по пикам героев.";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL || "http://localhost"),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: "Dota Predictor",
    description: DESCRIPTION,
    type: "website",
    locale: "ru_RU",
    images: [{ url: "/og.png", width: 1728, height: 907, alt: "Dota Predictor" }],
  },
  twitter: { card: "summary_large_image", title: "Dota Predictor", description: DESCRIPTION, images: ["/og.png"] },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: "try{document.documentElement.dataset.theme=localStorage.getItem('ti26-theme')==='dark'?'dark':'light'}catch{}" }} />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
