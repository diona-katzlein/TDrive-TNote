#!/bin/sh
# Administrator-installed Linux wrapper; invoked in a private per-request directory.
set -eu
case "$PWD" in */tdrive-preview-*) ;; *) exit 64 ;; esac
name="tdrive-preview-$(basename "$PWD")"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
# Same absolute mount path preserves the service's input/output/profile arguments.
# No application files, credentials, host network, or other preview jobs are mounted.
docker run --rm --name "$name" --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 512m --memory-swap 512m --cpus 1 --pids-limit 64 \
  --ulimit fsize=67108864:67108864 --ulimit nofile=256:256 \
  --user "$(id -u):$(id -g)" --tmpfs /tmp:rw,nosuid,nodev,size=128m \
  --mount "type=bind,src=$PWD,dst=$PWD" --workdir "$PWD" \
  tdrive-preview-office:local "$@"
