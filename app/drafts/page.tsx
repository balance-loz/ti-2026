"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext uses native navigation in this project. */

import { useEffect } from "react";

export default function DraftsRedirectPage() {
  useEffect(() => { window.location.replace("/#live"); }, []);
  return <main className="fusion-page fusion-route-redirect"><div><b>Draft Lab переехал</b><p>Live-пики, график и объяснение модели теперь находятся на единой главной.</p><a href="/#live">Открыть live-раздел</a></div></main>;
}
