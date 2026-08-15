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
  title: "TI 2026 Predictor — прогноз всего турнира",
  description: "Живой вероятностный прогноз каждого матча The International 2026: швейцарка, стыки, плей-офф, официальные пары и честная история точности.",
  openGraph: {
    title: "TI 2026 Predictor",
    description: "Прогноз каждого матча TI 2026 — от швейцарки до гранд-финала, с официальными парами и историей точности.",
    type: "website",
    locale: "ru_RU",
    images: [{ url: "/og.png", width: 1728, height: 907, alt: "TI 2026 Predictor" }],
  },
  twitter: { card: "summary_large_image", title: "TI 2026 Predictor", description: "Живой прогноз каждого матча — от швейцарки до гранд-финала.", images: ["/og.png"] },
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
