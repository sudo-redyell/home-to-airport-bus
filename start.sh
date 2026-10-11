#!/usr/bin/env bash
# 공항버스 샘플페이지 서버를 백그라운드로 시작합니다. (기본 바인딩 0.0.0.0:4175)
# dday_csw/start.sh와 동일한 수준의 PID 가드/헬스체크를 적용했습니다.
set -Eeuo pipefail

readonly PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly RUNTIME_DIR="${PROJECT_DIR}/.runtime"
readonly PID_FILE="${RUNTIME_DIR}/airport-bus.pid"
readonly LOG_FILE="${RUNTIME_DIR}/airport-bus.log"

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  local candidate
  candidate="$(find "$HOME"/.nvm/versions/node -maxdepth 3 -name node -path '*/bin/node' 2>/dev/null | sort -V | tail -n 1 || true)"
  if [[ -n "${candidate}" && -x "${candidate}" ]]; then
    printf '%s\n' "${candidate}"
    return 0
  fi
  return 1
}

readonly BIND_HOST="${HOST:-0.0.0.0}"
readonly BIND_PORT="${PORT:-4175}"
readonly HEALTH_HOST="${BIND_HOST/0.0.0.0/127.0.0.1}"
readonly HEALTH_URL="http://${HEALTH_HOST}:${BIND_PORT}/"

is_healthy() {
  command -v curl >/dev/null 2>&1 \
    && curl --fail --silent --show-error --connect-timeout 1 --max-time 2 --output /dev/null "${HEALTH_URL}"
}

is_managed_process() {
  local pid="$1"
  local command
  command="$(ps -p "${pid}" -o args= 2>/dev/null || true)"
  [[ "${command}" == *"${PROJECT_DIR}/server.mjs"* ]]
}

cleanup_stale_pid() {
  if [[ ! -f "${PID_FILE}" ]]; then return; fi
  local pid
  pid="$(<"${PID_FILE}")"
  if [[ ! "${pid}" =~ ^[1-9][0-9]*$ ]] || ! kill -0 "${pid}" 2>/dev/null; then
    rm -f -- "${PID_FILE}"
  fi
}

readonly NODE_BIN="$(find_node)" || { echo "오류: Node.js를 찾지 못했습니다. (PATH 또는 ~/.nvm 확인)" >&2; exit 1; }
if [[ "$("${NODE_BIN}" -p 'parseInt(process.versions.node.split(".")[0])')" -lt 20 ]]; then
  echo "오류: Node.js 20 이상이 필요합니다. 현재 버전: $(${NODE_BIN} --version)" >&2
  exit 1
fi

if [[ ! -f "${PROJECT_DIR}/public/index.html" ]]; then
  echo "오류: public/index.html이 없습니다. 정적 파일을 먼저 배치하세요." >&2
  exit 1
fi

mkdir -p -- "${RUNTIME_DIR}"
chmod 700 -- "${RUNTIME_DIR}"
touch "${LOG_FILE}"
chmod 600 -- "${LOG_FILE}"
cleanup_stale_pid

if [[ -f "${PID_FILE}" ]]; then
  pid="$(<"${PID_FILE}")"
  if is_managed_process "${pid}"; then
    echo "공항버스 샘플페이지가 이미 실행 중입니다. PID: ${pid}"
    echo "로그: ${LOG_FILE}"
    exit 0
  fi
  echo "오류: PID 파일이 현재 프로세스를 가리키지 않습니다. $(cat "${PID_FILE}")" >&2
  exit 1
fi

if is_healthy; then
  echo "이미 서빙 중입니다(관리 프로세스 아님): ${HEALTH_URL}"
  exit 0
fi

echo "공항버스 샘플페이지 서버를 시작합니다..."
cd -- "${PROJECT_DIR}"
HOST="${HOST:-0.0.0.0}" PORT="${PORT:-4175}" nohup "${NODE_BIN}" "${PROJECT_DIR}/server.mjs" </dev/null >>"${LOG_FILE}" 2>&1 &
pid=$!
printf '%s\n' "${pid}" > "${PID_FILE}"
chmod 600 -- "${PID_FILE}"

for _ in {1..25}; do
  if ! kill -0 "${pid}" 2>/dev/null; then
    rm -f -- "${PID_FILE}"
    echo "오류: 서버를 시작하지 못했습니다. 최근 로그:" >&2
    tail -n 30 -- "${LOG_FILE}" >&2 || true
    exit 1
  fi
  if is_healthy; then
    echo "실행 중. PID: ${pid}"
    echo "접속 주소: http://$(hostname -I | awk '{print $1}'):${BIND_PORT}/"
    echo "로그: ${LOG_FILE}"
    exit 0
  fi
  sleep 0.15
done

echo "프로세스는 살아 있지만 헬스체크 응답이 늦습니다. PID: ${pid}"
echo "로그: ${LOG_FILE}"
