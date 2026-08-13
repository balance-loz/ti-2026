function snapshotRoot(snapshot, snapshots) {
  const rootId = Number(snapshot.root_snapshot_id ?? snapshot.id);
  return snapshots.find((item) => Number(item.id) === rootId) ?? snapshot;
}

function isAutomaticOfficialRoot(snapshot) {
  return snapshot.snapshot_kind !== "revision"
    && snapshot.forecast_mode === "stats"
    && snapshot.trigger !== "manual_run";
}

function officialProfileKey(snapshot) {
  return snapshot.profile_key || `stats:${Number(snapshot.opinion_weight || 0)}`;
}

export function visibleSnapshotHistory(snapshots) {
  const rows = [];
  const officialProfiles = new Set();
  const originals = snapshots
    .filter((snapshot) => snapshot.snapshot_kind !== "revision" && Number(snapshot.root_snapshot_id ?? snapshot.id) === Number(snapshot.id))
    .sort((a, b) => Number(a.id) - Number(b.id));

  for (const snapshot of originals) {
    if (isAutomaticOfficialRoot(snapshot)) {
      const key = officialProfileKey(snapshot);
      if (officialProfiles.has(key)) continue;
      officialProfiles.add(key);
    }
    rows.push(snapshot);
  }

  return rows.sort((a, b) => Number(b.id) - Number(a.id));
}

export function latestSnapshotForHistoryRow(row, snapshots) {
  const root = snapshotRoot(row, snapshots);
  const rootId = Number(root.id);
  const candidates = isAutomaticOfficialRoot(root)
    ? snapshots.filter((snapshot) => {
      const candidateRoot = snapshotRoot(snapshot, snapshots);
      return isAutomaticOfficialRoot(candidateRoot) && officialProfileKey(candidateRoot) === officialProfileKey(root);
    })
    : snapshots.filter((snapshot) => Number(snapshot.root_snapshot_id ?? snapshot.id) === rootId);

  return candidates.sort((a, b) => Number(b.completed_match_count) - Number(a.completed_match_count) || Number(b.id) - Number(a.id))[0] ?? root;
}
