// airport-bus :: 공항버스 실시간 조회 샘플페이지 서버 (제로 디펜던시)
// - public/ 정적 서빙 + /api/bus 업스트림 프록시
// - 인증키는 .env(SERVICE_KEY)로 서버에만 존재, 브라우저에 노출되지 않음
// - 업스트림
//   1) 서울 BMS 노선정보조회      http://ws.bus.go.kr/api/rest/busRouteInfo/...
//   2) 경기 GBIS 버스도착정보 v2   https://apis.data.go.kr/6410000/busarrivalservice/v2/...
// - 캐시(서울 300s / GBIS 15s)로 업스트림 트래픽 최소화(개발계정 분당/일일 호출량 대응)
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(ROOT_DIR, 'public');
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number.parseInt(process.env.PORT ?? '4175', 10);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  throw new Error(`잘못된 PORT 값입니다: ${process.env.PORT}`);
}

function loadEnvFile() {
  try {
    const raw = readFileSync(resolve(ROOT_DIR, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || line.trimStart().startsWith('#')) continue;
      const key = match[1];
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value && !(key in process.env)) process.env[key] = value;
    }
  } catch {
    // .env가 없으면 정적 서빙만 동작(/api/bus는 503)
  }
}
loadEnvFile();

let SERVICE_KEY = process.env.SERVICE_KEY || '';
const SEOUL_BASE = 'http://ws.bus.go.kr/api/rest/busRouteInfo';
const GBIS_BASE = 'https://apis.data.go.kr/6410000/busarrivalservice/v2';

// 서울 노선정보조회: 오퍼레이션명과 쿼리 파라미터(문서 상 getStaionByRoute 표기 그대로 사용)
const SEOUL_OPS = { getBusRouteList: 'strSrch', getStaionByRoute: 'busRouteId' };
// 경기 도착정보 v2: 정류소 전체 노선 목록. 개별 노선 필터는 클라이언트에서 수행
const GBIS_OPS = { getBusArrivalListv2: 'stationId' };

const cache = new Map(); // key -> { t, body }
const TTL = { seoul: 300_000, gbis: 15_000 };
const UPSTREAM_TIMEOUT_MS = 12_000;

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function callUpstream(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json,text/xml;q=0.9' } });
    const text = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status);
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function handleApiBus(url, res) {
  if (!SERVICE_KEY) { sendJson(res, 503, { error: 'SERVICE_KEY 미설정(.env 확인)' }); return; }
  const op = url.searchParams.get('op') || '';
  let kind;
  let paramKey;
  if (SEOUL_OPS[op]) { kind = 'seoul'; paramKey = SEOUL_OPS[op]; }
  else if (GBIS_OPS[op]) { kind = 'gbis'; paramKey = GBIS_OPS[op]; }
  else { sendJson(res, 400, { error: '지원하지 않는 op', op }); return; }

  const value = url.searchParams.get(paramKey) || '';
  if (!/^[0-9A-Za-z%.\-]{1,24}$/.test(value)) {
    sendJson(res, 400, { error: '파라미터 형식 오류', param: paramKey });
    return;
  }

  const full = kind === 'seoul'
    ? `${SEOUL_BASE}/${op}?ServiceKey=${SERVICE_KEY}&${paramKey}=${value}&resultType=json`
    : `${GBIS_BASE}/${op}?serviceKey=${SERVICE_KEY}&${paramKey}=${value}&resultType=json`;

  const hit = cache.get(full);
  const now = Date.now();
  if (hit && now - hit.t < TTL[kind]) {
    sendJson(res, 200, hit.body);
    return;
  }
  try {
    const body = await callUpstream(full);
    cache.set(full, { t: now, body });
    sendJson(res, 200, body);
  } catch (err) {
    const detail = err.name === 'AbortError' ? '업스트림 타임아웃' : String(err.message || err);
    if (hit) { sendJson(res, 200, hit.body); return; } // 실패 시 만료된 캐시라도 제공
    sendJson(res, 502, { error: '업스트림 조회 실패', detail });
  }
}

// ── 인증키 관리(설정에서 입력, 저장 후 노출 안 함: 마지막 4자만 안내) ──
function writeServiceKeyToEnv(newKey) {
  const p = resolve(ROOT_DIR, '.env');
  let lines = [];
  try { lines = readFileSync(p, 'utf8').split(/\r?\n/); } catch { lines = []; }
  const out = [];
  let found = false;
  for (const line of lines) {
    if (/^\s*SERVICE_KEY\s*=/.test(line)) { out.push(`SERVICE_KEY=${newKey}`); found = true; }
    else if (line.length) out.push(line);
  }
  if (!found) out.push(`SERVICE_KEY=${newKey}`);
  writeFileSync(p, out.join('\n') + '\n');
}

async function updateServiceKey(req, res) {
  const chunks = [];
  for await (const c of req) { chunks.push(c); if (Buffer.concat(chunks).length > 4096) break; }
  let key = '';
  try {
    const j = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    key = String((j && j.key) || '');
  } catch { key = Buffer.concat(chunks).toString('utf8').trim(); }
  key = key.trim();
  if (!/^[A-Za-z0-9%+/=]{30,}$/.test(key)) {
    sendJson(res, 400, { error: '일반 인증키 형식 검사 실패(30자 이상, 인코딩 여부 무관)' });
    return;
  }
  try {
    writeServiceKeyToEnv(key);
    SERVICE_KEY = key;
    cache.clear(); // 기존 키로 조회된 캐시 폐기
    sendJson(res, 200, { ok: true, tail: key.slice(-4) });
  } catch (err) {
    sendJson(res, 500, { error: '.env 저장 실패', detail: String((err && err.message) || err) });
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res) {
  const raw = new URL(req.url, 'http://localhost').pathname;
  let safe;
  try { safe = decodeURIComponent(raw); } catch { res.writeHead(400); res.end(); return; }
  if (safe === '/') safe = '/index.html';
  const abs = resolve(join(PUBLIC_DIR, normalize(safe)));
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  try {
    const data = await readFile(abs);
    res.writeHead(200, { 'Content-Type': MIME[extname(abs).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 not found');
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/bus') { await handleApiBus(url, res); return; }
    if (url.pathname === '/api/health') { sendJson(res, 200, { ok: true, ts: Date.now() }); return; }
    if (url.pathname === '/api/service-key') {
      if (req.method === 'POST') { await updateServiceKey(req, res); return; }
      sendJson(res, 200, { have: Boolean(SERVICE_KEY), tail: SERVICE_KEY ? SERVICE_KEY.slice(-4) : '' });
      return;
    }
    await serveStatic(req, res);
  } catch (err) {
    sendJson(res, 500, { error: String((err && err.message) || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[airport-bus] listening on http://${HOST}:${PORT}`);
});
