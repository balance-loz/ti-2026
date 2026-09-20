#!/bin/sh
# Prepare the writable directories on the data volume, then hand over.
#
# Nothing trained is copied in: the server fits its own models from the matches
# it collects. The one thing written here is the site password file, which the
# proxy reads from the same volume.
set -e

DATA="${DATA_DIR:-/app/data}"
mkdir -p "${MODEL_DIR:-$DATA/models}" "$DATA" "$DATA/import" "$DATA/auth"

if [ -n "${SITE_PASSWORD:-}" ]; then
  node -e '
    const { createHash } = require("node:crypto");
    const { writeFileSync } = require("node:fs");
    const user = process.env.SITE_USER || "admin";
    const digest = createHash("sha1").update(process.env.SITE_PASSWORD).digest("base64");
    writeFileSync(process.argv[1], `${user}:{SHA}${digest}\n`, { mode: 0o644 });
  ' "$DATA/auth/htpasswd"
  echo "[entrypoint] site password set for user ${SITE_USER:-admin}"
fi

exec "$@"
