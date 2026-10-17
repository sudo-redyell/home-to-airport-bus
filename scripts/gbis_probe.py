#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GBIS 30분 간격 도착정보 프로브 → JSONL 로그.

- 목적: 7200/7200-1 실시간 표기 시작 시점 파악(쿼터-3일 관찰).
- 소스: 자기 서버의 앱 프록시(127.0.0.1:4175) 경유 — serviceKey 비노출.
- 기간: 2026-10-17 04:19 ~ 2026-10-20 21:55 KST. 범위 외 실행은 무조건 exit 0(cron 잔존 무해).
- 출력: logs/gbis-probe-YYYYMMDD.jsonl (UTF-8, 1행 1샘플, append).
"""
import json
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path("/home/redyell/workspace/project/airport-bus")
LOGDIR = ROOT / "logs"
URL = "http://127.0.0.1:4175/api/bus?op=getBusArrivalListv2&stationId=207000594"
KST = timezone(timedelta(hours=9))
START = datetime(2026, 10, 17, 4, 19, 0, tzinfo=KST)   # theo 첫차 04:19(7200)
END = datetime(2026, 10, 20, 21, 55, 0, tzinfo=KST)    # theo 막차 21:49(7200-1) 이후 여유


def base_entry(now):
    return {
        "ts": now.isoformat(timespec="seconds"),
        "source": "app-proxy",
        "op": "getBusArrivalListv2",
        "stationId": "207000594",
    }


def fetch_and_parse(entry):
    """로컬 프록시 1회 조회 결과를 entry에 반영. 예외는 error 필드로 기록."""
    try:
        with urllib.request.urlopen(URL, timeout=30) as r:
            raw = r.read().decode("utf-8", "replace")
        entry["http"] = 200
    except urllib.error.HTTPError as e:
        entry["http"] = e.code
        entry["error"] = "http-error"
        return
    except Exception as e:  # 네트워크/타임아웃 등
        entry["http"] = -1
        entry["error"] = "fetch-fail: %s: %s" % (type(e).__name__, e)
        return

    try:
        j = json.loads(raw)
    except ValueError:
        entry["error"] = "invalid-json"
        entry["raw_head"] = raw[:200]
        return

    if j.get("ok") is False:
        entry["error"] = "app-proxy-error: %s" % (j.get("error") or "unknown")
        return
    resp = j.get("response") or {}
    mh = resp.get("msgHeader") or {}
    body = resp.get("msgBody") or {}
    rows = body.get("busArrivalList") or []
    entry["resultCode"] = mh.get("resultCode")
    entry["resultMessage"] = mh.get("resultMessage", "")
    if entry["resultCode"] not in (0, None):
        entry["error"] = "gbis-error"  # 쿼터 초과(code 22) 등 감지용
        return
    routes = []
    for it in rows:
        routes.append({
            "routeName": str(it.get("routeName", "")),
            "routeId": it.get("routeId"),
            "typeCd": it.get("routeTypeCd"),
            "dest": it.get("routeDestName", ""),
            "predict1": it.get("predictTime1", ""),
            "predictSec1": it.get("predictTimeSec1", ""),
            "plate1": it.get("plateNo1", ""),
            "loc1": it.get("locationNo1", ""),
            "flag": it.get("flag", ""),
        })
    entry["count"] = len(routes)
    entry["routes"] = routes


def main():
    now = datetime.now(KST)
    if not (START <= now <= END):
        return 0  # 3일 관찰 기간 종료 → 자동 정지
    LOGDIR.mkdir(parents=True, exist_ok=True)
    entry = base_entry(now)
    try:
        fetch_and_parse(entry)
    except Exception as e:  # 최후 방어: 로그 실패 원인도 남긴다
        entry["error"] = "probe-exception: %s: %s" % (type(e).__name__, e)
    line = json.dumps(entry, ensure_ascii=False)
    with (LOGDIR / ("gbis-probe-%s.jsonl" % now.strftime("%Y%m%d"))).open("a", encoding="utf-8") as f:
        f.write(line + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
