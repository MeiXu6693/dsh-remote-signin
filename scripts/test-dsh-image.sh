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

# The activation line is the only proof the plugin applied. DSH prints it, not the
# entrypoint, so a container can answer /healthz a moment before the line exists —
# the health of Caddy is not the health of the plugin. Poll instead of grepping once;
# a normal boot answers on the first poll, so this costs nothing then.
ACTIVATION_TIMEOUT_S=20

# What a red run leaves behind. A public CI job must not upload the one-time bootstrap
# credentials DSH prints to its own log, so this is deliberately not the whole log: the
# entrypoint's and the plugin's own lines, the process state, and what the app user can
# actually read and import.
diagnose() {
    local name="$1" mode="$2"
    printf -- '--- %s: evidence\n' "${mode}" >&2
    docker inspect --format 'status={{.State.Status}} exit={{.State.ExitCode}} mounts={{json .Mounts}}' "${name}" >&2 || true
    printf -- '--- entrypoint and plugin entries\n' >&2
    docker logs "${name}" 2>&1 | grep -E '\[remote-signin\]|\[entrypoint\]' >&2 || true
    printf -- '--- the plugin as the app user (uid 1000)\n' >&2
    docker exec --user 1000 "${name}" sh -c 'ls -ln /app/node_modules/dsh-remote-signin /app/node_modules/dsh-remote-signin/src' >&2 || true
    docker exec --user 1000 "${name}" node -e '
        import("/app/node_modules/dsh-remote-signin/src/index.js")
            .then((module) => console.log("import ok:", module.name))
            .catch((error) => console.log("import failed:", error?.code ?? "", error?.message ?? error));
    ' >&2 || true
}

wait_for_activation() {
    local name="$1" waited=0
    while (( waited < ACTIVATION_TIMEOUT_S * 5 )); do
        if docker logs "${name}" 2>&1 | grep -q '\[remote-signin\] active.*claim http://127\.0\.0\.1:'; then
            return 0
        fi
        sleep 0.2
        waited=$(( waited + 1 ))
    done
    return 1
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
        diagnose "${name}" "${mode}"
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
    if ! wait_for_activation "${name}"; then
        diagnose "${name}" "${mode}"
        fail "${mode}: plugin did not report an active loopback claim within ${ACTIVATION_TIMEOUT_S}s"
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
