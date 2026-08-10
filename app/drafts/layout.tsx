import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Пики героев — TI 2026 Predictor",
  description: "Экспериментальный прогноз карты Dota 2 по командам, пикам героев, синергиям и контрпикам.",
};

export default function DraftsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
