// КАБУ live: сервер. Вся логика игры здесь, телефоны только показывают состояние и шлют действия.
const express = require('express'), http = require('http'), path = require('path'), QRCode = require('qrcode');
const { Server } = require('socket.io');
const app = express(), srv = http.createServer(app), io = new Server(srv);
const PUB = path.join(__dirname, 'public');
app.use(express.static(PUB));
app.get('/host', (q, r) => r.sendFile(path.join(PUB, 'host.html')));
app.get('/qr.svg', async (q, r) => {
  try { r.type('image/svg+xml').send(await QRCode.toString(String(q.query.u || '').slice(0, 300), { type: 'svg', margin: 1 })); }
  catch (e) { r.status(400).end(); }
});

const TURN_MS = +process.env.TURN_MS || 45000;  // время на ход
const AWAY_MS = 4000;                           // ход игрока, который отключился
const PEEK_MS = 25000;                          // время на просмотр 2 карт в начале
const RK = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'], SU = ['♠', '♥', '♦', '♣'];
const POW = { 6: 'peekOwn', 7: 'peekOwn', 8: 'spy', 9: 'spy', 10: 'swap', 11: 'swap', 12: 'look' };
const val = c => c.r === 0 ? 0 : c.r === 13 ? ((c.s === 1 || c.s === 2) ? -2 : 13) : c.r;
const cname = c => c.r === 0 ? 'джокер' : RK[c.r] + SU[c.s];
const rid = () => Math.random().toString(36).slice(2, 10);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const games = new Map();
const nameOf = (g, tok) => (g.players.get(tok) || { name: '?' }).name;
const online = (g, tok) => !!(g.players.get(tok) || {}).online;

function makeDeck() {
  const d = [];
  for (let s = 0; s < 4; s++) for (let r = 1; r <= 13; r++) d.push({ r, s, code: RK[r] + 'SHDC'[s] });
  d.push({ r: 0, s: -1, code: 'JK1' }, { r: 0, s: -1, code: 'JK2' });
  shuffle(d); d.forEach(c => c.id = rid()); return d;
}
function log(t, s) { t.log.unshift(s); t.log.length = Math.min(t.log.length, 4); }
function mark(t, ids) { t.marks = ids; t.markAt = Date.now(); }
function draw(t) { if (!t.deck.length) { const top = t.discard.pop(); t.deck = shuffle(t.discard); t.discard = [top]; } return t.deck.pop(); }
function reveal(t, tok, id, ms) { (t.reveal[tok] = t.reveal[tok] || {})[id] = Date.now() + ms; setTimeout(() => push(t), ms + 60); }
function find(t, id) { for (const k of t.seats) { const i = t.hands[k].findIndex(c => c.id === id); if (i >= 0) return { k, i, c: t.hands[k][i] }; } return null; }
function penalty(t, tok, n) { for (let i = 0; i < n; i++) t.hands[tok].push(draw(t)); }

function startRound(t) {
  clearTimeout(t.timer); t.round++; t.deck = makeDeck(); t.hands = {};
  t.seats.forEach(k => t.hands[k] = t.deck.splice(-4));
  Object.assign(t, { discard: [t.deck.pop()], phase: 'peek', peeks: {}, reveal: {}, drawn: null, power: null, lookId: null,
    caboBy: null, turnNo: 0, cur: (t.round - 1) % t.seats.length, results: null, marks: [], log: [] });
  log(t, `Раунд ${t.round}. Посмотрите 2 свои карты`);
  t.deadline = Date.now() + PEEK_MS;
  t.timer = setTimeout(() => { if (t.phase === 'peek') beginTurns(t); }, PEEK_MS);
  push(t);
}
function beginTurns(t) { t.phase = 'turn'; t.reveal = {}; log(t, `Начали! Ходит ${nameOf(t.g, t.seats[t.cur])}`); startTimer(t); push(t); }
function startTimer(t) {
  clearTimeout(t.timer);
  const ms = online(t.g, t.seats[t.cur]) ? TURN_MS : AWAY_MS;
  t.deadline = Date.now() + ms; t.timer = setTimeout(() => auto(t), ms);
}
function auto(t) {
  const k = t.seats[t.cur];
  if (t.phase === 'turn') act(t, k, { type: 'draw' }, true);
  if (t.phase === 'drawn') act(t, k, { type: 'throw' }, true);
  if (t.phase === 'power') act(t, k, { type: 'skip' }, true);
}
function endTurn(t) {
  if (t.lookId && t.reveal[t.seats[t.cur]]) delete t.reveal[t.seats[t.cur]][t.lookId];
  t.phase = 'turn'; t.power = null; t.lookId = null; t.turnNo++;
  t.cur = (t.cur + 1) % t.seats.length;
  if (t.seats[t.cur] === t.caboBy) return endRound(t);
  startTimer(t); push(t);
}
function endRound(t) {
  clearTimeout(t.timer); t.phase = 'end'; t.deadline = null; t.drawn = null;
  const sums = {};
  t.seats.forEach(k => { sums[k] = t.hands[k].reduce((a, c) => a + val(c), 0); t.totals[k] = (t.totals[k] || 0) + sums[k]; });
  const min = Math.min(...Object.values(sums));
  t.results = { sums, winners: t.seats.filter(k => sums[k] === min) };
  log(t, 'Вскрытие! Победил: ' + t.results.winners.map(k => nameOf(t.g, k)).join(', '));
  push(t);
}

function act(t, me, a, isAuto) {
  if (!t || !t.seats.includes(me) || !a) return;
  const N = nameOf(t.g, me), H = t.hands[me], isCur = t.seats[t.cur] === me, ph = t.phase;
  const own = id => H.find(c => c.id === id);
  switch (a.type) {
    case 'peek': {
      if (ph !== 'peek' || (t.peeks[me] || 0) >= 2) return;
      const c = own(a.id); if (!c || (t.reveal[me] || {})[c.id]) return;
      t.peeks[me] = (t.peeks[me] || 0) + 1; reveal(t, me, c.id, 5000);
      if (t.seats.every(k => (t.peeks[k] || 0) >= 2 || !online(t.g, k))) {
        clearTimeout(t.timer); t.deadline = Date.now() + 5000;
        t.timer = setTimeout(() => { if (t.phase === 'peek') beginTurns(t); }, 5000);
      }
      break;
    }
    case 'draw': if (!isCur || ph !== 'turn') return; t.drawn = draw(t); t.phase = 'drawn'; break;
    case 'replace': {
      if (!isCur || ph !== 'drawn') return;
      const i = H.findIndex(c => c.id === a.id); if (i < 0) return;
      const old = H[i]; H[i] = t.drawn; t.drawn = null; t.discard.push(old);
      mark(t, [H[i].id]); log(t, `${N} заменил карту, в сброс: ${cname(old)}`); return endTurn(t);
    }
    case 'throw': {
      if (!isCur || ph !== 'drawn') return;
      const c = t.drawn; t.drawn = null; t.discard.push(c);
      log(t, `${N} сбросил ${cname(c)}${isAuto ? ' (время вышло)' : ''}`);
      const pw = POW[c.r]; if (!pw || isAuto) return endTurn(t);
      t.phase = 'power'; t.power = pw; break;
    }
    case 'peekOwn':
      if (!isCur || t.power !== 'peekOwn' || !own(a.id)) return;
      reveal(t, me, a.id, 3500); mark(t, [a.id]); log(t, `${N} посмотрел свою карту`); return endTurn(t);
    case 'spy': {
      if (!isCur || t.power !== 'spy') return;
      const f = find(t, a.id); if (!f || f.k === me) return;
      reveal(t, me, a.id, 3500); mark(t, [a.id]); log(t, `${N} посмотрел карту игрока ${nameOf(t.g, f.k)}`); return endTurn(t);
    }
    case 'swap': {
      if (!isCur || t.power !== 'swap') return;
      const m = find(t, a.mine), o = find(t, a.other); if (!m || !o || m.k !== me || o.k === me) return;
      t.hands[me][m.i] = o.c; t.hands[o.k][o.i] = m.c;
      mark(t, [m.c.id, o.c.id]); log(t, `${N} поменялся картой с ${nameOf(t.g, o.k)}`); return endTurn(t);
    }
    case 'look': {
      if (!isCur || t.power !== 'look') return;
      const f = find(t, a.id); if (!f || f.k === me) return;
      reveal(t, me, a.id, 120000); t.power = 'look2'; t.lookId = a.id;
      mark(t, [a.id]); log(t, `${N} смотрит карту игрока ${nameOf(t.g, f.k)}`); break;
    }
    case 'lookSwap': {
      if (!isCur || t.power !== 'look2') return;
      const m = find(t, a.mine), o = find(t, t.lookId);
      if (m && o && m.k === me && o.k !== me) {
        t.hands[me][m.i] = o.c; t.hands[o.k][o.i] = m.c;
        mark(t, [m.c.id, o.c.id]); log(t, `${N} забрал карту у ${nameOf(t.g, o.k)}`);
      }
      return endTurn(t);
    }
    case 'skip': if (!isCur || ph !== 'power') return; return endTurn(t);
    case 'kabu':
      if (!isCur || ph !== 'turn' || t.caboBy || t.turnNo < t.seats.length) return;
      t.caboBy = me; log(t, `${N} сказал КАБУ! У остальных последний ход`); return endTurn(t);
    case 'pair': {
      if (!['turn', 'drawn', 'power'].includes(ph)) return;
      const f = find(t, a.id), top = t.discard[t.discard.length - 1]; if (!f || !top) return;
      if (f.c.r === top.r) {
        t.hands[f.k].splice(f.i, 1); t.discard.push(f.c); if (t.lookId === f.c.id) t.lookId = null;
        if (f.k === me) log(t, `${N} сбросил пару: ${cname(f.c)}`);
        else { penalty(t, f.k, 2); log(t, `${N} сбросил пару за ${nameOf(t.g, f.k)} (${cname(f.c)}), ему 2 штрафные`); }
        mark(t, []);
      } else {
        reveal(t, me, f.c.id, 2000); penalty(t, me, 2);
        log(t, `${N} ошибся с парой (${cname(f.c)}), ему 2 штрафные`);
      }
      break;
    }
    case 'next': if (ph !== 'end') return; return startRound(t);
    default: return;
  }
  push(t);
}

function view(t, me) {
  const now = Date.now(), R = t.reveal[me] || {}, end = t.phase === 'end';
  return {
    table: t.no, round: t.round, me, phase: t.phase, power: t.power, cur: t.seats[t.cur], caboBy: t.caboBy,
    canKabu: !t.caboBy && t.turnNo >= t.seats.length, deck: t.deck.length, top: t.discard[t.discard.length - 1] || null,
    drawn: t.drawn ? (t.seats[t.cur] === me ? t.drawn : { hidden: true }) : null,
    deadline: t.deadline, now, peeks: t.peeks[me] || 0, marks: now - (t.markAt || 0) < 2500 ? t.marks : [],
    log: t.log, results: t.results,
    players: t.seats.map(k => ({
      tok: k, name: nameOf(t.g, k), online: online(t.g, k), total: t.totals[k] || 0,
      hand: t.hands[k].map(c => ({ id: c.id, face: end || R[c.id] > now ? c : null }))
    }))
  };
}
function push(t) {
  if (!t.g.tables.includes(t)) return;
  t.seats.forEach(k => { const p = t.g.players.get(k); if (p && p.sid) io.to(p.sid).emit('state', view(t, k)); });
  pushHost(t.g);
}
function pushHost(g) {
  if (!g.hostSid) return;
  io.to(g.hostSid).emit('host', {
    pin: g.pin, state: g.state,
    players: [...g.players.values()].map(p => ({ name: p.name, online: p.online, table: p.table })),
    tables: g.tables.map(t => ({
      no: t.no, round: t.round, phase: t.phase, cur: nameOf(g, t.seats[t.cur]), caboBy: t.caboBy ? nameOf(g, t.caboBy) : null,
      members: t.seats.map(k => ({ name: nameOf(g, k), total: t.totals[k] || 0, online: online(g, k) }))
    }))
  });
}
function lobbyPush(g) {
  g.players.forEach(p => { if (p.sid && p.table == null) io.to(p.sid).emit('lobby', { name: p.name, count: g.players.size, state: g.state }); });
  pushHost(g);
}
// Рассадка: столы по 4, остаток раскидывается так, чтобы были столы по 3 (10 → 4+3+3)
function startGame(g) {
  const ps = shuffle([...g.players.values()].filter(p => p.online)); if (ps.length < 2) return;
  g.tables.forEach(t => clearTimeout(t.timer));
  g.players.forEach(p => p.table = null);
  const k = Math.ceil(ps.length / 4), base = Math.floor(ps.length / k), extra = ps.length % k;
  g.tables = []; let idx = 0;
  for (let i = 0; i < k; i++) {
    const n = base + (i < extra ? 1 : 0), seats = ps.slice(idx, idx + n).map(p => p.tok); idx += n;
    g.tables.push({ no: i + 1, g, seats, totals: {}, round: 0, log: [] });
    seats.forEach(tok => g.players.get(tok).table = i);
  }
  g.state = 'playing'; g.tables.forEach(startRound); lobbyPush(g);
}
function toLobby(g) {
  g.tables.forEach(t => clearTimeout(t.timer)); g.tables = []; g.state = 'lobby';
  g.players.forEach(p => { if (!p.online) g.players.delete(p.tok); else p.table = null; });
  lobbyPush(g);
}

io.on('connection', s => {
  s.on('host:create', (d, cb) => {
    let g = d && games.get(String(d.pin));
    if (!g || g.hostKey !== d.key) {
      let pin; do pin = String(1000 + Math.random() * 9000 | 0); while (games.has(pin));
      g = { pin, hostKey: rid(), hostSid: null, state: 'lobby', players: new Map(), tables: [] }; games.set(pin, g);
    }
    g.hostSid = s.id; s.data.hostOf = g.pin;
    if (typeof cb === 'function') cb({ pin: g.pin, key: g.hostKey }); pushHost(g);
  });
  s.on('host:start', () => { const g = games.get(s.data.hostOf); if (g) startGame(g); });
  s.on('host:lobby', () => { const g = games.get(s.data.hostOf); if (g) toLobby(g); });
  s.on('join', (d, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const g = games.get(String((d && d.pin) || '').trim()); if (!g) return cb({ err: 'Игра с таким PIN не найдена' });
    const name = String(d.name || '').trim().slice(0, 20), tok = String(d.tok || '').slice(0, 20) || rid();
    let p = g.players.get(tok);
    if (!p) { if (!name) return cb({ err: 'Введи имя' }); p = { tok, name, sid: null, online: false, table: null }; g.players.set(tok, p); }
    else if (name) p.name = name;
    p.sid = s.id; p.online = true; s.data.pin = g.pin; s.data.tok = tok;
    cb({ ok: true, tok, pin: g.pin });
    if (p.table != null && g.tables[p.table]) push(g.tables[p.table]); else lobbyPush(g);
  });
  s.on('act', a => {
    const g = games.get(s.data.pin), p = g && g.players.get(s.data.tok);
    if (p && p.table != null) act(g.tables[p.table], p.tok, a);
  });
  s.on('disconnect', () => {
    const hg = games.get(s.data.hostOf); if (hg && hg.hostSid === s.id) hg.hostSid = null;
    const g = games.get(s.data.pin), p = g && g.players.get(s.data.tok);
    if (!p || p.sid !== s.id) return;
    p.online = false; p.sid = null;
    if (p.table != null && g.tables[p.table]) {
      const t = g.tables[p.table]; if (t.seats[t.cur] === p.tok && ['turn', 'drawn', 'power'].includes(t.phase)) startTimer(t); push(t);
    } else {
      setTimeout(() => { if (!p.online && p.table == null && g.state === 'lobby') { g.players.delete(p.tok); lobbyPush(g); } }, 60000);
      lobbyPush(g);
    }
  });
});

const PORT = process.env.PORT || 3000;
srv.listen(PORT, () => console.log(`КАБУ live: http://localhost:${PORT}/host`));
