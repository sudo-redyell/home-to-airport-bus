#!/usr/bin/env bash
# 공항버스 샘플페이지 서버 종료
set -Eeuo pipefail
readonly PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly PID_FILE="${PROJECT_DIR}/.runtime/airport-bus.pid"

if [[ -f "${PID_FILE}" ]]; then
  pid="$(<"${PID_FILE}")" || true
  if [[ "${pid}" =~ ^[1-9][0-9]*$ ]] && ps -p "${pid}" -o args= 2>/dev/null | grep -q "server.mjs"; then
    kill "${pid}" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 "${pid}" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "${pid}" 2>/dev/null || true
    echo "종료 완료. PID: ${pid}"
  else
    echo "PID 파일이 관리 중 프로세스를 가리키지 않습니다."
  fi
  rm -f -- "${PID_FILE}"
  exit 0
fi

pids="$(pgrep -f "${PROJECT_DIR}/server.mjs" 2>/dev/null || true)"
if [[ -n "${pids}" ]]; then
  echo "${pids}" | xargs -r kill
  echo "종료 완료: ${pids}"
else
  echo "실행 중인 프로세스가 없습니다."
fi
