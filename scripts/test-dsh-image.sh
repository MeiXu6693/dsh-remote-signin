#!/usr/bin/env bash
# Validate the shipped plugin and the current checkout against a pulled DSH image.
# Temporary containers only; this test never sends real credentials to DeepSeek.
set -Eeuo pipefail
IMAGE="${1:?usage: test-dsh-image.sh <image>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKDIR="$(mktemp -d)"
PREFIX="dsh-rs-ci-$$"
PASSWORD='test-only-password'
cleanup() {
    for suffix in bundled checkout edge disabled; do
        docker rm -fv "${PREFIX}-${suffix}" >/dev/null 2>&1 || true
    done
    rm -rf "${WORKDIR}" 2>/dev/null || sudo rm -rf "${WORKDIR}" 2>/dev/null || true
}
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
code() { curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' "$@"; }
port_for() {
    node -e 'const s = require("node:net").createServer(); s.listen(0,"127.0.0.1",() => {console.log(s.address().port);s.close()})'
}

run_case() {
    local mode="$1" port name url status ready=0
    port="$(port_for)"; name="${PREFIX}-${mode}"; url="http://127.0.0.1:${port}"
    local -a extra=()
    case "${mode}" in
        checkout|edge) extra+=(--mount "type=bind,src=${ROOT},dst=/app/node_modules/dsh-remote-signin,readonly") ;;
    esac
    [[ "${mode}" != edge ]] || extra+=(--env "PUBLIC_URL=${url}")
    [[ "${mode}" != disabled ]] || extra+=(--env REMOTE_SIGNIN=off)
    docker run --detach --name "${name}" \
        --env 'ALLOWED_CLIENTS=127.0.0.1,172.16.0.0/12' \
        --env "DSH_PASSWORD=${PASSWORD}" \
        --publish "127.0.0.1:${port}:8080" \
        --security-opt seccomp=unconfined --security-opt systempaths=unconfined \
        "${extra[@]}" "${IMAGE}" >/dev/null
    for _ in $(seq 1 90); do
        if curl --silent --fail --max-time 3 "${url}/healthz" >/dev/null 2>&1; then ready=1; break; fi
        if [[ "$(docker inspect --format '{{.State.Running}}' "${name}" 2>/dev/null)" != true ]]; then break; fi
        sleep 2
    done
    if [[ "${ready}" != 1 ]]; then
        # Logs may include one-time bootstrap credentials. Keep diagnostics to
        # process status rather than uploading container logs to a public CI job.
        docker inspect --format '{{.State.Status}} exit={{.State.ExitCode}}' "${name}" >&2 || true
        fail "${mode}: container did not become healthy"
    fi

    status="$(code "${url}/remote-signin/inpage.js")"
    [[ "${status}" == 401 ]] || fail "${mode}: panel without login returned ${status}, expected 401"
    if [[ "${mode}" == disabled ]]; then
        status="$(code --user "dsh:${PASSWORD}" "${url}/remote-signin/inpage.js")"
        [[ "${status}" != 200 ]] || fail 'disabled plugin still serves the panel'
        if docker logs "${name}" 2>&1 | grep -q '\[remote-signin\] active'; then
            fail 'disabled plugin reported itself active'
        fi
        printf 'ok %s: plugin disabled and panel unavailable\n' "${mode}"
        return
    fi
    if ! docker logs "${name}" 2>&1 | grep -q '\[remote-signin\] active.*claim http://127\.0\.0\.1:'; then
        fail "${mode}: plugin did not report an active loopback claim"
    fi
    status="$(code --user "dsh:${PASSWORD}" "${url}/remote-signin/inpage.js")"
    [[ "${status}" == 200 ]] || fail "${mode}: panel returned ${status}"
    curl --silent --show-error --fail --max-time 10 --user "dsh:${PASSWORD}" \
        --dump-header "${WORKDIR}/${mode}.headers" --output "${WORKDIR}/${mode}.js" "${url}/remote-signin/inpage.js"
    grep -iq '^cache-control:.*no-store' "${WORKDIR}/${mode}.headers" || fail "${mode}: panel must be no-store"
    if [[ "${mode}" == bundled ]]; then
        docker exec "${name}" cat /app/node_modules/dsh-remote-signin/assets/inpage.js > "${WORKDIR}/${mode}.expected"
    else
        cp "${ROOT}/assets/inpage.js" "${WORKDIR}/${mode}.expected"
    fi
    cmp -s "${WORKDIR}/${mode}.js" "${WORKDIR}/${mode}.expected" || fail "${mode}: panel bytes differ from plugin source"
    curl --silent --show-error --fail --location --max-time 15 --user "dsh:${PASSWORD}" \
        --cookie-jar "${WORKDIR}/${mode}.cookies" --cookie "${WORKDIR}/${mode}.cookies" \
        "${url}/" > "${WORKDIR}/${mode}.html"
    grep -q '/remote-signin/inpage.js' "${WORKDIR}/${mode}.html" || fail "${mode}: DSH document did not inject the panel"
    status="$(code --user "dsh:${PASSWORD}" "${url}/oauth/callback?code=fixture&state=fixture")"
    [[ "${status}" == 404 ]] || fail "${mode}: idle callback returned ${status}, expected 404"
    if [[ "${mode}" == edge ]]; then
        status="$(code --user "dsh:${PASSWORD}" -H 'Origin: https://foreign.example' "${url}/remote-signin/inpage.js")"
        [[ "${status}" == 403 ]] || fail "edge: foreign Origin returned ${status}, expected 403"
    fi
    printf 'ok %s: loaded, authenticated, panel injected and served, callback guarded\n' "${mode}"
}

for mode in bundled checkout edge disabled; do run_case "${mode}"; done
printf 'DSH image integration checks passed\n'
