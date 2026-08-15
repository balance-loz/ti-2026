"""Train a side-symmetric live map model from frozen historical snapshots.

The rich draft dataset contains leakage-safe pre-draft probabilities and
Radiant gold advantage at 10/15/20 minutes.  We deliberately keep this model
small: it estimates the map winner from the frozen prior and the gold state,
without inventing coefficients for telemetry the historical dataset lacks.
"""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "work" / "rich-draft-dataset.jsonl"
REPORT = ROOT / "work" / "live-map-model-report.json"
ARTIFACT = ROOT / "public" / "live-map-model.json"


def clamp_probability(value: Any) -> np.ndarray:
    return np.clip(np.asarray(value, dtype=float), 0.001, 0.999)


def logit(value: Any) -> np.ndarray:
    value = clamp_probability(value)
    return np.log(value / (1 - value))


def sigmoid(value: Any) -> np.ndarray:
    return 1 / (1 + np.exp(-np.clip(value, -20, 20)))


def metrics(target: Any, probability: Any) -> dict[str, float | int]:
    target = np.asarray(target, dtype=float)
    probability = clamp_probability(probability)
    return {
        "samples": int(len(target)),
        "logLoss": float(np.mean(-(target * np.log(probability) + (1 - target) * np.log(1 - probability)))),
        "brier": float(np.mean((probability - target) ** 2)),
        "accuracy": float(np.mean((probability >= 0.5) == target)),
    }


def chronological_series_split(rows: list[dict[str, Any]]) -> tuple[set[str], set[str], set[str]]:
    series_start = {}
    for row in rows:
        series_id = str(row["seriesId"])
        series_start[series_id] = min(series_start.get(series_id, float("inf")), int(row["startTime"]))
    ordered = [series_id for series_id, _ in sorted(series_start.items(), key=lambda item: (item[1], item[0]))]
    train_end = int(len(ordered) * 0.65)
    validation_end = int(len(ordered) * 0.80)
    return set(ordered[:train_end]), set(ordered[train_end:validation_end]), set(ordered[validation_end:])


def feature_row(prior: float, gold_lead: float, minute: int) -> list[float]:
    # No intercept or minute-only term: flipping sides negates every feature,
    # which guarantees p(Radiant) + p(Dire after side flip) == 1.
    gold_thousands = float(gold_lead) / 1000
    time = (float(minute) - 10) / 10
    return [float(logit(prior)), gold_thousands, gold_thousands * time]


def fit_logistic(features: Any, target: Any, ridge: float) -> np.ndarray:
    features = np.asarray(features, dtype=float)
    target = np.asarray(target, dtype=float)
    weights = np.zeros(features.shape[1], dtype=float)
    for _ in range(80):
        probability = sigmoid(features @ weights)
        variance = np.maximum(probability * (1 - probability), 1e-6)
        gradient = features.T @ (probability - target) + ridge * weights
        hessian = (features.T * variance) @ features + ridge * np.eye(features.shape[1])
        step = np.linalg.solve(hessian, gradient)
        weights -= step
        if float(np.max(np.abs(step))) < 1e-9:
            break
    return weights


def clustered_bootstrap(
    rows: list[dict[str, Any]],
    candidate: np.ndarray,
    baseline: np.ndarray,
    cluster_field: str,
    cluster_name: str,
    iterations: int = 5000,
) -> dict[str, float | int | str]:
    groups: dict[str, list[int]] = {}
    for index, row in enumerate(rows):
        groups.setdefault(str(row[cluster_field]), []).append(index)
    cluster_ids = list(groups)
    random = np.random.default_rng(0x51A7)
    target = np.asarray([row["target"] for row in rows], dtype=float)
    candidate_loss = -(target * np.log(clamp_probability(candidate)) + (1 - target) * np.log(clamp_probability(1 - candidate)))
    baseline_loss = -(target * np.log(clamp_probability(baseline)) + (1 - target) * np.log(clamp_probability(1 - baseline)))
    deltas = np.empty(iterations, dtype=float)
    for iteration in range(iterations):
        sampled = random.choice(cluster_ids, size=len(cluster_ids), replace=True)
        indices = [index for cluster_id in sampled for index in groups[str(cluster_id)]]
        deltas[iteration] = float(np.mean(candidate_loss[indices] - baseline_loss[indices]))
    return {
        "cluster": cluster_name,
        "clusters": len(cluster_ids),
        "iterations": iterations,
        "lower95": float(np.quantile(deltas, 0.025)),
        "upper95": float(np.quantile(deltas, 0.975)),
    }


def main() -> None:
    data_bytes = DATA.read_bytes()
    maps = sorted(
        [json.loads(line) for line in data_bytes.decode("utf8").splitlines() if line],
        key=lambda row: (int(row["startTime"]), int(row["matchId"])),
    )
    train_series, validation_series, test_series = chronological_series_split(maps)
    snapshots = []
    for row in maps:
        for minute in (10, 15, 20):
            gold = row.get(f"gold{minute}")
            if gold is None:
                continue
            snapshots.append({
                "matchId": row["matchId"],
                "seriesId": row["seriesId"],
                "leagueId": row["leagueId"],
                "minute": minute,
                "prior": float(row["preDraftProbability"]),
                "gold": float(gold),
                "target": int(row["radiantWin"]),
            })

    def subset(series_ids: set[str]) -> list[dict[str, Any]]:
        return [row for row in snapshots if row["seriesId"] in series_ids]

    train = subset(train_series)
    validation = subset(validation_series)
    test = subset(test_series)
    x_train = np.asarray([feature_row(row["prior"], row["gold"], row["minute"]) for row in train])
    y_train = np.asarray([row["target"] for row in train])
    x_validation = np.asarray([feature_row(row["prior"], row["gold"], row["minute"]) for row in validation])
    y_validation = np.asarray([row["target"] for row in validation])
    ridge_grid = (0.01, 0.1, 1.0, 10.0, 100.0)
    candidates = []
    for ridge in ridge_grid:
        weights = fit_logistic(x_train, y_train, ridge)
        candidates.append((metrics(y_validation, sigmoid(x_validation @ weights))["logLoss"], ridge, weights))
    _, selected_ridge, selected_weights = min(candidates, key=lambda item: item[0])

    x_test = np.asarray([feature_row(row["prior"], row["gold"], row["minute"]) for row in test])
    y_test = np.asarray([row["target"] for row in test])
    prediction = sigmoid(x_test @ selected_weights)
    baseline = np.asarray([row["prior"] for row in test])
    per_minute = {}
    minute_gates = {}
    for minute in (10, 15, 20):
        indices = [index for index, row in enumerate(test) if row["minute"] == minute]
        minute_rows = [test[index] for index in indices]
        model_metrics = metrics(y_test[indices], prediction[indices])
        prior_metrics = metrics(y_test[indices], baseline[indices])
        bootstrap = clustered_bootstrap(
            minute_rows,
            prediction[indices],
            baseline[indices],
            "seriesId",
            "series_id",
        )
        per_minute[str(minute)] = {
            "model": model_metrics,
            "frozenPrior": prior_metrics,
            "bootstrap": bootstrap,
        }
        minute_gates[str(minute)] = (
            model_metrics["logLoss"] < prior_metrics["logLoss"]
            and model_metrics["brier"] < prior_metrics["brier"]
            and bootstrap["upper95"] < 0
        )

    model_metrics = metrics(y_test, prediction)
    prior_metrics = metrics(y_test, baseline)
    bootstrap = {
        "byMap": clustered_bootstrap(test, prediction, baseline, "matchId", "map_id"),
        "bySeries": clustered_bootstrap(test, prediction, baseline, "seriesId", "series_id"),
    }
    prior_sources = sorted({str(row.get("priorSource", "unknown")) for row in maps})
    has_serving_prior_parity = prior_sources == ["active_formula_prequential_oof"]
    gate_passed = (
        has_serving_prior_parity
        and model_metrics["logLoss"] < prior_metrics["logLoss"]
        and model_metrics["brier"] < prior_metrics["brier"]
        and bootstrap["byMap"]["upper95"] < 0
        and bootstrap["bySeries"]["upper95"] < 0
        and all(minute_gates.values())
    )

    report = {
        "schemaVersion": 2,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "methodology": "chronological 65/15/20 split grouped by series; side-symmetric ridge logistic regression; fixed 10/15/20-minute snapshots; untouched test gate with map- and series-cluster bootstrap",
        "provenance": {
            "input": str(DATA.relative_to(ROOT)).replace("\\", "/"),
            "inputSha256": hashlib.sha256(data_bytes).hexdigest(),
            "priorSources": prior_sources,
            "servingPriorParity": has_serving_prior_parity,
        },
        "dataset": {
            "maps": len(maps),
            "series": len({str(row["seriesId"]) for row in maps}),
            "snapshots": len(snapshots),
            "train": len(train),
            "validation": len(validation),
            "test": len(test),
            "trainSeries": len(train_series),
            "validationSeries": len(validation_series),
            "testSeries": len(test_series),
            "split": "first 65% / next 15% / final 20% series by first-map chronology",
        },
        "features": ["frozenPriorLogit", "radiantGoldLeadThousands", "radiantGoldLeadThousandsXTime"],
        "selectedRidge": selected_ridge,
        "coefficients": [float(value) for value in selected_weights],
        "validationCandidates": [{"ridge": ridge, "logLoss": loss} for loss, ridge, _ in candidates],
        "test": {
            "model": model_metrics,
            "frozenPrior": prior_metrics,
            "logLossDelta": model_metrics["logLoss"] - prior_metrics["logLoss"],
            "brierDelta": model_metrics["brier"] - prior_metrics["brier"],
            "bootstrap": bootstrap,
            "byMinute": per_minute,
        },
        "validation": {
            "status": "active" if gate_passed else "observation_only",
            "gatePassed": gate_passed,
            "minuteGates": minute_gates,
            "gate": "active-draft prior parity; lower test log loss and Brier at aggregate and each fixed minute; map- and series-cluster bootstrap upper95 < 0; no validation claim after 20 minutes",
        },
        "sideFlip": "exact by construction; no intercept or side-asymmetric feature",
        "limitations": ["gold only; kills are display/guard telemetry", "validated only at fixed 10/15/20-minute snapshots", "times after 20 minutes are outside the validated range", "not a betting recommendation"],
    }
    model_id_payload = {
        "inputSha256": report["provenance"]["inputSha256"],
        "features": report["features"],
        "selectedRidge": report["selectedRidge"],
        "coefficients": report["coefficients"],
        "split": report["dataset"]["split"],
    }
    model_id = hashlib.sha256(json.dumps(model_id_payload, sort_keys=True).encode()).hexdigest()[:16]
    artifact = {
        "schemaVersion": 2,
        "modelId": model_id,
        "status": report["validation"]["status"],
        "trainedAt": report["generatedAt"],
        "provenance": report["provenance"],
        "training": report["dataset"],
        "features": report["features"],
        "coefficients": report["coefficients"],
        "minuteRange": [10, 20],
        "test": report["test"],
        "validation": report["validation"],
        "sideFlip": report["sideFlip"],
        "limitations": report["limitations"],
    }
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    ARTIFACT.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(f"Live map model: {len(snapshots)} snapshots; test LL {report['test']['model']['logLoss']:.6f} vs prior {report['test']['frozenPrior']['logLoss']:.6f}; ridge {selected_ridge}; {report['validation']['status'].upper()}")


if __name__ == "__main__":
    main()
