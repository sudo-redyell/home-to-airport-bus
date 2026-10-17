'use strict';

/* ─────────────────────────────────────────────────────────────────
 * 공항버스 LIVE (듀오링고 풍)
 *  모드 A 출발 정류장→공항 / 모드 B 공항→도착 정류장
 *  카드 슬롯 2개 — 조회 API(서울 BMS/경기 GBIS)를 드랍다운으로 지정
 *  지역·노선·정류장·터미널·인증키는 ⚙ 설정에서 저장(localStorage)
 *  서울 BMS: 이 키로 도착예정 미제공 → 첫/막차+배차 시간표 예측
 *  경기 GBIS: 초 단위 실시간
 * ───────────────────────────────────────────────────────────────── */

const FRESH_SEC_G = 120;
const FRESH_SEC_S = 120;
const MODE_NAMES = { A: '출발지→공항', B: '공항→출발지' };
let MODE = 'A';

/* ─── 설정(v2: 카드 슬롯 × API 드랍다운) ───────────────────────── */
const CFG_LS = 'ablive:config:v3';
const DEF_SEOUL = { route: '6007', departArs: '19822', destArs: '19823' };
const DEF_GYEONG = { aR: '7200-1', bR: '7200-1', departName: '의정부시외버스터미널', departStopId: '207000594', destStopId: '207000001', svcFirst: '', svcLast: '' };
const DEFAULT_CONFIG = () => ({
  terminal: 'T2',
  t1Ars: '92604', t2Ars: '92702',
  cards: [
    { api: 'seoul', seoul: { ...DEF_SEOUL }, gyeong: { ...DEF_GYEONG } },
    { api: 'gyeong', seoul: { ...DEF_SEOUL }, gyeong: { ...DEF_GYEONG } },
  ],
});
function loadConfig() {
  const base = DEFAULT_CONFIG();
  try {
    const raw = localStorage.getItem(CFG_LS);
    if (!raw) return base;
    const saved = JSON.parse(raw);
    if (saved.terminal === 'T1') base.terminal = 'T1';
    for (let i = 0; i < 2; i++) {
      const s = (saved.cards || [])[i] || {};
      if (s.api === 'seoul' || s.api === 'gyeong') base.cards[i].api = s.api;
      const merge = (d, src) => {
        for (const k of Object.keys(d)) {
          const v = src ? String(src[k] ?? '') : '';
          if (v.trim()) d[k] = v.trim();
        }
      };
      merge(base.cards[i].seoul, s.seoul || {});
      merge(base.cards[i].gyeong, s.gyeong || {});
    }
    return base;
  } catch { return base; }
}
let CONFIG = loadConfig();
const saveConfig = () => { try { localStorage.setItem(CFG_LS, JSON.stringify(CONFIG)); } catch { /* noop */ } };
const csv = (t) => String(t ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/* ─── 카드 슬롯 ───────────────────────────────────────────────── */
const CARDS = [
  { key: 'c1', domId: '6007', idx: 0 },
  { key: 'c2', domId: '7200', idx: 1 },
];
const cardApi = (idx) => (CONFIG.cards[idx] || {}).api || 'seoul';
const cardCfg = (idx) => {
  const c = CONFIG.cards[idx] || { seoul: {}, gyeong: {} };
  return c.api === 'gyeong' ? c.gyeong : c.seoul;
};

function specFor(def) {
  if (cardApi(def.idx) === 'seoul') {
    const s = cardCfg(def.idx);
    const T = CONFIG.terminal;
    if (MODE === 'A') {
      return { api: 'seoul', boardArs: [s.departArs], boardName: '', destArs: null, destName: '', forceRoot: false };
    }
    const tArs = T === 'T1' ? CONFIG.t1Ars : CONFIG.t2Ars;
    return {
      api: 'seoul',
      boardArs: T === 'T1' ? [tArs] : ['35612', tArs],
      boardName: T === 'T1' ? '인천공항1층입국장(T1)' : '인천공항T2-B1층',
      destArs: [s.destArs], destName: '', forceRoot: true,
    };
  }
  const g = cardCfg(def.idx);
  const svcFirst = String(g.svcFirst ?? '').trim() || null;
  const svcLast = String(g.svcLast ?? '').trim() || null;
  return MODE === 'A'
    ? { api: 'gbis', stationId: g.departStopId, altIds: [], primary: [csv(g.aR)[0]], family: csv(g.aR), svcFirst, svcLast }
    : { api: 'gbis', stationId: g.destStopId, altIds: [], primary: [csv(g.bR)[0]], family: csv(g.bR), svcFirst, svcLast };
}

const state = new Map();
for (const def of CARDS) {
  state.set(def.key, {
    def, spec: null, phase: 'loading',
    data: null, updatedAt: null, timerId: null, inFlight: false, errMsg: null, errApiErr: null,
  });
}

const $ = (sel, elx = document) => elx.querySelector(sel);
const byId = (id) => document.getElementById(id);
const setText = (id, text) => { const n = byId(id); if (n) n.textContent = text; };
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const pad2 = (n) => String(n).padStart(2, '0');

/* ─── API 프록시 ──────────────────────────────────────────────── */
async function api(op, params) {
  const qs = new URLSearchParams({ op, ...params });
  const r = await fetch(`/api/bus?${qs}`, { headers: { Accept: 'application/json' } });
  let j = null;
  try { j = await r.json(); } catch { /* noop */ }
  if (j && j.ok === false && j.error) { // 서버 구조화 오류(쿼터/키/연결)
    throw Object.assign(new Error(j.error.title || '조회에 실패했어요'), { apiErr: j.error });
  }
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    if (j) detail = j.detail || (j.error && (j.error.detail || j.error.title)) || detail;
    throw new Error(detail);
  }
  return j;
}
const seoulItemList = (j) => {
  const b = j && j.msgBody;
  if (!b) return [];
  return Array.isArray(b.itemList) ? b.itemList : (b.itemList ? [b.itemList] : []);
};
const gbisList = (j) => {
  const b = j && j.response && j.response.msgBody;
  if (!b) return [];
  return Array.isArray(b.busArrivalList) ? b.busArrivalList : (b.busArrivalList ? [b.busArrivalList] : []);
};
const gbisOk = (j) => {
  const h = j && j.response && j.response.msgHeader;
  return !!h && Number(h.resultCode) === 0;
};

/* ─── 시간 유틸 ────────────────────────────────────────────────── */
const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const toMinYmd = (t) => {
  const s = String(t ?? '');
  if (!s.trim()) return null;
  const h = Number(s.slice(8, 10));
  const m = Number(s.slice(10, 12));
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  return h * 60 + m;
};
const fromYmd = (t) => {
  const m2 = toMinYmd(t);
  return m2 == null ? '--:--' : fromMin(m2);
};
const fromMin = (mins) => `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; };
const humanMin = (m) => {
  const mm = Math.round(m);
  if (mm <= 0) return '곧 도착';
  const h = Math.floor(mm / 60);
  return h ? `${h}시간 ${mm % 60}분` : `${mm}분`;
};
const clockText = () => {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const stopNameOf = (s) => String((s && (s.stationNm ?? s.stopNm ?? s.stopName)) ?? '').trim() || '?';

/* ─── 데이터 로드 ──────────────────────────────────────────────── */
const findStop = (stops, arsList) => arsList.map((a) => stops.find((x) => String(x.arsId) === a)).find(Boolean) || null;

async function loadSeoul(st) {
  const spec = st.spec;
  const c = cardCfg(st.def.idx);
  const routes = seoulItemList(await api('getBusRouteList', { strSrch: c.route }));
  if (!routes.length) throw new Error(`"${c.route}" 검색 결과가 없습니다.`);
  const pick = routes.find((x) => String(x.routeType) === '1') || routes.find((x) => String(x.busRouteNm).trim() === c.route) || routes[0];

  const stops = seoulItemList(await api('getStaionByRoute', { busRouteId: pick.busRouteId }));
  const board = findStop(stops, spec.boardArs);
  if (!board) throw new Error(`승선 정류소(${spec.boardArs.join(',')})를 경유지 목록에서 못 찾음`);

  const destItem = spec.destArs ? findStop(stops, spec.destArs) : null;
  if (spec.destArs && !destItem) throw new Error('도착 정류소를 못 찾음');

  const term = Math.max(1, parseInt(pick.term, 10) || 1);
  const rootFirst = toMinYmd(pick.firstBusTm);
  const rootLast = toMinYmd(pick.lastBusTm);
  const bb = toMin(board.beginTm);
  const bl = toMin(board.lastTm);

  let b; let l2; let timeSrc;
  if (!spec.forceRoot && bb != null && bl != null) {
    b = bb; l2 = bl; timeSrc = 'stop';
  } else if (rootFirst != null && rootLast != null) {
    b = rootFirst; l2 = rootLast; timeSrc = 'root';
  } else if (bb != null) {
    b = bb; l2 = bl ?? bb + 18 * 60; timeSrc = 'stop';
  } else {
    throw new Error('시간표 기점 정보 없음');
  }

  const arrivals = [];
  for (let t = b; t <= l2 && arrivals.length < 300; t += term) arrivals.push(t);

  const boardSeq = Number(board.seq);
  const destSeq = destItem != null ? Number(destItem.seq) : null;
  const remaining = stops.filter((s) => +s.seq > boardSeq && (destSeq == null || +s.seq < destSeq));

  st.data = {
    pick, stops, board, destItem, term, timeSrc,
    boardFirst: b, boardLast: l2,
    arrivals, remaining,
    corp: String(pick.corpNm || '-').split(/\s{2,}/)[0],
  };
  st.phase = 'live';
  st.updatedAt = Date.now();
}

async function loadGbis(st) {
  const spec = st.spec;
  const j = await api('getBusArrivalListv2', { stationId: spec.stationId });
  if (!gbisOk(j)) {
    const h = j && j.response && j.response.msgHeader;
    throw new Error((h && (h.resultMessage || 'GBIS 응답 오류')) || 'GBIS 응답 오류');
  }
  const list = gbisList(j);
  const norm = (x) => String(x ?? '').trim().toUpperCase();
  const mine = list.find((it) => spec.primary.includes(norm(it.routeName))) || null;
  const isAirportRoute = (it) => { const t = String(it.routeTypeCd ?? ''); return t === '51' || t === '53'; };
  const others = list.filter((it) => {
    const name = norm(it.routeName);
    if (spec.primary.includes(name)) return false;
    return spec.family.includes(name) || isAirportRoute(it);
  });

  st.data = { mine, others };
  st.phase = 'live';
  st.updatedAt = Date.now();
}

async function loadCard(key) {
  const st = state.get(key);
  if (st.inFlight) return;
  st.inFlight = true;
  try {
    st.spec = specFor(st.def);
    if (st.spec.api === 'seoul') await loadSeoul(st);
    else await loadGbis(st);
  } catch (err) {
    st.spec = st.spec || specFor(st.def);
    st.phase = 'error';
    st.errApiErr = (err && err.apiErr) || null; // 구조화 친화 오류(제목/상세) 렌더용
    st.errMsg = String((err && err.message) || err); // 내부 상세
    if (!st.data) {
      clearTimeout(st.timerId);
      st.timerId = setTimeout(() => loadCard(key), 30000);
    }
  } finally {
    st.inFlight = false;
    renderBody(key);
    headTexts();
  }
  scheduleAuto(key);
}

function scheduleAuto(key) {
  const st = state.get(key);
  clearTimeout(st.timerId);
  const sec = st.spec && st.spec.api === 'seoul' ? FRESH_SEC_S : FRESH_SEC_G;
  st.timerId = setTimeout(() => loadCard(key), sec * 1000);
}

/* ─── 렌더링 (구버전 UI 복원 v4) ────────────────────────────────── */
const fill = (node, frags) => {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
  for (const f of frags) node.appendChild(f);
};
const fillById = (id, frags) => { fill(byId(id), frags); };
const mini = (text) => el('span', 'mini-badge', text);
const txt = (t) => document.createTextNode(t);
const airportNm = () => (CONFIG.terminal === 'T1' ? '인천공항T1' : '인천공항T2');
const dayPct = () => Math.max(0, Math.round((nowMin() / 1440) * 100));
const gfield = (it, keys) => {
  for (const k of keys) {
    const v = Number(it ? it[k] : null);
    if (Number.isInteger(v) && v > 0) return v;
  }
  return null;
};
const PREF_KEYS = ['predictTime', 'predictTime1', 'remainTime', 'arrBusTime'];

function stopChipNo(stop, mine, plane) {
  const blank = !String((stop && stop.arsId) ?? '').trim();
  const base = stopNameOf(stop);
  const chip = el('span', `stop-chip${mine ? ' mine' : ''}${blank ? ' virtual' : ''}`);
  chip.title = `${base} · arsId ${String((stop && stop.arsId) ?? '').trim()} · ${plane} 방면`;
  chip.appendChild(el('span', 'no', String(Number(stop.seq) + 1)));
  chip.appendChild(txt(base));
  return chip;
}

function cardTitle(def) {
  const st = state.get(def.key);
  const api = cardApi(def.idx);
  const c = cardCfg(def.idx);
  if (api === 'seoul') {
    if (MODE === 'B') return CONFIG.terminal === 'T1' ? '인천공항1층입국장(T1)' : '인천공항T2-B1층';
    return (st.data && st.data.board) ? stopNameOf(st.data.board) : `서울 ${c.route} · 조회 중`;
  }
  if (MODE === 'B') return `인천공항(${CONFIG.terminal === 'T1' ? 'T1 승선' : 'T2 승선'})`;
  return c.departName || '경기 GBIS · 조회 중';
}
function destOf(def) {
  const api = cardApi(def.idx);
  const st = state.get(def.key);
  if (api === 'seoul') {
    if (st.data && st.data.destItem) return stopNameOf(st.data.destItem);
    return cardCfg(def.idx).destArs || '—';
  }
  return cardCfg(def.idx).departName || '—';
}

function headTexts() {
  setText('mode-toggle-label', MODE === 'A' ? MODE_NAMES.B : MODE_NAMES.A);
  const t1 = cardTitle(CARDS[0]); const t2 = cardTitle(CARDS[1]);
  setText('hero-sub', MODE === 'A'
    ? `${t1} · ${t2} → 인천공항(${CONFIG.terminal})`
    : `인천공항(${CONFIG.terminal}) → ${destOf(CARDS[0])} · ${destOf(CARDS[1])}`);
  for (const def of CARDS) {
    const api = cardApi(def.idx);
    const c = cardCfg(def.idx);
    const st = state.get(def.key);
    setText(`head-${def.domId}-title`, cardTitle(def));
    let sub;
    if (api === 'seoul') {
      if (MODE === 'A') {
        sub = `${airportNm()} 방면 · 정류소 ${c.departArs}`;
        if (st.data && st.data.remaining.length) sub += ` (다음: ${stopNameOf(st.data.remaining[0])})`;
      } else {
        const tArs = st.spec ? st.spec.boardArs[st.spec.boardArs.length - 1] : (CONFIG.terminal === 'T1' ? CONFIG.t1Ars : CONFIG.t2Ars);
        sub = `${destOf(def)} 방면 · 승선 arsId ${tArs}`;
      }
    } else if (MODE === 'A') {
      sub = `인천공항 방면 · 정류소 ${c.departStopId}`;
    } else {
      sub = `${c.departName || '출발 정류장'} 방면 · 정류소 ${c.destStopId}`;
    }
    setText(`head-${def.domId}-sub`, sub);
    const badge = api === 'seoul' ? c.route : (MODE === 'A' ? csv(c.aR)[0] : csv(c.bR)[0]);
    setText(`badge-${def.domId}`, badge || '-');
    const bn = byId(`badge-${def.domId}`);
    if (bn) bn.className = `route-badge ${api === 'seoul' ? 'badge-green' : 'badge-orange'}`;
    setText(`src-${def.domId}`, api === 'seoul' ? '서울 BMS' : '경기 GBIS');
    const sn = byId(`src-${def.domId}`);
    if (sn) sn.className = `src-chip ${api === 'seoul' ? 'chip-seoul' : 'chip-gbis'}`;
  }
}

function loadingFrag(api) {
  const label = api === 'seoul' ? '서울 BMS에 연결하는 중…' : '경기 GBIS(도착정보 v2)에 연결하는 중…';
  const box = el('div', 'state-loading');
  box.appendChild(el('span', 'owl mascot-float', '🦉'));
  box.appendChild(el('p', null, label));
  return [box];
}

function errorFrag(st) {
  const box = el('div', 'state-error');
  box.appendChild(el('span', 'owl mascot-float', '🦉'));
  const env = st.errApiErr;
  if (env) {
    box.appendChild(el('p', null, env.title || '조회에 실패했어요'));
    if (env.detail) box.appendChild(el('small', 'err-detail', env.detail));
  } else {
    box.appendChild(el('p', null, `조회 실패 — ${st.errMsg ?? '원인 불명'}`));
  }
  const note = el('div', 'live-note');
  note.appendChild(el('b', null, '자동 재시도'));
  note.appendChild(el('span', null, '잠시 후 다시 조회합니다'));
  box.appendChild(note);
  return [box];
}

function seoulBody(st) {
  const d = st.data;
  const now = nowMin();
  const upcoming = d.arrivals.filter((t) => t >= now);
  const next = upcoming[0] ?? null;
  const done = next == null;
  const plane = MODE === 'A' ? airportNm() : (d.destItem ? stopNameOf(d.destItem) : airportNm());

  const wrap = el('div', 'sched-wrap');
  wrap.style.display = 'grid';
  wrap.style.gap = '0.9rem';

  const status = el('div', 'schedule-status');
  const big = el('div', `sched-big${done ? ' night' : ''}`);
  if (done) {
    big.appendChild(el('b', null, fromMin(d.boardFirst)));
    big.appendChild(el('span', null, '내일 첫차'));
  } else {
    const m = Math.max(0, Math.round(next - now));
    big.appendChild(el('b', null, m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}` : String(m)));
    big.appendChild(el('span', null, '분 남음'));
  }
  status.appendChild(big);
  const copy = el('div', 'sched-copy');
  copy.appendChild(el('strong', null, done ? '오늘 운행 종료' : `${plane} 방면 도착 예정`));
  copy.appendChild(el('small', null, `금일 첫차 ${fromMin(d.boardFirst)} · ${d.term}분 간격`));
  status.appendChild(copy);
  wrap.appendChild(status);

  const track = el('div', 'progress-track');
  const bar = el('div', 'progress-fill');
  bar.style.width = `${dayPct()}%`;
  track.appendChild(bar);
  wrap.appendChild(track);

  const chips = el('div', 'time-chips');
  upcoming.slice(0, 4).forEach((t, i) => {
    const chip = el('span', `time-chip${i === 0 ? ' is-next' : ''}`);
    chip.appendChild(txt(fromMin(t)));
    if (i === 0) chip.appendChild(el('small', null, '다음'));
    chips.appendChild(chip);
  });
  wrap.appendChild(chips);

  const stat = el('div', 'stat-grid');
  const statItem = (v, k) => {
    const s = el('div', 'stat');
    s.appendChild(el('b', null, v));
    s.appendChild(el('span', null, k));
    return s;
  };
  stat.appendChild(statItem(fromMin(d.boardFirst), '이 정류소 첫버스'));
  stat.appendChild(statItem(fromMin(d.boardLast), '이 정류소 막버스'));
  stat.appendChild(statItem(`${d.term}분`, '배차간격'));
  stat.appendChild(statItem(d.corp, '운수사'));
  wrap.appendChild(stat);

  const line = el('div', 'route-line');
  line.appendChild(el('span', 'section-kicker', `탑승 후 남은 경유정류소 ${d.remaining.length}곳 · ${plane} 방면`));
  const chipsRow = el('div', 'route-chips');
  chipsRow.appendChild(stopChipNo(d.board, true, plane));
  for (const s of d.remaining) chipsRow.appendChild(stopChipNo(s, false, plane));
  line.appendChild(chipsRow);
  wrap.appendChild(line);

  const fn = el('p', 'foot-note');
  fn.appendChild(txt('서울 BMS에서 이 키로 정류소 도착예정 메시지를 제공하지 않아'));
  fn.appendChild(el('br'));
  fn.appendChild(el('b', null, `이 정류소 첫차 ${fromMin(d.boardFirst)}부터 ${d.term}분 간격 시간표 예측`));
  fn.appendChild(txt(`으로 표시 (기점 ${fromYmd(d.pick.firstBusTm) ?? '--:--'} · 막영 ${fromYmd(d.pick.lastBusTm) ?? '--:--'})`));
  wrap.appendChild(fn);

  const outer = el('div');
  outer.appendChild(wrap);
  const fn2 = el('p', 'foot-note');
  fn2.appendChild(el('b', null, '서울 BMS'));
  fn2.appendChild(txt(` ws.bus.go.kr · 노선 ${d.pick.busRouteId} · 갱신 ${clockText()}`));
  outer.appendChild(fn2);
  return [outer];
}

function gbisBody(st) {
  const d = st.data;
  const g = cardCfg(st.def.idx);
  const dirWord = MODE === 'A' ? '공항행' : '의정부행';
  const endNm = (it) => (MODE === 'A'
    ? (String((it && it.routeDestName) || '').trim() || '인천공항')
    : (g.departName || '출발 정류장'));
  if (!d.mine && !d.others.length) {
    const box = el('div', 'state-error');
    box.appendChild(el('span', 'owl mascot-float', '🦉'));
    box.appendChild(el('p', null, '해당 노선 도착정보가 없습니다.'));
    box.appendChild(el('p', 'live-note', '곧 다시 조회합니다'));
    return [box];
  }

  const grid = el('div');
  grid.style.display = 'grid';
  grid.style.gap = '0.7rem';

  const note = el('div', 'live-note');
  const nv = el('div');
  nv.appendChild(el('b', null, `${dirWord} ${endNm(d.mine || d.others[0] || null)} 방면 · 실시간 트래킹`));
  nv.appendChild(el('span', null, `정류소 ${st.spec.stationId} · ${FRESH_SEC_G}초 자동갱신`));
  note.appendChild(nv);
  const dot = el('span', 'live-dot');
  dot.appendChild(el('i'));
  dot.appendChild(txt('LIVE'));
  note.appendChild(dot);
  grid.appendChild(note);

  const live = d.mine;
  const sec = gfield(live, PREF_KEYS);
  const sFirst = toMin(st.spec.svcFirst);
  const sLast = toMin(st.spec.svcLast);
  const nowm = nowMin();
  const hasWin = sFirst != null && sLast != null;
  const svcPast = hasWin && nowm > sLast;
  const svcEarly = hasWin && nowm < sFirst;

  if ((!live || sec == null) && (svcPast || svcEarly)) {
    // 운행 시각 창 밖(설정 기준) — 카드1(서울 시간표) 운행종료 레이아웃 파리티
    const wrap = el('div', 'sched-wrap');
    wrap.style.display = 'grid';
    wrap.style.gap = '0.9rem';
    const status = el('div', 'schedule-status');
    const big = el('div', 'sched-big night');
    big.appendChild(el('b', null, fromMin(sFirst)));
    big.appendChild(el('span', null, svcPast ? '내일 첫차' : '오늘 첫차'));
    status.appendChild(big);
    const copy = el('div', 'sched-copy');
    copy.appendChild(el('strong', null, svcPast ? '오늘 운행 종료' : '운행 시작 전'));
    copy.appendChild(el('small', null, `금일 첫차 ${st.spec.svcFirst} · 막차 ${st.spec.svcLast}`));
    status.appendChild(copy);
    wrap.appendChild(status);
    grid.appendChild(wrap);
  } else {
    const row = el('div', 'bus-row');
    const eta = el('div', `bus-eta${live && sec != null ? '' : ' off'}`);
    if (live && sec != null) {
      const mmv = Math.round(sec / 60);
      if (mmv >= 1) {
        eta.appendChild(el('b', null, mmv >= 60 ? `${Math.floor(mmv / 60)}시간 ${mmv % 60}` : String(mmv)));
        eta.appendChild(el('span', null, '분'));
      } else {
        eta.appendChild(el('b', null, String(sec)));
        eta.appendChild(el('span', null, '초'));
      }
    } else {
      eta.appendChild(el('b', null, '🦉'));
      eta.appendChild(el('span', null, '트래킹 대기'));
    }
    row.appendChild(eta);
    const meta = el('div', 'bus-meta');
    const routeLabel = live ? String(live.routeName ?? '-') : (MODE === 'A' ? csv(g.aR)[0] : csv(g.bR)[0]);
    const shortDir = MODE === 'A' ? '인천공항' : (g.departName || '출발 정류장');
    meta.appendChild(el('b', null, `${routeLabel || '-'} · ${shortDir} 방면`));
    const where = el('span', 'where');
    if (live && sec != null) {
      const bits = [];
      const prevN = String(live.stationNm1 ?? '').trim();
      if (prevN) bits.push(`${prevN} 지나`);
      const locn = gfield(live, ['locationNo1', 'locationNo']);
      if (locn != null) bits.push(`${locn} 정류장 전`);
      const seat = Number(live.remainSeatCnt1 ?? live.remainSeatCnt);
      if (Number.isInteger(seat) && seat >= 0) bits.push(`잔여좌석 ${seat}`);
      const plate = String(live.plateNo1 ?? '').trim();
      if (plate) bits.push(plate);
      where.textContent = bits.join(' · ') || '도착 예정 차량을 트래킹하는 중';
    } else if (hasWin && !svcPast && !svcEarly) {
      where.textContent = '지금은 도착 예정 차량이 트래킹되지 않는 중. 출발 전 배차는 GBIS 실시간에 미표기될 수 있으니 조금 뒤 다시 확인합니다.';
    } else {
      where.textContent = '지금은 도착 예정 차량이 트래킹되지 않는 중(운행 종료·대기 배차). 설정에서 첫차·막차 시각을 입력하면 운행 종료 안내가 표시돼요.';
    }
    meta.appendChild(where);
    row.appendChild(meta);
    grid.appendChild(row);
  }
  if (d.others.length) {
    const others = el('div', 'others');
    others.appendChild(el('span', 'section-kicker', '같은 정류소 다른 공항버스'));
    for (const it of d.others) {
      const osec = gfield(it, PREF_KEYS);
      const orow = el('div', 'other-row');
      orow.appendChild(el('b', null, String(it.routeName ?? '-')));
      orow.appendChild(txt(endNm(it)));
      orow.appendChild(el('span', `eta${osec != null ? '' : ' off'}`, osec != null ? `${Math.max(1, Math.round(osec / 60))}분` : '정보 없음'));
      others.appendChild(orow);
    }
    grid.appendChild(others);
  }

  const fn1 = el('p', 'foot-note');
  fn1.appendChild(el('b', null, '경기 GBIS 도착정보 v2'));
  fn1.appendChild(txt(` · 초 단위 실시간(predictTimeSec) · 조회 ${clockText()}`));
  grid.appendChild(fn1);

  const outer = el('div');
  outer.appendChild(grid);
  const fn2 = el('p', 'foot-note');
  fn2.appendChild(el('b', null, '경기 GBIS'));
  fn2.appendChild(txt(` apis.data.go.kr/6410000 · 정류소 ${st.spec.stationId} · 갱신 ${clockText()}`));
  outer.appendChild(fn2);
  return [outer];
}

function renderBody(key) {
  const st = state.get(key);
  const box = byId(`body-${st.def.domId}`);
  if (!box) return;
  const api = st.spec ? st.spec.api : cardApi(st.def.idx);
  if (st.phase === 'loading') { fill(box, loadingFrag(api)); return; }
  if (st.phase === 'error') { fill(box, errorFrag(st)); return; }
  fill(box, api === 'seoul' ? seoulBody(st) : gbisBody(st));
}

/* ─── 설정 모달 ───────────────────────────────────────────────── */
function toggleApiGroups(n, api) {
  const gs = byId(`c${n}-grp-seoul`); const gg = byId(`c${n}-grp-gyeong`);
  if (gs) gs.hidden = api !== 'seoul';
  if (gg) gg.hidden = api !== 'gyeong';
}

function openModal() {
  const m = byId('settings-modal');
  if (!m) return;
  for (let i = 0; i < 2; i++) {
    const n = i + 1;
    const card = CONFIG.cards[i];
    const sel = byId(`cfg-c${n}-api`);
    if (sel) sel.value = card.api;
    const set = (id, v) => { const x = byId(id); if (x) x.value = v; };
    set(`c${n}-s-route`, card.seoul.route);
    set(`c${n}-s-depart`, card.seoul.departArs);
    set(`c${n}-s-dest`, card.seoul.destArs);
    set(`c${n}-g-ar`, card.gyeong.aR);
    set(`c${n}-g-br`, card.gyeong.bR);
    set(`c${n}-g-depart`, card.gyeong.departStopId);
    set(`c${n}-g-dest`, card.gyeong.destStopId);
    set(`c${n}-g-svcf`, card.gyeong.svcFirst);
    set(`c${n}-g-svcl`, card.gyeong.svcLast);
    toggleApiGroups(n, card.api);
  }
  const t2 = byId('cfg-terminal-t2'); const t1 = byId('cfg-terminal-t1');
  if (t2) t2.checked = CONFIG.terminal === 'T2';
  if (t1) t1.checked = CONFIG.terminal === 'T1';
  const k = byId('cfg-service-key'); if (k) k.value = '';
  fetch('/api/service-key', { headers: { Accept: 'application/json' } })
    .then((r) => r.json())
    .then((j) => setText('key-status', j.have ? `저장된 인증키 있음 (마지막 4자리 ···${j.tail})` : '저장된 인증키 없음 — 서버 .env 기본값 사용 중'))
    .catch(() => setText('key-status', '키 상태 확인 실패'));
  m.hidden = false;
}
const closeModal = () => { const m = byId('settings-modal'); if (m) m.hidden = true; };

function saveFromModal() {
  const val = (id) => { const n = byId(id); return n ? String(n.value).trim() : ''; };
  const put = (obj, k, raw) => { if (raw) obj[k] = raw; };
  for (let i = 0; i < 2; i++) {
    const n = i + 1;
    const card = CONFIG.cards[i];
    const sel = byId(`cfg-c${n}-api`);
    if (sel && (sel.value === 'seoul' || sel.value === 'gyeong')) card.api = sel.value;
    put(card.seoul, 'route', val(`c${n}-s-route`));
    put(card.seoul, 'departArs', val(`c${n}-s-depart`));
    put(card.seoul, 'destArs', val(`c${n}-s-dest`));
    put(card.gyeong, 'aR', val(`c${n}-g-ar`));
    put(card.gyeong, 'bR', val(`c${n}-g-br`));
    put(card.gyeong, 'departStopId', val(`c${n}-g-depart`));
    put(card.gyeong, 'destStopId', val(`c${n}-g-dest`));
    put(card.gyeong, 'svcFirst', val(`c${n}-g-svcf`));
    put(card.gyeong, 'svcLast', val(`c${n}-g-svcl`));
  }
  const t1 = byId('cfg-terminal-t1');
  CONFIG.terminal = t1 && t1.checked ? 'T1' : 'T2';

  const key = val('cfg-service-key');
  if (key) {
    fetch('/api/service-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ key }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setText('key-status', `인증키 저장 완료 (마지막 4자리 ···${j.tail}) — 이후 노출되지 않습니다`);
        else setText('key-status', `저장 실패 — ${j.detail ?? '형식 확인'}`);
      })
      .catch(() => setText('key-status', '저장 실패 — 네트워크 오류'));
  }
  saveConfig();
  closeModal();
  loadFresh();
}
function resetFromModal() {
  CONFIG = JSON.parse(JSON.stringify(DEFAULT_CONFIG()));
  saveConfig();
  openModal();
  loadFresh();
}

/* ─── 모바일: 한 카드 스와이프 전환 ───────────────────────────── */
const MOBILE_LS = 'ablive:mobile:slot';
const isMobile = () => {
  let uaM = false;
  let touch = false;
  let coarse = false;
  let narrow = false;
  try { uaM = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || ''); } catch { /* noop */ }
  try {
    touch = Number(navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
  } catch { /* noop */ }
  try {
    if (typeof matchMedia === 'function') {
      coarse = matchMedia('(pointer: coarse)').matches;
      narrow = matchMedia('(max-width: 920px)').matches;
    }
  } catch { /* noop */ }
  if (narrow && (uaM || touch || coarse)) return true;
  if (uaM && (touch || coarse)) return true;
  return false;
};
let mobileSlot = (() => { try { const v = localStorage.getItem(MOBILE_LS); return v === '1' ? 1 : 0; } catch { return 0; } })();
let mDotsBuilt = false;

function setMobileSlot(idx) {
  mobileSlot = idx;
  try { localStorage.setItem(MOBILE_LS, String(idx)); } catch { /* noop */ }
  applyMobileView();
}
function applyMobileView() {
  const dots = byId('m-dots');
  const setNav = (disp) => {
    for (const eid of ['m-prev', 'm-next']) {
      const nn = byId(eid);
      if (nn) nn.style.display = disp;
    }
  };
  if (!isMobile()) {
    for (const def of CARDS) {
      const c = byId(`card-${def.domId}`);
      if (c) c.style.display = '';
    }
    setNav('none');
    if (dots) dots.hidden = true;
    return;
  }
  setNav('flex');
  if (dots && !mDotsBuilt) {
    for (const def of CARDS) {
      const dot = el('span', 'm-dot');
      if (dot.dataset) dot.dataset.slot = String(def.idx);
      dot.addEventListener('click', () => setMobileSlot(def.idx));
      dots.appendChild(dot);
    }
    mDotsBuilt = true;
  }
  if (dots) {
    dots.hidden = false;
    for (let k = 0; k < dots.children.length; k++) {
      const dn = dots.children[k];
      if (!dn) continue;
      if (k === mobileSlot) { if (dn.classList) dn.classList.add('on'); }
      else if (dn.classList) dn.classList.remove('on');
    }
  }
  for (const def of CARDS) {
    const c = byId(`card-${def.domId}`);
    if (c) c.style.display = mobileSlot === def.idx ? '' : 'none';
  }
}
function bindSwipe() {
  for (const def of CARDS) {
    const c = byId(`card-${def.domId}`);
    if (!c) continue;
    let sx = 0; let sy = 0; let has = false;
    c.addEventListener('touchstart', (e) => {
      const t = e && e.touches && e.touches[0];
      if (!t) return;
      sx = t.clientX; sy = t.clientY; has = true;
    });
    c.addEventListener('touchend', (e) => {
      if (!has) return;
      has = false;
      const t = e && e.changedTouches && e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - sx; const dy = t.clientY - sy;
      if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy)) return;
      const other = def.idx === 0 ? CARDS[1] : CARDS[0];
      setMobileSlot(other.idx);
    });
  }
}

/* ─── 이벤트 바인딩 & 부트 ─────────────────────────────────────── */
function loadFresh() {
  headTexts();
  for (const def of CARDS) {
    const st = state.get(def.key);
    clearTimeout(st.timerId);
    st.phase = 'loading';
    renderBody(def.key);
    loadCard(def.key);
  }
  applyMobileView();
}
function bind() {
  const on = (id, ev, fn) => { const n = byId(id); if (n) n.addEventListener(ev, fn); };
  on('mode-toggle', 'click', () => { MODE = MODE === 'A' ? 'B' : 'A'; loadFresh(); });
  on('refresh-all', 'click', loadFresh);
  on('btn-settings', 'click', openModal);
  on('cfg-backdrop', 'click', closeModal);
  on('cfg-close', 'click', closeModal);
  on('cfg-save', 'click', saveFromModal);
  on('cfg-reset', 'click', resetFromModal);
  for (const n of [1, 2]) {
    const sel = byId(`cfg-c${n}-api`);
    if (sel) sel.addEventListener('change', () => toggleApiGroups(n, sel.value));
  }
  for (const eid of ['m-prev', 'm-next']) {
    on(eid, 'click', () => setMobileSlot(mobileSlot === 0 ? 1 : 0));
  }
  bindSwipe();
  if (typeof addEventListener === 'function') addEventListener('resize', applyMobileView);
}
function tickClock() { setText('clock', clockText()); }

function init() {
  bind();
  tickClock();
  const tid = setInterval(tickClock, 1000);
  if (tid && typeof tid === 'object' && tid.unref) tid.unref();
  loadFresh();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
