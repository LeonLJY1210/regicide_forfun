/* ============================================================================
 * 弑君者 Regicide —— 联机服务器（权威服务器，客户端只发意图）
 *   node server.js [--port 3000]
 *   手机与电脑连同一 WiFi → 浏览器打开 http://<本机IP>:3000
 * ==========================================================================*/
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import * as G from './public/js/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const argPort = process.argv.includes('--port') ? Number(process.argv[process.argv.indexOf('--port') + 1]) : 0;
const PORT = argPort || Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ------------------------------------------------------------ 静态资源 */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    if (p === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
    if (p === '/lan') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ addresses: lanAddresses() }));
    }
    const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address);
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 房间 */
const rooms = new Map();                       // code -> room
const CODE_CHARS = 'ACDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
function uniqueCode() { let c; do { c = newCode(); } while (rooms.has(c)); return c; }

function makeRoom(hostSock, cid, name, cfg) {
  const code = uniqueCode();
  const room = {
    code, hostCid: cid, cfg: { ...G.DEFAULT_CFG, ...(cfg || {}) },
    players: [], status: 'lobby', game: null, createdAt: Date.now(),
  };
  rooms.set(code, room);
  addPlayer(room, hostSock, cid, name);
  return room;
}

function addPlayer(room, ws, cid, name) {
  const seat = room.players.length;
  const p = { cid, name, ws, seat, connected: true };
  room.players.push(p);
  p.ws = ws;
  return p;
}

function findRoom(code) { return rooms.get(String(code || '').toUpperCase()); }
function playerOf(room, cid) { return room.players.find((p) => p.cid === cid); }

function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, fn) {
  for (const p of room.players) {
    if (!p.connected || !p.ws) continue;
    if (!room.game) { send(p.ws, fn(p.seat, null)); continue; }
    send(p.ws, fn(p.seat, room.game));
  }
}

function roomInfo(room) {
  return {
    t: 'room', code: room.code, status: room.status,
    hostSeat: room.players.findIndex((p) => p.cid === room.hostCid),
    cfg: room.cfg,
    players: room.players.map((p) => ({ seat: p.seat, name: p.name, connected: p.connected })),
  };
}
function pushRoom(room) { broadcast(room, () => roomInfo(room)); }
function pushState(room) { broadcast(room, (seat, g) => ({ t: 'state', view: G.viewFor(g, seat) })); }

/* ------------------------------------------------------------ 游戏动作 */
function startGame(room, cfgPatch) {
  const n = room.players.length;
  if (n < 1 || n > 4) return '联机人数需要在 1–4 之间';
  room.cfg = { ...room.cfg, ...(cfgPatch || {}) };
  room.game = G.createGame({
    cfg: room.cfg,
    players: room.players.map((p) => p.name),
  });
  room.status = 'playing';
  return null;
}

const ACTIONS = {
  play: (g, seat, m) => G.applyPlay(g, seat, m.ids),
  yield: (g, seat) => G.applyYield(g, seat),
  defend: (g, seat, m) => G.applyDefend(g, seat, m.ids),
  next: (g, seat, m) => G.chooseNext(g, seat, m.nextIdx),
  flip: (g) => G.applyFlip(g),
  dev: (g, seat, m) => (m.sub === 'skip' ? G.devSkipEnemy(g) : G.devRefill(g, seat)),
};

function handleAction(room, p, m) {
  const g = room.game;
  if (!g) return '游戏还没开始';
  if (g.phase === 'won' || g.phase === 'lost') return '本局已结束';
  const fn = ACTIONS[m.a];
  if (!fn) return '未知动作';
  const r = fn(g, p.seat, m) || {};
  if (r.ok === false) return r.reason;
  if (g.phase === 'won' || g.phase === 'lost') room.status = 'over';
  return null;
}

/* ------------------------------------------------------------ WebSocket */
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  let room = null, cid = null;

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    switch (m.t) {
      case 'create': {
        cid = m.cid;
        room = makeRoom(ws, cid, m.name || '玩家1', m.cfg);
        send(ws, { t: 'hello', cid });
        send(ws, roomInfo(room));
        send(ws, { t: 'you', seat: 0 });
        pushRoom(room);
        break;
      }
      case 'join': {
        cid = m.cid;
        const r = findRoom(m.code);
        if (!r) return send(ws, { t: 'err', msg: '房间不存在，请检查房号' });
        let exist = playerOf(r, cid);
        if (exist && exist.connected) exist = null;   // 同一浏览器开多标签时另起一个身份
        if (exist) {                                  // 断线重连
          exist.ws = ws; exist.connected = true; exist.name = m.name || exist.name;
          room = r;
        } else {
          if (r.status === 'playing') return send(ws, { t: 'err', msg: '该房间已经开局了' });
          if (r.players.length >= 4) return send(ws, { t: 'err', msg: '房间已满（最多 4 人）' });
          cid = 'p' + Math.random().toString(36).slice(2, 10);
          send(ws, { t: 'cid', cid });
          addPlayer(r, ws, cid, m.name || `玩家${r.players.length + 1}`);
          room = r;
        }
        send(ws, { t: 'hello', cid });
        send(ws, { t: 'you', seat: playerOf(r, cid).seat });
        pushRoom(r);
        if (r.game) pushState(r);
        break;
      }
      case 'cfg': {
        if (!room) return;
        if (cid !== room.hostCid) return send(ws, { t: 'err', msg: '只有房主能改设置' });
        room.cfg = { ...room.cfg, ...(m.cfg || {}) };
        pushRoom(room);
        break;
      }
      case 'start': {
        if (!room) return;
        if (cid !== room.hostCid) return send(ws, { t: 'err', msg: '只有房主能开始游戏' });
        const err = startGame(room, m.cfg);
        if (err) return send(ws, { t: 'err', msg: err });
        pushRoom(room);
        pushState(room);
        break;
      }
      case 'restart': {
        if (!room) return;
        if (cid !== room.hostCid) return send(ws, { t: 'err', msg: '只有房主能重开' });
        const err = startGame(room, m.cfg);
        if (err) return send(ws, { t: 'err', msg: err });
        pushRoom(room); pushState(room);
        break;
      }
      case 'act': {
        if (!room || !room.game) return;
        const p = playerOf(room, cid);
        if (!p) return;
        const err = handleAction(room, p, m);
        if (err) return send(ws, { t: 'err', msg: err });
        pushState(room);
        if (room.status === 'over') pushRoom(room);
        break;
      }
      case 'ping': send(ws, { t: 'pong', ts: m.ts }); break;
      case 'leave': {
        if (!room) return;
        const p = playerOf(room, cid);
        if (p) { p.connected = false; p.ws = null; }
        cleanup(room);
        pushRoom(room);
        break;
      }
      default: break;
    }
  });

  ws.on('close', () => {
    if (!room || !cid) return;
    const p = playerOf(room, cid);
    if (p) {
      p.connected = false; p.ws = null;
      if (room.hostCid === cid) {                     // 房主掉线 → 交给还在的人
        const alive = room.players.find((x) => x.connected);
        if (alive) room.hostCid = alive.cid;
      }
    }
    cleanup(room);
    if (rooms.has(room.code)) pushRoom(room);
  });
});

function cleanup(room) {
  const alive = room.players.filter((p) => p.connected);
  if (!alive.length) { rooms.delete(room.code); return; }
}

/* ---------------------------------------------------------------- 启动 */
server.listen(PORT, '0.0.0.0', () => {
  const addrs = lanAddresses();
  console.log('\n  弑君者 Regicide 服务已启动\n');
  console.log(`  本机访问：   http://localhost:${PORT}`);
  addrs.forEach((a) => console.log(`  局域网联机： http://${a}:${PORT}`));
  console.log('\n  手机与电脑连同一个 WiFi，用上面的局域网地址即可联机。\n');
});
