"use client";
/* eslint-disable @next/next/no-html-link-for-pages, @next/next/no-img-element -- vinext uses native navigation here. */

import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import type { HeroCatalog, TeamRef } from "../lib/api";

const THEME_KEY = "ti26-theme";

// The theme lives on <html>, written by the inline script in the layout before
// React hydrates. It is external state, so it is read through a store rather
// than mirrored into component state.
const themeListeners = new Set<() => void>();
const subscribeTheme = (onChange: () => void) => {
  themeListeners.add(onChange);
  return () => { themeListeners.delete(onChange); };
};
const readTheme = () => (typeof document === "undefined" ? "light"
  : document.documentElement.dataset.theme === "dark" ? "dark" : "light");

function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "light" as const);

  const toggle = useCallback(() => {
    const next = readTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode or blocked storage */ }
    for (const listener of themeListeners) listener();
  }, []);

  return (
    <button type="button" className="dp-theme-toggle" onClick={toggle} aria-label="Переключить тему">
      {theme === "dark" ? "Тёмная" : "Светлая"}
    </button>
  );
}

export function TopBar({ live = 0 }: { live?: number }) {
  return (
    <header className="dp-topbar">
      <a className="dp-brand" href="/">
        <span className="dp-brand-glyph">D</span>
        Dota Predictor
      </a>
      <nav className="dp-nav">
        <a href="/">Турниры</a>
        <a href="/live">Live</a>
        <a href="/model">Модель</a>
      </nav>
      <div className="dp-topbar-right">
        {live > 0 ? (
          <span className="dp-live-pill"><i />{live} в эфире</span>
        ) : (
          <span className="dp-live-pill dp-live-pill-idle">нет матчей</span>
        )}
        <ThemeToggle />
      </div>
    </header>
  );
}

/**
 * A team, linked to its own page whenever we know which team it is. Bracket
 * slots and unresolved names have no id, so those stay plain text.
 */
export function Team({ team, compact = false, link = true }: { team: TeamRef; compact?: boolean; link?: boolean }) {
  const body = (
    <>
      {team.logoUrl ? <img src={team.logoUrl} alt="" loading="lazy" /> : <span className="dp-team-dot" />}
      <b>{team.name}</b>
    </>
  );
  const className = compact ? "dp-team dp-team-compact" : "dp-team";
  if (!link || !team.id || !/^\d+$/.test(team.id)) return <span className={className}>{body}</span>;
  return <a className={`${className} dp-team-link`} href={`/team/${team.id}`}>{body}</a>;
}

/**
 * The five picks of one side. The side label matters because the picks wrap
 * onto several lines, so colour alone does not separate the two teams.
 */
export function HeroStrip({ picks, side, heroes }: { picks: number[]; side: "radiant" | "dire"; heroes: HeroCatalog }) {
  return (
    <div className={`dp-heroes dp-heroes-${side}`}>
      <span className="dp-side-label">{side === "radiant" ? "Radiant" : "Dire"}</span>
      {picks?.length
        ? picks.map((heroId) => {
          const hero = heroes[String(heroId)];
          return (
            <span key={heroId} className="dp-hero-chip" title={hero?.name ?? `hero ${heroId}`}>
              {hero?.image ? <img src={hero.image} alt="" loading="lazy" /> : null}
              {hero?.name ?? heroId}
            </span>
          );
        })
        : <span className="dp-muted dp-small">пики ещё не открыты</span>}
    </div>
  );
}

export function ProbabilityBar({ probabilityA, labelA, labelB }: { probabilityA: number; labelA?: string; labelB?: string }) {
  const a = Math.max(0, Math.min(1, probabilityA));
  return (
    <div className="dp-bar" role="img" aria-label={`${(a * 100).toFixed(1)}% против ${((1 - a) * 100).toFixed(1)}%`}>
      <div className="dp-bar-fill" style={{ width: `${a * 100}%` }} />
      <span className="dp-bar-a">{labelA ?? `${(a * 100).toFixed(0)}%`}</span>
      <span className="dp-bar-b">{labelB ?? `${((1 - a) * 100).toFixed(0)}%`}</span>
    </div>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "live" | "good" | "bad" | "warn"; children: ReactNode }) {
  return <span className={`dp-badge dp-badge-${tone}`}>{children}</span>;
}

export function Panel({ title, subtitle, actions, children }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="dp-panel">
      <header className="dp-panel-head">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="dp-empty">
      <b>{title}</b>
      {hint ? <p>{hint}</p> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="dp-empty dp-empty-error">
      <b>Не удалось загрузить данные</b>
      <p>{error}</p>
      {onRetry ? <button type="button" onClick={onRetry}>Повторить</button> : null}
    </div>
  );
}

export function Footer({ generatedAt }: { generatedAt?: string }) {
  return (
    <footer className="dp-footer">
      <span>Данные: OpenDota. Прогнозы строятся только на статистике — никаких ручных оценок.</span>
      {generatedAt ? <span>Обновлено {new Date(generatedAt).toLocaleTimeString("ru-RU")}</span> : null}
    </footer>
  );
}
