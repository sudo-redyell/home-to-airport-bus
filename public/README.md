# 공항버스 LIVE (airport-bus)

로컬 용도 샘플(비상업적, 재배포 금지). 투명 프록시 서버 + 듀오링고 풍 정적 페이지.

## 서비스 관리
- 시작 `./start.sh` / 중지 `./stop.sh` / 재시작 `./restart.sh`
- 로그 `.runtime/airport-bus.log` · 주소 `http://localhost:4175/(내부망)`
- 부팅 자동 시작: cron `@reboot` 등록됨

## 프록시 API
- `GET /api/bus?op=...&...`
  - 서울 BMS: `getBusRouteList(strSrch)`, `getStaionByRoute(busRouteId)`
  - 경기 GBIS: `getBusArrivalListv2(stationId)`
- `GET /api/health`
- `GET /api/service-key` / `POST /api/service-key` `{key}` → `.env` 갱신 + 캐시 클리어(마지막 4자만 노출)

## 페이지 동작
- **모드 A 출발 정류장→공항 / 모드 B 공항→도착 정류장** — 🔁 토글
- **카드 슬롯 2개**: 각 카드의 조회 API(서울 BMS/경기 GBIS)는 설정에서 드랍다운으로 지정
- 서울 BMS는 동 일반키로 도착예정 미제공 → 첫/막차 + 배차간격 기반 **시간표 예측**
- 경유 정류장 칩은 가로 스크롤 한 줄, GBIS 초 단위 실시간(`remainSeatCnt` -1은 숨김, `predictTime` 공란이면 운행종료/내일 첫차)
- 정류장 이름은 API 응답(서울 stationNm 등)에서 자동 파생
- 카드 본문 UI는 원본 구조 복원(v4): `sched-wrap`(남은시간·도착예정·첫차) + 진행바 + 다음 4개 시간 칩 + 통계(첫/막버스·배차·운수사) + 경유정류소 칩(mine/virtual/seq 번호) + 예측 안내 foot-note. GBIS는 `live-note`(공항행/의정부행 트래킹 + LIVE 점) + `bus-row`(남은시간/트래킹 대기) + 같은 정류소 다른 노선 + GBIS foot-note

## 📱 모바일
- 모바일 판정 강화(v4.1): ≤920px + (UA·터치디바이스·coarse 포인터), 또는 UA 모바일 + 터치/coarse — 삼성 브라우저 데스크톱 화면(와이드 뷰포트, 데스크톱 UA)에서도 터치 기기면 모바일 뷰 적용
- 모바일에서는 **카드 1개만 표시**하며 카드 레이아웃 상단 중앙의 점(dot) 2개로 현재 카드 표시(클릭 전환 가능)
- 카드 좌우 중앙에 투명한 ‹ › 전환 버튼, 좌우 스와이프로도 카드 전환
- 마지막 확인한 카드는 `ablive:mobile:slot`에 저장되어 재접속 시 복원

## ⚙️ 설정
- `localStorage('ablive:config:v2')` 저장, 미지정 시 기본값
- **기준 공항 터미널**: T1/T2 라디오 (arsId는 툴팁에 표시)
- **카드1/카드2**: 조회 API 드랍다운 → 서울(노선/출발 arsId/도착 arsId) 또는 경기(공항행·의정부행 노선 CSV, 출발 정류장 이름/stationId, 도착 stationId) 최소 필드만 입력
- **정류장 ID 조회 방법**: 서울 ws.bus.go.kr 노선 검색(경유 정류소 arsId), 경기 gbis.go.kr 정류장 검색(주소창 stationId) 링크 가이드
- **서비스 인증키**: ws.bus.go.kr + apis.data.go.kr(6410000) 동일 일반키 무료 신청 → 1회 입력(재노출 없음)
- **기본값** 버튼으로 초기화

## 기본 구성 데이터
- **서울 6007**: busRouteId `124000014` · 공항리무진 · 배차 35분 · 노선 04:30~22:35
  - 출발: 당산푸르지오아파트 `19822`(승차 04:58~20:23) · 도착: 영등포삼환아파트 `19823`
  - 터미널: T2-B1층 `92702`(seq 1) / T1 1층입국장 `92604`(seq 2)
- **경기 GBIS**: 출발(공항행측) `207000154` / 도착(의정부행측) `207000001`, 이름: 구)의정부3동우체국
  - 노선: 7200-1 / 7200 / N7200
