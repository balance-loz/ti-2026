"use client";

import { useCallback } from "react";
import { api, clock, probabilityPercent, relativeTime, type HeroCatalog, type LiveGame } from "../lib/api";
import { usePolled } from "../lib/hooks";
import { Badge, EmptyState, ErrorState, Footer, HeroStrip, Panel, ProbabilityBar, Team, TopBar } from "../components/shell";

function GameRow({ game, heroes }: { game: LiveGame; heroes: HeroCatalog }) {
  const frozen = game.frozenDraftProbabilityRadiant;
  const current = game.draft?.probabilityRadiant ?? null;
  const liveProbability = game.liveState?.liveProbabilityRadiant ?? null;
  const shown = frozen ?? current;
  const leader = game.liveState?.assessment?.leader ?? null;

  return (
    <article className="dp-live-card dp-live-card-wide">
      <header>
        <Team team={game.radiantTeam} compact />
        <span className="dp-live-score">{game.radiantScore} : {game.direScore}</span>
        <Team team={game.direTeam} compact />
      </header>

      <div className="dp-live-status">
        <Badge tone={game.phase === "draft" ? "warn" : "live"}>
          {game.phase === "draft" ? "драфт" : clock(game.gameTime)}
        </Badge>
        {game.tournament ? <a className="dp-link dp-small" href={`/t/${game.tournament.slug}`}>{game.tournament.name}</a> : <span className="dp-muted dp-small">лига {game.leagueId}</span>}
        {game.radiantLead !== null ? (
          <span className="dp-muted dp-small">золото {game.radiantLead > 0 ? "+" : ""}{game.radiantLead.toLocaleString("ru-RU")}</span>
        ) : null}
        {leader ? <span className="dp-muted dp-small">ведёт {leader}</span> : null}
      </div>

      <div className="dp-live-picks">
        <HeroStrip picks={game.radiantPicks} side="radiant" heroes={heroes} />
        <HeroStrip picks={game.direPicks} side="dire" heroes={heroes} />
      </div>

      {shown === null ? (
        <p className="dp-muted">Прогноз появится, когда обе команды закроют пики.</p>
      ) : (
        <>
          <ProbabilityBar probabilityA={shown} />
          <dl className="dp-live-numbers">
            <div><dt>зафиксировано по драфту</dt><dd>{probabilityPercent(frozen)}</dd></div>
            {game.draft ? <div><dt>рейтинги до драфта</dt><dd>{probabilityPercent(game.draft.priorProbabilityRadiant)}</dd></div> : null}
            {liveProbability !== null ? <div><dt>с учётом хода игры</dt><dd>{probabilityPercent(liveProbability)}</dd></div> : null}
          </dl>
          {game.frozenAt ? <p className="dp-muted dp-small">прогноз записан {relativeTime(game.frozenAt)} и больше не меняется</p> : null}
        </>
      )}
    </article>
  );
}

export default function LivePage() {
  const load = useCallback((signal: AbortSignal) => api.live(signal), []);
  const { data, error, reload } = usePolled(load, 15_000);
  const games = data?.games ?? null;
  const heroes = data?.heroes ?? {};
  const generatedAt = data?.generatedAt;

  return (
    <main className="dp-page">
      <TopBar live={games?.length ?? 0} />

      <section className="dp-hero dp-hero-tournament">
        <h1>Матчи в прямом эфире</h1>
        <p>
          Каждые несколько секунд система забирает список идущих про-матчей. Как только обе команды
          закрывают драфт, вероятность считается по десяти героям и рейтингам команд, записывается
          один раз и дальше не переписывается.
        </p>
      </section>

      {error ? <ErrorState error={error} onRetry={reload} /> : null}

      <Panel title="Сейчас на серверах" subtitle={games === null ? undefined : `${games.length} матчей`}>
        {games === null ? (
          <EmptyState title="Загрузка…" />
        ) : games.length === 0 ? (
          <EmptyState title="Сейчас нет про-матчей" hint="Страница обновляется сама — как только начнётся игра, она появится здесь." />
        ) : (
          <div className="dp-live-grid">
            {games.map((game) => <GameRow key={game.matchId} game={game} heroes={heroes} />)}
          </div>
        )}
      </Panel>

      <Footer generatedAt={generatedAt} />
    </main>
  );
}
