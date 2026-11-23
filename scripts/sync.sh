#!/usr/bin/env bash
# Pushes the working tree to ~/reckon on the shared GCP testbench VM (code only; no node_modules, no data, no screenshots).
set -euo pipefail
cd "$(dirname "$0")/.."
TMP="${TMPDIR:-/tmp}/reckon-sync.tgz"
tar czf "$TMP" --exclude=data --exclude=scratch --exclude=.git --exclude=shots --exclude=node_modules .
gcloud compute scp "$TMP" testbench:/tmp/reckon-sync.tgz --zone us-central1-a >/dev/null
gcloud compute ssh testbench --zone us-central1-a --command 'mkdir -p ~/reckon && cd ~/reckon && tar xzf /tmp/reckon-sync.tgz && rm -f /tmp/reckon-sync.tgz && echo synced; true'
