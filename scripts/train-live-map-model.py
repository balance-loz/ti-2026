"""Train a side-symmetric live map model from frozen historical snapshots.

The rich draft dataset contains leakage-safe pre-draft probabilities and
Radiant gold advantage at 10/15/20 minutes.  We deliberately keep this model
small: it estimates the map winner from the frozen prior and the gold state,
without inventing coefficients for telemetry the historical dataset lacks.
"""
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "work" / "rich-draft-dataset.jsonl"
REPORT = ROOT / "work" / "live-map-model-report.json"
ARTIFACT = ROOT / "public" / "live-map-model.json"


def clamp_probability(value):
    return np.clip(np.asarray(value, dtype=float), 0.001, 0.999)


def logit(value):
    value = clamp_probability(value)
    return np.log(value / (1 - value))


def sigmoid(value):
    return 1 / (1 + np.exp(-np.clip(value, -20, 20)))


def metrics(target, probability):
    target = np.asarray(target, dtype=float)
    probability = clamp_probability(probability)
    return {
        "samples": int(len(target)),
        "logLoss": float(np.mean(-(target * np.log(probability) + (1 - target) * np.log(1 - probability)))),
        "brier": float(np.mean((probability - target) ** 2)),
        "accuracy": float(np.mean((probability >= 0.5) == target)),
    }


def chronological_series_split(rows):
    ordered = []
    seen = set()
    for row in rows:
        if row["seriesId"] not in seen:
            seen.add(row["seriesId"])
            ordered.append(row["seriesId"])
    train_end = int(len(ordered) * 0.65)
    validation_end = int(len(ordered) * 0.80)
    return set(ordered[:train_end]), set(ordered[train_end:validation_end]), set(ordered[validation_end:])


def feature_row(prior, gold_lead, minute):
    # No intercept or minute-only term: flipping sides negates every feature,
    # which guarantees p(Radiant) + p(Dire after side flip) == 1.
    gold_thousands = float(gold_lead) / 1000
    time = (float(minute) - 10) / 10
    return [float(logit(prior)), gold_thousands, gold_thousands * time]


def fit_logistic(features, target, ridge):
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


def main():
    maps = [json.loads(line) for line in DATA.read_text(encoding="utf8").splitlines() if line]
    train_series, validation_series, test_series = chronological_series_split(maps)
    snapshots = []
    for row in maps:
        for minute in (10, 15, 20):
            gold = row.get(f"gold{minute}")
            if gold is None:
                continue
            snapshots.append({
                "seriesId": row["seriesId"],
                "minute": minute,
                "prior": float(row["preDraftProbability"]),
                "gold": float(gold),
                "target": int(row["radiantWin"]),
            })

    def subset(series_ids):
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
    for minute in (10, 15, 20):
        indices = [index for index, row in enumerate(test) if row["minute"] == minute]
        per_minute[str(minute)] = {
            "model": metrics(y_test[indices], prediction[indices]),
            "frozenPrior": metrics(y_test[indices], baseline[indices]),
        }

    report = {
        "schemaVersion": 1,
        "methodology": "chronological 65/15/20 split by series; side-symmetric ridge logistic regression; one row per available 10/15/20-minute snapshot",
        "dataset": {"maps": len(maps), "snapshots": len(snapshots), "train": len(train), "validation": len(validation), "test": len(test)},
        "features": ["frozenPriorLogit", "radiantGoldLeadThousands", "radiantGoldLeadThousandsXTime"],
        "selectedRidge": selected_ridge,
        "coefficients": [float(value) for value in selected_weights],
        "validationCandidates": [{"ridge": ridge, "logLoss": loss} for loss, ridge, _ in candidates],
        "test": {"model": metrics(y_test, prediction), "frozenPrior": metrics(y_test, baseline), "byMinute": per_minute},
        "sideFlip": "exact by construction; no intercept or side-asymmetric feature",
        "limitations": ["gold only; kills are display/guard telemetry", "trained at 10/15/20 minutes; inference clamps time to this range", "not a betting recommendation"],
    }
    model_id = hashlib.sha256(json.dumps(report, sort_keys=True).encode()).hexdigest()[:16]
    artifact = {
        "schemaVersion": 1,
        "modelId": model_id,
        "status": "experimental",
        "trainedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "training": report["dataset"],
        "features": report["features"],
        "coefficients": report["coefficients"],
        "minuteRange": [10, 20],
        "test": report["test"],
        "sideFlip": report["sideFlip"],
        "limitations": report["limitations"],
    }
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    ARTIFACT.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(f"Live map model: {len(snapshots)} snapshots; test LL {report['test']['model']['logLoss']:.6f} vs prior {report['test']['frozenPrior']['logLoss']:.6f}; ridge {selected_ridge}")


if __name__ == "__main__":
    main()
