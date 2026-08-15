# Полный аудит моделей и математических решений — 12 августа 2026

## Повторная chronological validation — 15 августа 2026

Первый этап повторён после устранения evaluator/runtime drift.

- **Online tournament update:** evaluator теперь вызывает тот же регуляризованный Bradley–Terry updater, что production, и делает прогноз строго до добавления результата серии. Выбор сделан на первых 20 турнирах / 273 сериях, gate — на последних 6 турнирах / 144 сериях. Candidate `liveGlobal=0.4` улучшил log loss `0.671205 → 0.655942` и Brier `0.239194 → 0.231656`; tournament-cluster CI дельты LL `[-0.028245; -0.005913]`, но series-cluster CI `[-0.041539; +0.011502]`. Полный gate не пройден: MAIN `liveGlobal=0`, candidate остаётся shadow. Неиспользуемый `liveRematch` удалён из схемы.
- **Tournament form uncertainty:** SD оценивался непосредственно в logit space как один латентный team shock на турнир, с Gauss–Hermite интегрированием marginal probability; probability residual не переводился в logit и safety cap не использовался как optimum. Inner grid выбрал `formLogitSd=0`; holdout delta LL/Brier равна нулю, обе upper95 равны нулю. MAIN `formLogitSd=0`; сетка чувствительности сохранена.
- **Live-map:** rich dataset пересобран с leakage-safe active-formula prequential OOF prior, совпадающим с serving prior настолько, насколько позволяют исторические данные. Split строго хронологический и grouped by series: 612/141/189 series, 3299/831/1109 snapshots. На test log loss `0.655074 → 0.527295`, Brier `0.231204 → 0.179156`; map-cluster CI `[-0.163658; -0.092118]`, series-cluster CI `[-0.162425; -0.092141]`. Gates также пройдены отдельно на 10/15/20 минутах; upper95 соответственно `-0.036837`, `-0.071345`, `-0.162086`. Статус `ACTIVE`: между контрольными точками 10–20 минут используется только интерполяция непрерывной формулы и она отдельно помечается в runtime metadata. После 20:00 validation claim отсутствует, runtime не экстраполирует validated probability.
- Все входные OOF/model artifacts снабжены SHA-256 provenance. Temporal и nextgen остаются inactive/shadow: этот этап не менял их gates и не активировал их.

Ограничение online gate: tournament bootstrap на holdout содержит только 6 кластеров. Поэтому отрицательный tournament CI не отменяет положительную series upper95; безопасный итог — shadow.

## Итог

Система технически воспроизводима, но не все показанные числа имеют одинаковый статус.

| Компонент | Результат | Статус |
| --- | --- | --- |
| Командная вероятность | Nested outer WF 0.67482 против 0.69315; frozen holdout 0.67121, bootstrap upper95 = +0.00359 | EXPERIMENTAL |
| Активная map-level формула | 0.67754 против 0.68300 у отдельно обученного shared-team-prior+side | CANDIDATE |
| Замороженный combiner holdout | 0.67434 против 0.67970; bootstrap upper95 < 0 | CANDIDATE |
| Temporal draft ensemble | 0.68787 против 0.68950; delta -0.00164 меньше порога -0.002 | SHADOW |
| Patch-note transition | Adjusted-target RMSE 0.13943, но no-notes лучше: 0.13637 | EXPERIMENTAL |
| Турнирный Monte Carlo | Один модуль client/server; form point estimate улучшает holdout, bootstrap не подтверждает | EXPERIMENTAL |

## Обновление приоритетов 12 августа: реализовано

- Командный prior теперь выбирается nested chronological walk-forward arena из 21 конфигурации: Elo, adaptive dynamic rating, recency logistic и online Bradley–Terry. Гиперпараметры выбраны на ранних турнирах, последние 6 лиг / 144 серии оставлены untouched. Выбран `dynamic_lr0.2_h120`: log loss 0.67121 против 0.69315 у 50%, но series-bootstrap CI [-0.04772; 0.00359] пересекает ноль, поэтому статус остаётся `EXPERIMENTAL`. На holdout Elo (0.64040), recency (0.64954) и Bradley–Terry (0.64449) оказались лучше выбранной по inner-периоду динамической модели: это явный temporal selection instability, а не основание выбрать модель по уже увиденному holdout.
- `public/team-model.json` и `team-stats.pairwise` стали единым командным prior. Главная страница и Draft Lab больше не используют разные рейтинги.
- Synergy и directional counter обучаются на pre-map residual `outcome - hero/side expectation`, а не на сыром win rate пары. Team prior в этом же OOF теперь использует выбранный класс `dynamic_lr0.2_h120`, то есть совпадает с production-контрактом. Текущий active walk-forward: 55 774 OOF карт, log loss 0.67754 против 0.68300 у отдельно обученного team+side; frozen holdout 0.67404 против 0.67962.
- Player layer на исторической карте использует фактическую player→hero связь. В интерфейсе assignment ограничен подтверждённой позицией игрока и наличием hero×position evidence. Старая эвристика Carry/Support/control/frontline/range удалена; отдельный `roles` теперь является обученным hero×position signal.
- Patch-transition target заменён на хронологический team/opponent/Radiant-adjusted hero residual. Notes-модель всё ещё не улучшает no-notes ablation (RMSE 0.13943 против 0.13637), поэтому остаётся `EXPERIMENTAL`; эвристический перенос hero delta в pair effects отключён.
- Турнирные live weights и dispersion оценены на исторических лигах: `liveGlobal=0.3`, `liveRematch=0.2`, `formLogitSd=0.35`, `seriesNoiseLogitSd=0`. На последних 6 лигах sequential live update улучшил point estimates: log loss 0.67121 → 0.65864 и Brier 0.23919 → 0.23250, но series-bootstrap CI дельты [-0.04550; 0.02071] пересекает ноль, а form SD достиг safety cap. Статус `EXPERIMENTAL`; отдельный Gaussian series shock отключён, поскольку Bernoulli sampling уже моделирует случайность исхода, а дополнительную дисперсию данные не идентифицировали.
- Клиентская копия Monte Carlo удалена. Ручной браузерный прогон, API и автоснимки используют один `server/forecast-engine.mjs`; формат артефакта поднят до `hidden-groups-r1-r3-playoff-v4`.

## Данные и временная честность

- Окно 2024-08-11 — 2026-08-12: 55 874 уникальные pro-карты, 22 точные версии, 21 переход.
- На каждой карте 10 уникальных героев; ошибок timestamp-границ, source и checksum нет.
- Настоящий `series_id` есть у 94.73% карт. Остальные — отдельные synthetic match-clusters.
- Обе team ID известны у 94.81% карт, account ID — у 100%, роль — у 99.76% player rows.
- 20/20 полных версий проходят coverage floor; 13 — сильный standalone-порог.

Coverage-пороги инженерные, а не formal power analysis. Следует оценить minimum detectable effect для log loss и hero coefficients.

## Командная модель

Production: recency-weighted Bradley–Terry по сериям, L2, roster weights 1/0.25/0.07, H2H prior 6 серий и преобразование map probability в BO3/BO5.

Проблемы:

1. Production хуже 50%, Elo и recency по log loss. Accuracy 57.3% при плохом log loss означает чрезмерную уверенность.
2. ECE равен 0.1232. Средние прогнозы 94.6% реализовались примерно в 76.9% наблюдений.
3. `seriesInformation`, roster weights и LGD reliability 0.65 заданы вручную и не прошли ablation.
4. Часть серий восстановлена по opponent/league/8-hour window. Локальный backtest теперь использует provider `series_id`, когда он доступен.
5. `uncertainty = 0.04 + 0.32/sqrt(4+n)` не является posterior SD или доверительным интервалом.

Elo/recency challenger обучался на первых 70% OOF и проверялся на последних 30% (126 серий). Его log loss 0.63401 хуже чистого Elo 0.61811 и recency 0.62130; bootstrap не подтвердил улучшение. Статус `research_only`.

Приоритет: корректный series-likelihood или map likelihood с series clusters; nested walk-forward для half-life, L2, H2H shrink, roster weights и temperature; затем отдельный untouched tournament holdout.

## Активная формула пиков

Порядок: `team prior → side → hero → synergy → counter → team pool → player pool → roles`. Карта прогнозируется до наблюдения результата. Combiner v2 обучается на OOF-признаках.

- Prequential после устранения общего `od:0`: 0.67689 против 0.68292 у team+side.
- Frozen final-30% holdout: 0.67304 против 0.67957.
- Bootstrap holdout delta: [-0.00749; -0.00554].
- На картах с известными обеими team ID: 0.67726 против 0.68279.
- Формула улучшает baseline на всех 22 exact-version slices; короткие boundary slices трактуются только диагностически.
- Финальные веса обучены повторно после исправления identity; актуальные значения лежат в `public/draft-stats.json`.

Player pool — сильнейший дополнительный слой. Hero, synergy, counter и team pool дают меньшие положительные улучшения. Role heuristic слегка ухудшает log loss и не считается доказанным; его вес почти обнулился. Drop-one не является причинной оценкой: признаки коррелируют.

Риски:

- внутренний online team prior отличается от командного prior основного сайта;
- исходная версия ошибочно объединяла все стороны без team ID в `od:0`; теперь каждая неизвестная сторона имеет уникальный match-local ID;
- unrestricted best player assignment может переоценивать flex и захватывать roster stability;
- synergy/counter rates содержат main effects героев, а не только interaction residuals;
- clamp 8%/92% — продуктовая защита, не результат калибровки.

## Temporal Model Arena

Девять моделей сравниваются на 22 exact-version folds. Backtest и export используют фиксированные четыре: long-memory, FM-8, FM-4, conservative interactions. Pair-порог 200 игр одинаков для scoring и export.

Ансамбль выиграл 18/21 folds, но improvement -0.00164 не прошёл порог -0.002. Он остаётся `SHADOW`. Даже будущий `CANDIDATE` не включается автоматически, пока не доказано улучшение поверх активной формулы; `incrementalToActiveValidated=false`.

## Patch-transition

Цель — изменение сглаженного hero log-odds. Каждый fold учится только на более ранних переходах.

- carry RMSE 0.17472;
- no-notes mean reversion 0.13921;
- patch notes 0.14251;
- bootstrap patch notes vs no-notes: [-0.00010; 0.00965].

Patch notes не добавляют подтверждённого сигнала. Raw hero win rate смешивает героя, команды и draft context. Следующая цель — opponent/team-adjusted hero coefficient; patch notes нужны как типизированные изменения (`cooldown down`, `damage up`), а не только счётчики слов.

## Турнирная симуляция

На 20 000 прогонов проверено: qualification 800%, direct 300%, via play-in 500%, out 800%, champion 100%, finalists 200%, top-3 300%; суммарные Swiss wins равны losses.

`TOURNAMENT_FORM_SD=0.16`, live global/rematch weights и pair uncertainty не откалиброваны. Gaussian logit shocks — модель латентной вариативности, не доверительный интервал. Buchholz и pairing fallback нужно сверить с окончательным регламентом TI 2026.

Клиентский `app/page.tsx` и серверный `server/forecast-engine.mjs` содержат две реализации симулятора. Автоматические snapshots считаются серверной версией, ручной браузерный запуск — клиентской. Это риск дрейфа формул; следует вынести общий pure simulation core и оставить один parity-тест с одинаковыми seed/input.

## Приоритет дальнейших работ

1. Nested team arena: Elo, динамический рейтинг, calibrated recency logistic, Bradley–Terry variants; untouched tournament holdout.
2. Единый team prior для Draft Lab и турнирного прогноза.
3. Cross-fitted residual synergy/counter после hero main effects.
4. Ограничить player assignment заявленными позициями и role probabilities.
5. Переобучить role representation или удалить компонент.
6. Opponent/team-adjusted patch target и структурный parser числовых notes.
7. Калибровать form/uncertainty на исторических турнирах; добавить reliability diagrams и интервалы champion probability.
8. Объединить клиентский и серверный Monte Carlo в один общий модуль и проверять seed-parity.
9. Drift-аудит по патчу, региону, tier лиги и полноте identity.

Любое включение требует заранее зафиксированного gate и последующего временного holdout, а не улучшения на том же наборе, где принималось решение.
