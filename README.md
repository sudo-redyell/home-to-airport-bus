# home-to-airport-bus

출발지역 ↔ 공항 구간 버스를 실시간으로 조회하는 웹페이지입니다.
서울 BMS(공공 OpenAPI 노선정보조회) 이용 시간표 예측과 경기 GBIS(버스도착정보 v2) 초 단위 실시간 도착정보를 듀오(duo) 스타일 UI로 한 화면에 제공합니다.

## 주요 기능
- 모드 A 출발지 → 공항 / 모드 B 공항 → 출발지 토글
- 카드 슬롯 2개 — ⚙ 설정에서 카드별 조회 API(서울 BMS / 경기 GBIS)를 드랍다운으로 지정
- 서울 BMS: 일반 인증키로 실시간 도착정보 미제공 → 노선 첫차/막차 + 배차간격 기반 시간표 예측 표시 (경유 정류소 칩 제공)
- 경기 GBIS: 초 단위 실시간 도착(남은 시간·차량번호·잔여좌석·현재 위치) + 같은 정류장 다른 노선 정보
- 모바일(≤920px + 터치/coarse/UA): 카드 1개 표시, 좌우 스와이프 · 상단 dot · 좌우 플로팅 화살표 버튼으로 카드 전환, 마지막 카드 기억
- 인증키·노선·정류장·터미널 설정은 localStorage + 서버 .env에 저장(브라우저에 키 노출 없음)

## 인증키 발급
1. ws.bus.go.kr(서울 노선정보조회 서비스) 또는 apis.data.go.kr(경기 버스도착정보 v2)에서 무료 신청
2. 일반 인증키 1개 발급(두 API 공용)
3. `.env`에 `SERVICE_KEY=` 옆에 URL-Encoded 값 그대로 입력

## 실행
```bash
cp .env.example .env        # SERVICE_KEY 입력
./start.sh                  # http://localhost:4175
# stop.sh / restart.sh 지원
```

별도 의존성 없음(node ≥ 18). 직접 실행도 가능합니다: `node server.mjs`

## 파일 구성
- `server.mjs` — 제로 디펜던시 프록시 + 정적 서버(키 서버 보관, 서울 300초 / GBIS 15초 응답 캐시)
- `public/` — index.html / styles.css / app.js (바닐라 JS), 운영 상세 메모는 public/README.md
- `.env.example` — 인증키 양식
