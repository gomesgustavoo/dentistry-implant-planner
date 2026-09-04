#!/usr/bin/env bash
# Build the three images at a tag and import them into k3s's containerd.
#
# Recovered 2026-09-01 with the rest of the deploy chain. There is NO registry and
# the deployments set `imagePullPolicy: IfNotPresent`, so **a same-tag rebuild will
# not roll**: k3s keeps the image it already has. Every deploy needs a new tag.
#
# Dev-box note: buffered writes to / run at ~7 MB/s here, so the api image (a ~360 MB
# layer set) takes minutes to build and minutes again to import. That is the disk,
# not a hang.
set -euo pipefail
cd "$(dirname "$0")"

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "usage: $0 <tag> [web|landing|api ...]" >&2
  echo "  e.g. $0 0.11.0            # all three" >&2
  echo "       $0 0.11.0 web        # just the app" >&2
  exit 2
fi
shift
TARGETS=("$@")
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(web landing api)

DOCKER="sudo docker"
CTR="sudo k3s ctr images import"

for t in "${TARGETS[@]}"; do
  case "$t" in
    web|landing|api) ;;
    *) echo "unknown target: $t" >&2; exit 2 ;;
  esac
  echo "=== building dentistry/$t:$TAG"
  $DOCKER build --build-arg "VERSION=$TAG" \
    -f "Dockerfile.$t" -t "dentistry/$t:$TAG" .
done

for t in "${TARGETS[@]}"; do
  echo "=== importing dentistry/$t:$TAG into k3s"
  $DOCKER save "dentistry/$t:$TAG" | $CTR -
done

echo
echo "built and imported: ${TARGETS[*]} @ $TAG"
echo "roll with:"
for t in "${TARGETS[@]}"; do
  echo "  sudo k3s kubectl -n dentistry set image deploy/dentistry-$t $t=dentistry/$t:$TAG"
done
