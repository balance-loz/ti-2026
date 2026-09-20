"use client";

// The visible half of the explanation: a forecast shown as the sequence of
// things that produced it, each one measured, rather than as a single number
// with a paragraph of prose beside it.
import type {
  DraftExplanation, Factor, ExplanationNote, HeroContribution, Lineup, SeriesExplanation, TeamRef,
} from "../lib/api";
import { formatDateTime, probabilityPercent } from "../lib/api";

const points = (value: number) => `${value >= 0 ? "+" : "−"}${Math.abs(value * 100).toFixed(1)} п.п.`;

/** "1 игра", "2 игры", "5 игр" — a bare count beside a noun reads as machine output. */
const counted = (value: number, one: string, few: string, many: string) => {
  const n = Math.abs(value);
  const mod10 = n % 10;
  const mod100 = n % 100;
  const form = mod10 === 1 && mod100 !== 11 ? one
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20) ? few
      : many;
  return `${n.toLocaleString("ru-RU")} ${form}`;
};
const span = (value: number) => `${Math.min(100, Math.max(0, value * 100))}%`;

/**
 * One step, drawn as the move it made.
 *
 * The bar runs over the whole 0–100% axis and fills only the stretch this
 * factor is responsible for, so a large label on a small effect cannot look
 * like a large effect.
 */
function FactorRow({ factor }: { factor: Factor }) {
  const rising = factor.delta >= 0;
  const left = Math.min(factor.from, factor.to);
  const width = Math.abs(factor.to - factor.from);
  return (
    <li className="dp-factor">
      <div className="dp-factor-head">
        <span className="dp-factor-label">{factor.label}</span>
        <span className="dp-factor-move">
          {probabilityPercent(factor.from)} → <b>{probabilityPercent(factor.to)}</b>
        </span>
        <span className={`dp-factor-delta ${rising ? "dp-up" : "dp-down"}`}>{points(factor.delta)}</span>
      </div>
      <div className="dp-factor-track">
        <span
          className={`dp-factor-fill ${rising ? "dp-up" : "dp-down"}`}
          style={{ left: span(left), width: span(width) }}
        />
      </div>
      <p className="dp-factor-detail">
        {factor.detail}
        {factor.logit === null ? null : <span className="dp-factor-logit"> · {factor.logit >= 0 ? "+" : ""}{factor.logit} логита</span>}
      </p>
    </li>
  );
}

export function FactorList({ factors, empty }: { factors: Factor[]; empty?: string }) {
  if (!factors.length) return <p className="dp-caveat">{empty ?? "Разложить прогноз не на что."}</p>;
  return <ol className="dp-factors">{factors.map((factor) => <FactorRow key={factor.key} factor={factor} />)}</ol>;
}

/** Things the model measured about itself, and things it deliberately left out. */
export function Notes({ notes }: { notes: ExplanationNote[] }) {
  if (!notes.length) return null;
  return (
    <ul className="dp-notes">
      {notes.map((note) => <li key={note.key}>{note.text}</li>)}
    </ul>
  );
}

/** Every pick, with the weight the model actually gives it. */
export function HeroInfluence({ heroes }: { heroes: HeroContribution[] }) {
  if (!heroes.length) return null;
  const peak = Math.max(...heroes.map((hero) => Math.abs(hero.logit)), 0.0001);
  return (
    <ul className="dp-influence">
      {heroes.map((hero) => (
        <li key={`${hero.side}-${hero.heroId}`} className={hero.known ? "" : "dp-influence-unknown"}>
          <span className={`dp-influence-side dp-hero-${hero.side}`}>{hero.side === "radiant" ? "Свет" : "Тьма"}</span>
          <span className="dp-influence-name">{hero.name}</span>
          <span className="dp-influence-track">
            <span
              className={`dp-influence-fill ${hero.logit >= 0 ? "dp-up" : "dp-down"}`}
              style={{
                width: `${(50 * Math.abs(hero.logit)) / peak}%`,
                [hero.logit >= 0 ? "left" : "right"]: "50%",
              }}
            />
          </span>
          <span className={`dp-influence-impact ${hero.logit >= 0 ? "dp-up" : "dp-down"}`}>{points(hero.impact)}</span>
          <span className="dp-influence-games">{hero.known ? counted(hero.games, "игра", "игры", "игр") : "нет данных"}</span>
        </li>
      ))}
    </ul>
  );
}

function LineupCard({ team, lineup }: { team: TeamRef; lineup: Lineup }) {
  if (!lineup) return <div className="dp-lineup"><b>{team.name}</b><p className="dp-muted dp-small">Составы не сохранены.</p></div>;
  return (
    <div className="dp-lineup">
      <b>{team.name}</b>
      <p className="dp-lineup-players">{lineup.players.map((player) => player.name || `#${player.accountId}`).join(" · ")}</p>
      <p className="dp-muted dp-small">
        {lineup.unchangedThroughout
          ? `Не менялся на протяжении всех ${lineup.sampledMaps} последних карт.`
          : `Играет вместе последние ${lineup.stableMaps} карт из ${lineup.sampledMaps}; до этого состав был другим.`}
      </p>
    </div>
  );
}

/**
 * The full account of a series prediction: what moved it, then what is worth
 * knowing but did not.
 */
export function SeriesReasoning({ explanation, teamA, teamB }: {
  explanation: SeriesExplanation;
  teamA: TeamRef;
  teamB: TeamRef;
}) {
  const { context, quality } = explanation;
  const h2h = context.headToHead;
  return (
    <>
      <p className="dp-basis">
        {explanation.basis === "frozen"
          ? "Разбор построен на рейтингах, с которыми прогноз был зафиксирован."
          : "Матч ещё не оценивался — разбор по текущим рейтингам."}
        {explanation.modelId ? ` Модель ${explanation.modelId}.` : null}
      </p>

      <FactorList factors={explanation.factors} />

      {quality ? (
        <dl className="dp-metrics dp-metrics-tight">
          <div><dt>log loss на проверке</dt><dd>{quality.logLoss.toFixed(4)}</dd></div>
          <div><dt>монетка</dt><dd>{quality.coinflipLogLoss.toFixed(4)}</dd></div>
          <div><dt>точность</dt><dd>{(quality.accuracy * 100).toFixed(1)}%</dd></div>
          <div><dt>серий в проверке</dt><dd>{quality.samples}</dd></div>
        </dl>
      ) : null}

      <h3 className="dp-subhead">Контекст — не входит в расчёт</h3>
      <div className="dp-context">
        <div className="dp-context-block">
          <b>Личные встречи</b>
          {h2h.played ? (
            <>
              <p className="dp-context-score">{h2h.winsA} : {h2h.winsB}{h2h.draws ? ` (+${h2h.draws} ничьих)` : ""}</p>
              <ul className="dp-context-list">
                {h2h.matches.slice(0, 5).map((match) => (
                  <li key={match.seriesKey}>
                    <a href={`/match/${encodeURIComponent(match.seriesKey)}`}>
                      {match.scoreA}:{match.scoreB}
                    </a>
                    <span className="dp-muted"> · {formatDateTime(match.startTime)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : <p className="dp-muted dp-small">Эти команды ещё не играли между собой.</p>}
        </div>

        <div className="dp-context-block">
          <b>Форма</b>
          <p className="dp-context-form">
            <span>{teamA.name}: </span>
            {context.formA.map((entry) => (
              <span key={entry.seriesKey} className={`dp-form-${entry.result}`} title={entry.score}>
                {entry.result === "win" ? "П" : entry.result === "loss" ? "К" : "Н"}
              </span>
            ))}
          </p>
          <p className="dp-context-form">
            <span>{teamB.name}: </span>
            {context.formB.map((entry) => (
              <span key={entry.seriesKey} className={`dp-form-${entry.result}`} title={entry.score}>
                {entry.result === "win" ? "П" : entry.result === "loss" ? "К" : "Н"}
              </span>
            ))}
          </p>
        </div>

        <div className="dp-context-block">
          <b>Составы</b>
          <LineupCard team={teamA} lineup={context.lineupA} />
          <LineupCard team={teamB} lineup={context.lineupB} />
        </div>
      </div>

      <Notes notes={explanation.notes} />
    </>
  );
}

/** The same account for one map, short enough to sit inside a map card. */
export function DraftReasoning({ explanation }: { explanation: DraftExplanation }) {
  if (!explanation.available) {
    return <Notes notes={explanation.notes} />;
  }
  return (
    <details className="dp-why">
      <summary>
        Почему {probabilityPercent(explanation.probabilityRadiant)} за Свет
        <span className="dp-muted"> · пики дали {points(explanation.draftDelta)}</span>
      </summary>
      <div className="dp-why-body">
        <p className="dp-basis">
          {explanation.prior.label}: {probabilityPercent(explanation.priorProbabilityRadiant)}
          {" "}(рейтинги {explanation.prior.ratingRadiant.toFixed(2)} и {explanation.prior.ratingDire.toFixed(2)}).
        </p>
        <FactorList factors={explanation.factors} />
        <h4 className="dp-subhead">Вклад каждого пика</h4>
        <HeroInfluence heroes={explanation.heroes} />
        {explanation.quality ? (
          <p className="dp-caveat">
            На отложенной выборке ({explanation.quality.samples} карт) модель даёт log loss{" "}
            {explanation.quality.logLoss.toFixed(4)} против {explanation.quality.baselineLogLoss.toFixed(4)} у прогноза
            по силе команд без героев — выигрыш {explanation.quality.improvementNats.toFixed(5)} ната,
            точность {(explanation.quality.accuracy * 100).toFixed(1)}%.
          </p>
        ) : null}
        <Notes notes={explanation.notes} />
      </div>
    </details>
  );
}
