// What the server is doing right now, in words.
//
// The scheduler already records every run, but it records them as raw job
// output. A page showing `{"stored":412,"pagesUsed":5,...}` tells you nothing
// about whether the thing is working; these summaries do.

const plural = (count, one, few, many) => {
  const n = Math.abs(Number(count) || 0);
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
};

const count = (value, one, few, many) => `${Number(value).toLocaleString("ru-RU")} ${plural(value, one, few, many)}`;
const day = (seconds) => (seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : null);

// The scheduler labels jobs in English for the API; the page is Russian.
export const JOB_LABELS = {
  live: ["Матчи в эфире", "Опрашивает идущие матчи и предсказывает их по пикам"],
  importArchive: ["Импорт архива", "Разбирает архив матчей, если его положили в import/"],
  resolve: ["Закрытие прогнозов", "Сверяет прогнозы с результатами и считает точность"],
  syncActive: ["Обновление турниров", "Перезагружает идущие турниры целиком"],
  discover: ["Поиск новых турниров", "Находит новые лиги и заводит им страницы"],
  forecast: ["Пересчёт прогнозов", "Монте-Карло по текущему положению турниров"],
  structure: ["Формат и сетки", "Тянет формат, сетку и расписание у организатора"],
  collectRecent: ["Свежие матчи", "Добирает завершённые про-матчи"],
  backfill: ["Догрузка истории", "Фоном уходит вглубь по истории матчей"],
  draftDetail: ["Загрузка пиков", "Подтягивает пики и баны по картам"],
  retrain: ["Переобучение моделей", "Заново обучает рейтинги и модель драфта"],
};

export const JOB_TITLES = Object.fromEntries(Object.entries(JOB_LABELS).map(([job, [title]]) => [job, title]));

/** One readable line describing what a finished job actually did. */
export function describeJobRun(job, detail) {
  if (!detail || typeof detail !== "object") return null;
  if (detail.error) return `ошибка: ${detail.error}`;
  if (detail.skipped) return `пропущено (${detail.reason ?? detail.skipped})`;

  switch (job) {
    case "live": {
      const open = Number(detail.openGames || 0);
      const predicted = Number(detail.predicted || 0);
      if (!open && !predicted) return "матчей нет, следующая проверка через " + (detail.nextPollSeconds ?? "—") + " с";
      return [
        open ? count(open, "матч идёт", "матча идут", "матчей идут") : null,
        predicted ? `записано ${count(predicted, "прогноз", "прогноза", "прогнозов")} по драфту` : null,
        detail.closed ? `завершено ${detail.closed}` : null,
      ].filter(Boolean).join(", ");
    }
    case "collectRecent":
      return Number(detail.stored)
        ? `добрано ${count(detail.stored, "карта", "карты", "карт")} из ${count(detail.leagues, "лиги", "лиг", "лиг")}`
        : "новых матчей нет";
    case "backfill": {
      const parts = [detail.stored ? `загружено ${count(detail.stored, "карта", "карты", "карт")}` : "новых карт нет"];
      if (detail.oldestSeen) parts.push(`история собрана до ${day(detail.oldestSeen)}`);
      if (detail.done) parts.push("окно закрыто полностью");
      else if (detail.stoppedBy === "throttled") parts.push("источник попросил притормозить");
      else if (detail.stoppedBy === "budget_reserve") parts.push("дневной бюджет на исходе");
      return parts.join(", ");
    }
    case "draftDetail":
      return Number(detail.fetched)
        ? `подтянуто ${count(detail.fetched, "драфт", "драфта", "драфтов")}`
        : "новых драфтов нет";
    case "discover":
      return [
        `найдено ${count(detail.discovered ?? 0, "турнир", "турнира", "турниров")}`,
        detail.storedMaps ? `сохранено ${count(detail.storedMaps, "карта", "карты", "карт")}` : null,
        detail.named?.renamed ? `названий уточнено ${detail.named.renamed}` : null,
      ].filter(Boolean).join(", ");
    case "structure":
      return `структура: ${detail.withPage ?? 0} из ${count(detail.leagues ?? 0, "турнира", "турниров", "турниров")} со страницей организатора`;
    case "forecast":
      return Number(detail.updated)
        ? `пересчитано ${count(detail.updated, "турнир", "турнира", "турниров")}`
        : "изменений нет, пересчёт не нужен";
    case "resolve":
      return Number(detail.resolved)
        ? `закрыто ${count(detail.resolved, "прогноз", "прогноза", "прогнозов")}`
        : "закрывать нечего";
    case "importArchive":
      return Number(detail.imported)
        ? `импортировано ${count(detail.imported, "карта", "карты", "карт")}`
        : "новых архивов нет";
    case "syncActive":
      return `перезагружено ${count(detail.leagues ?? 0, "турнир", "турнира", "турниров")}`;
    case "retrain": {
      const parts = [];
      if (detail.ratings?.ok) parts.push(`рейтинги: ${count(detail.ratings.series, "серия", "серии", "серий")}, ${count(detail.ratings.teams, "команда", "команды", "команд")}`);
      else if (detail.ratings) parts.push(`рейтинги не переобучены (${detail.ratings.reason})`);
      if (detail.draft?.ok) parts.push(`драфт: ${count(detail.draft.maps, "карта", "карты", "карт")}`);
      else if (detail.draft) parts.push(`драфт не переобучен (${detail.draft.reason})`);
      if (detail.forecasts?.updated) parts.push(`прогнозов пересчитано ${detail.forecasts.updated}`);
      return parts.join(" · ") || "нечего переобучать";
    }
    default:
      return null;
  }
}

/**
 * Current activity: what is running now and what the last few runs achieved.
 */
export function activitySnapshot(db, scheduler, { history = 25 } = {}) {
  const status = scheduler.status();

  const jobs = status.map((entry) => ({
    job: entry.job,
    title: JOB_TITLES[entry.job] ?? entry.job,
    description: JOB_LABELS[entry.job]?.[1] ?? entry.description,
    running: entry.running,
    intervalSeconds: entry.intervalSeconds,
    lastRunAt: entry.lastRunAt,
    lastStatus: entry.lastStatus,
    lastError: entry.lastError,
    summary: describeJobRun(entry.job, entry.lastDetail),
  }));

  const runs = db.prepare(`SELECT id, job, started_at, finished_at, status, detail_json, error
                           FROM job_runs ORDER BY id DESC LIMIT ?`).all(history)
    .map((row) => {
      let detail = null;
      try { detail = row.detail_json ? JSON.parse(row.detail_json) : null; } catch { detail = null; }
      const started = Date.parse(row.started_at);
      const finished = row.finished_at ? Date.parse(row.finished_at) : null;
      return {
        id: row.id,
        job: row.job,
        title: JOB_TITLES[row.job] ?? row.job,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        status: row.status,
        durationMs: finished && Number.isFinite(started) ? finished - started : null,
        summary: row.error ? `ошибка: ${row.error}` : describeJobRun(row.job, detail),
      };
    });

  const running = jobs.filter((entry) => entry.running);
  return {
    running: running.map((entry) => {
      const since = runs.find((run) => run.job === entry.job && run.status === "running");
      return { ...entry, startedAt: since?.startedAt ?? null };
    }),
    jobs,
    runs,
  };
}
