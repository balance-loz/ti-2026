"use client";

import { useCallback } from "react";
import { api, formatDate, relativeTime, type HealthStatus, type LiveGame, type TournamentSummary } from "./lib/api";
import { usePolled } from "./lib/hooks";
import { Badge, EmptyState, ErrorState, Footer, Panel, TopBar } from "./components/shell";

const STATUS_ORDER: Array<{ key: "live" | "finished"; title: string; hint: string }> = [
  { key: "live", title: "Идут сейчас", hint: "Турниры с матчами за последние дни. Страница создаётся автоматически при первом сыгранном матче." },
  { key: "finished", title: "Завершённые", hint: "Архив с сохранёнными прогнозами и их точностью." },
];

function TournamentCard({ tournament }: { tournament: TournamentSummary }) {
  return (
    <a className="dp-card" href={`/t/${tournament.slug}`}>
      <div className="dp-card-head">
        <b>{tournament.name}</b>
        {tournament.playingNow ? <Badge tone="live">в эфире</Badge> : tournament.status === "live" ? <Badge tone="good">идёт</Badge> : null}
      </div>
      <div className="dp-card-meta">
        {tournament.tier ? <span>{tournament.tier}</span> : null}
        <span>{tournament.teamCount ?? 0} команд</span>
        <span>{tournament.seriesCount} серий</span>
        <span>{tournament.mapCount} карт</span>
      </div>
      <div className="dp-card-foot">
        <span>{formatDate(tournament.startTime)} — {tournament.endTime ? formatDate(tournament.endTime) : "…"}</span>
        <span className="dp-muted">синк {relativeTime(tournament.lastSyncedAt)}</span>
      </div>
    </a>
  );
}

type IndexState = { tournaments: TournamentSummary[]; live: LiveGame[]; health: HealthStatus | null };

export default function TournamentsIndexPage() {
  const load = useCallback(async (signal: AbortSignal): Promise<IndexState> => {
    const [list, liveState, healthState] = await Promise.all([
      api.tournaments(undefined, signal),
      api.live(signal).catch(() => ({ games: [] as LiveGame[], generatedAt: "" })),
      api.health(signal).catch(() => null),
    ]);
    return { tournaments: list.tournaments, live: liveState.games, health: healthState };
  }, []);

  const { data, error, reload } = usePolled(load, 60_000);
  const tournaments = data?.tournaments ?? null;
  const live = data?.live ?? [];
  const health = data?.health ?? null;

  const grouped = (status: "live" | "finished") => (tournaments ?? []).filter((item) => item.status === status);

  return (
    <main className="dp-page">
      <TopBar live={live.length} />

      <section className="dp-hero">
        <h1>Автоматический прогноз Dota 2</h1>
        <p>
          Система сама находит новые турниры, каждый день собирает сыгранные матчи, переобучается на них
          и строит прогноз каждой серии — от первого матча до чемпиона. Матчи, идущие прямо сейчас,
          оцениваются по пикам героев.
        </p>
        {health ? (
          <div className="dp-hero-stats">
            <div><b>{health.counts.tournaments ?? 0}</b><span>турниров</span></div>
            <div><b>{(health.counts.maps ?? 0).toLocaleString("ru-RU")}</b><span>карт в базе</span></div>
            <div><b>{(health.counts.predictions ?? 0).toLocaleString("ru-RU")}</b><span>прогнозов</span></div>
            <div><b>{health.counts.live_games ?? 0}</b><span>идут сейчас</span></div>
          </div>
        ) : null}
      </section>

      {live.length ? (
        <Panel title="Прямо сейчас" subtitle="Прогноз по завершённому драфту" actions={<a className="dp-link" href="/live">все матчи →</a>}>
          <div className="dp-live-strip">
            {live.slice(0, 4).map((game) => {
              const probability = game.frozenDraftProbabilityRadiant ?? game.draft?.probabilityRadiant ?? null;
              return (
                <a key={game.matchId} className="dp-live-chip" href={game.tournament ? `/t/${game.tournament.slug}` : "/live"}>
                  <span className="dp-live-teams">{game.radiantTeam.name} vs {game.direTeam.name}</span>
                  <span className="dp-live-prob">
                    {probability === null ? "драфт идёт" : `${(probability * 100).toFixed(0)}% / ${((1 - probability) * 100).toFixed(0)}%`}
                  </span>
                  <span className="dp-muted">{game.tournament?.name ?? `Лига ${game.leagueId}`}</span>
                </a>
              );
            })}
          </div>
        </Panel>
      ) : null}

      {error ? <ErrorState error={error} onRetry={reload} /> : null}

      {STATUS_ORDER.map(({ key, title, hint }) => {
        const items = grouped(key);
        return (
          <Panel key={key} title={title} subtitle={hint}>
            {tournaments === null ? (
              <EmptyState title="Загрузка…" />
            ) : items.length === 0 ? (
              <EmptyState
                title={key === "live" ? "Сейчас нет активных турниров" : "Архив пока пуст"}
                hint={key === "live" ? "Как только начнётся новый турнир, он появится здесь сам." : undefined}
              />
            ) : (
              <div className="dp-grid">
                {items.map((tournament) => <TournamentCard key={tournament.leagueId} tournament={tournament} />)}
              </div>
            )}
          </Panel>
        );
      })}

      <Footer generatedAt={health?.at} />
    </main>
  );
}
