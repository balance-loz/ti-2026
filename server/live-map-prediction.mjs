const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, Number(value)));

const probabilityClamp = (value) => clamp(value, 0.01, 0.99);

const logit = (value) => {
  const probability = probabilityClamp(value);
  return Math.log(probability / (1 - probability));
};

const sigmoid = (value) => 1 / (1 + Math.exp(-clamp(value, -20, 20)));

export function assessLiveMap(game, liveProbabilityRadiant = null, { nowMs = Date.now() } = {}) {
  const phase = game?.phase === "draft" ? "draft" : "game";
  const gameTime = Math.max(0, Number(game?.gameTime || 0));
  const goldLead = Number.isFinite(Number(game?.radiantLead)) ? Number(game.radiantLead) : null;
  const killLead = Number(game?.radiantScore || 0) - Number(game?.direScore || 0);
  const aligned = goldLead === null || !goldLead || !killLead || Math.sign(goldLead) === Math.sign(killLead);
  const updateMs = Date.parse(game?.lastUpdateAt || "");
  const stale = Number.isFinite(updateMs) && nowMs - updateMs > 90_000;
  const probabilitySettled = gameTime >= 15 * 60 && Number.isFinite(liveProbabilityRadiant)
    && (Number(liveProbabilityRadiant) >= 0.9 || Number(liveProbabilityRadiant) <= 0.1);
  const telemetrySettled = phase === "game" && gameTime >= 10 * 60 && goldLead !== null && (
    Math.abs(goldLead) >= 15_000
    || (gameTime >= 20 * 60 && Math.abs(goldLead) >= 9_000 && Math.abs(killLead) >= 8 && aligned)
    || (gameTime >= 35 * 60 && Math.abs(goldLead) >= 6_000 && aligned)
  );
  const settled = probabilitySettled || telemetrySettled;
  const leaderSide = goldLead !== null && Math.abs(goldLead) >= 1_000
    ? (goldLead > 0 ? "radiant" : "dire")
    : Math.abs(killLead) >= 3 ? (killLead > 0 ? "radiant" : "dire") : null;
  return {
    phase,
    gameTime,
    goldLead,
    killLead,
    leaderSide,
    leader: leaderSide === "radiant" ? game?.radiantTeam : leaderSide === "dire" ? game?.direTeam : null,
    stale,
    settled,
    status: phase === "draft" ? "draft" : stale ? "stale" : settled ? "settled" : "in_progress",
    guard: phase === "draft" ? "draft_only" : stale ? "stale_feed" : settled ? "state_already_decided" : "observation_only",
  };
}

export function estimateLiveMap(model, { draftProbabilityRadiant, game } = {}) {
  const frozenDraftProbabilityRadiant = probabilityClamp(draftProbabilityRadiant ?? 0.5);
  if (!model || !Array.isArray(model.coefficients) || model.coefficients.length !== 3) {
    const assessment = assessLiveMap(game);
    return { frozenDraftProbabilityRadiant, liveProbabilityRadiant: null, stateImpactPp: null, availability: "model_unavailable", assessment, modelId: null };
  }
  if (model.validation?.gatePassed !== true) {
    const assessment = assessLiveMap(game);
    return { frozenDraftProbabilityRadiant, liveProbabilityRadiant: null, stateImpactPp: null, availability: "observation_only_failed_gate", assessment, modelId: model.modelId ?? null };
  }
  const gameTime = Math.max(0, Number(game?.gameTime || 0));
  const goldLead = Number.isFinite(Number(game?.radiantLead)) ? Number(game.radiantLead) : null;
  if (game?.phase === "draft" || gameTime < 10 * 60 || goldLead === null) {
    const assessment = assessLiveMap(game);
    return {
      frozenDraftProbabilityRadiant,
      liveProbabilityRadiant: null,
      stateImpactPp: null,
      availability: game?.phase === "draft" ? "draft" : goldLead === null ? "gold_unavailable" : "waiting_for_10_minutes",
      assessment,
      modelId: model.modelId ?? null,
    };
  }
  if (gameTime > Number(model.minuteRange?.[1] ?? 20) * 60) {
    const assessment = assessLiveMap(game);
    return {
      frozenDraftProbabilityRadiant,
      liveProbabilityRadiant: null,
      stateImpactPp: null,
      availability: "outside_validated_range_after_20",
      assessment,
      modelId: model.modelId ?? null,
    };
  }
  const minute = clamp(gameTime / 60, Number(model.minuteRange?.[0] ?? 10), Number(model.minuteRange?.[1] ?? 20));
  const goldThousands = goldLead / 1000;
  const features = [logit(frozenDraftProbabilityRadiant), goldThousands, goldThousands * ((minute - 10) / 10)];
  const rawLogitRadiant = features.reduce((sum, value, index) => sum + value * Number(model.coefficients[index] || 0), 0);
  const liveProbabilityRadiant = probabilityClamp(sigmoid(rawLogitRadiant));
  const assessment = assessLiveMap(game, liveProbabilityRadiant);
  const isValidatedCheckpoint = model.validation?.minuteGates?.[String(minute)] === true;
  return {
    frozenDraftProbabilityRadiant,
    liveProbabilityRadiant,
    stateImpactPp: (liveProbabilityRadiant - frozenDraftProbabilityRadiant) * 100,
    availability: isValidatedCheckpoint ? "validated_fixed_window" : "validated_window_interpolation",
    assessment,
    modelId: model.modelId ?? null,
    components: { frozenPriorLogit: features[0], goldLeadThousands: features[1], goldTimeInteraction: features[2], rawLogitRadiant },
  };
}
