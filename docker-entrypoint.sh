#!/bin/sh
# Make sure the writable model directory exists on the data volume before the
# API starts. Nothing is copied into it: the server trains its own ratings and
# draft model from the matches it collects, so a fresh install never inherits
# another machine's models.
set -e

mkdir -p "${MODEL_DIR:-/app/data/models}" "${DATA_DIR:-/app/data}"

exec "$@"
