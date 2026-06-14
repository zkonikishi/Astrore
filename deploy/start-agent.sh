#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"
echo "Astrore Agent is starting at http://127.0.0.1:1421/"
echo "Keep this terminal open while using Astrore."
exec ./astrore-agent
