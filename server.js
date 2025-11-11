// server.js
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 25000,
  pingTimeout: 20000,
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------------- Lobby, kö & matcher ----------------
let queue = []; // [{id, name}]
let matches = new Map(); // roomId -> Match (EN match åt gången)
let waitingChampion = null; // { id, name, readyAt, timeout }

// --- SCOREBOARD (24h) ---
const wins = []; // [{ name, ts }]
const DAY_MS = 24 * 60 * 60 * 1000;
function getScoreboard() {
  const now = Date.now();
  // rensa gamla (valfritt – vi filtrerar ändå när vi gör listan)
  while (wins.length && now - wins[0].ts > DAY_MS) wins.shift();

  const tally = new Map();
  for (const w of wins) {
    if (now - w.ts > DAY_MS) continue;
    const key = w.name;
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  // sortera
  return [...tally.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function broadcastQueue() {
  io.to('lobby').emit('queue:update', {
    count: queue.length,
    names: queue.map((p) => p.name),
  });
}

function broadcastScoreboard() {
  io.to('lobby').emit('score:update', getScoreboard());
}

function removeFromQueue(id) {
  const i = queue.findIndex((p) => p.id === id);
  if (i !== -1) queue.splice(i, 1);
}

function nextRoomId() {
  return 'room_' + Math.random().toString(36).slice(2, 10);
}

// --- Chat-begränsningar ---
function isInQueue(id) {
  return queue.some(p => p.id === id);
}
const CHAT_COOLDOWN_MS = 5000;
const lastChatAt = new Map(); // socketId -> timestamp

// ---------------- Server-authoritativ spelmotor ----------------
const TICK_MS = 33;            // ~30 FPS
const PAD_H = 70;
const PAD_W = 10;
const FIELD_W = 640;
const FIELD_H = 400;
const BALL_SIZE = 10;
const START_VX = 2.5;
const START_VY_MIN = 1.0;
const START_VY_RAND = 1.0;     // => 1..2
const PAD_SPEED = 10;
const WIN_ROUNDS = 3;          // först till 3 (bäst av 5)
const HIT_ACCEL = 0.2;         // acceleration per paddelträff
const MAX_SPEED = 7.0;         // vx-tak

class Match {
  constructor(roomId, left, right) {
    this.roomId = roomId;
    this.players = [left.id, right.id]; // vänster, höger
    this.names = { [left.id]: left.name, [right.id]: right.name };
    this.rounds = { [left.id]: 0, [right.id]: 0 };

    // inputs
    this.inputY = {
      [left.id]: FIELD_H / 2 - PAD_H / 2,
      [right.id]: FIELD_H / 2 - PAD_H / 2,
    };

    // state
    this.leftY = FIELD_H / 2 - PAD_H / 2;
    this.rightY = FIELD_H / 2 - PAD_H / 2;
    this.ballX = FIELD_W / 2;
    this.ballY = FIELD_H / 2;
    this.ballVX = START_VX * (Math.random() > 0.5 ? 1 : -1);
    this.ballVY =
      (Math.random() * START_VY_RAND + START_VY_MIN) *
      (Math.random() > 0.5 ? 1 : -1);

    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  resetBall(dir = Math.random() > 0.5 ? 1 : -1) {
    this.ballX = FIELD_W / 2;
    this.ballY = FIELD_H / 2;
    this.ballVX = START_VX * dir;
    this.ballVY =
      (Math.random() * START_VY_RAND + START_VY_MIN) *
      (Math.random() > 0.5 ? 1 : -1);
  }

  applyInputs() {
    const step = PAD_SPEED;
    const [L, R] = this.players;
    const lTarget = this.inputY[L], rTarget = this.inputY[R];

    if (lTarget < this.leftY) this.leftY = Math.max(this.leftY - step, lTarget);
    if (lTarget > this.leftY) this.leftY = Math.min(this.leftY + step, lTarget);
    if (rTarget < this.rightY) this.rightY = Math.max(this.rightY - step, rTarget);
    if (rTarget > this.rightY) this.rightY = Math.min(this.rightY + step, rTarget);

    this.leftY = Math.max(0, Math.min(FIELD_H - PAD_H, this.leftY));
    this.rightY = Math.max(0, Math.min(FIELD_H - PAD_H, this.rightY));
  }

  physics() {
    this.ballX += this.ballVX;
    this.ballY += this.ballVY;

    // väggar
    if (this.ballY <= BALL_SIZE / 2 || this.ballY >= FIELD_H - BALL_SIZE / 2) {
      this.ballVY *= -1;
      this.ballY = Math.max(BALL_SIZE / 2, Math.min(FIELD_H - BALL_SIZE / 2, this.ballY));
    }

    // vänster paddel
    if (
      this.ballX - BALL_SIZE / 2 <= 10 + PAD_W &&
      this.ballY >= this.leftY &&
      this.ballY <= this.leftY + PAD_H
    ) {
      this.ballVX = Math.min(Math.abs(this.ballVX) + HIT_ACCEL, MAX_SPEED);
      const offset = (this.ballY - (this.leftY + PAD_H / 2)) * 0.03;
      this.ballVY += offset;
      this.ballX = 10 + PAD_W + BALL_SIZE / 2;
    }

    // höger paddel
    if (
      this.ballX + BALL_SIZE / 2 >= FIELD_W - 10 - PAD_W &&
      this.ballY >= this.rightY &&
      this.ballY <= this.rightY + PAD_H
    ) {
      const sped = Math.min(Math.abs(this.ballVX) + HIT_ACCEL, MAX_SPEED);
      this.ballVX = -sped;
      const offset = (this.ballY - (this.rightY + PAD_H / 2)) * 0.03;
      this.ballVY += offset;
      this.ballX = FIELD_W - 10 - PAD_W - BALL_SIZE / 2;
    }

    // mål
    if (this.ballX < 0) {
      // höger gör poäng
      this.roundWin(this.players[1]);
    } else if (this.ballX > FIELD_W) {
      // vänster gör poäng
      this.roundWin(this.players[0]);
    }
  }

  roundWin(winnerId) {
    this.rounds[winnerId] = (this.rounds[winnerId] || 0) + 1;

    io.to(this.roomId).emit('series:update', {
      bestOf: WIN_ROUNDS * 2 - 1,   // 5
      rounds: this.rounds,
      names: this.names,
    });

    const [L, R] = this.players;
    const done = this.rounds[L] >= WIN_ROUNDS || this.rounds[R] >= WIN_ROUNDS;

    if (done) {
      const winner = this.rounds[L] >= WIN_ROUNDS ? L : R;
      const loser = winner === L ? R : L;

      // Logga vinst (24h scoreboard)
      wins.push({ name: this.names[winner] || 'Spelare', ts: Date.now() });
      broadcastScoreboard();

      // Systemmeddelande till lobbyn – endast när MATCHEN är klar
      const name = this.names[winner] || 'Spelare';
      io.to('lobby').emit('chat:system', `${name} VANN MATCHEN!! STORT GRATTIS!`);

      // Meddela matchslut
      io.to(this.roomId).emit('match:end', {
        winnerId: winner,
        loserId: loser,
        winnerName: this.names[winner],
        loserName: this.names[loser],
      });

      this.stop();

      // Säkerställ att båda ej ligger kvar i kön
      removeFromQueue(winner);
      removeFromQueue(loser);

      // Flytta båda till lobbyn (inte kön) + säg åt klient att de inte är i kö
      const wSock = io.sockets.sockets.get(winner);
      const lSock = io.sockets.sockets.get(loser);
      if (wSock) { wSock.leave(this.roomId); wSock.join('lobby'); wSock.emit('queue:left'); }
      if (lSock) { lSock.leave(this.roomId); lSock.join('lobby'); lSock.emit('queue:left'); }

      matches.delete(this.roomId);
      broadcastQueue();

      // Håll vinnare i 30 sekunder – sedan tillåts ny match
      setChampionHold30s(winner, this.names[winner]);
      // tryStartMatch triggas av timern efter 30s.
    } else {
      // fortsätt serien
      this.resetBall(winnerId === this.players[0] ? 1 : -1);
      io.to(this.roomId).emit('round:next');
    }
  }

  snapshot() {
    return {
      w: FIELD_W,
      h: FIELD_H,
      leftY: this.leftY,
      rightY: this.rightY,
      ballX: this.ballX,
      ballY: this.ballY,
      padH: PAD_H,
      padW: PAD_W,
      ballSize: BALL_SIZE,
      rounds: this.rounds,
      names: this.names,
    };
  }

  tick() {
    this.applyInputs();
    this.physics();
    io.to(this.roomId).emit('state:update', this.snapshot());
  }
}

function clearWinnerHold() {
  if (waitingChampion?.timeout) clearTimeout(waitingChampion.timeout);
  waitingChampion = null;
}

function setChampionHold30s(id, name) {
  clearWinnerHold();
  waitingChampion = { id, name, readyAt: Date.now() + 30000, timeout: null };
  waitingChampion.timeout = setTimeout(() => {
    const s = io.sockets.sockets.get(waitingChampion.id);
    if (s) s.emit('winner:timeout');
    waitingChampion.readyAt = Date.now();
    tryStartMatch();
  }, 30000);
}

// Endast EN match åt gången. Champion får paras först när readyAt passerats.
function canStartMatch() {
  if (matches.size > 0) return false;
  if (waitingChampion) {
    if (Date.now() < (waitingChampion.readyAt || 0)) return false;
    return queue.length >= 1;
  }
  return queue.length >= 2;
}

function tryStartMatch() {
  if (!canStartMatch()) { broadcastQueue(); return; }

  let left, right;
  if (waitingChampion) {
    left = waitingChampion;
    right = queue.shift();
    clearWinnerHold();
  } else {
    left = queue.shift();
    right = queue.shift();
  }

  const sL = io.sockets.sockets.get(left.id);
  const sR = io.sockets.sockets.get(right.id);
  if (!sL || !sR) {
    if (sL) queue.unshift(left);
    if (sR) queue.unshift(right);
    broadcastQueue();
    return;
  }

  const roomId = nextRoomId();
  sL.leave('lobby'); sR.leave('lobby');
  sL.join(roomId);   sR.join(roomId);

  const m = new Match(roomId, left, right);
  matches.set(roomId, m);
  m.start();

  sL.emit('match:start', {
    roomId,
    opponent: right.name,
    youAreHost: false,
    players: { selfId: left.id, oppId: right.id },
    sides: { leftId: left.id, rightId: right.id },
  });
  sR.emit('match:start', {
    roomId,
    opponent: left.name,
    youAreHost: false,
    players: { selfId: right.id, oppId: left.id },
    sides: { leftId: left.id, rightId: right.id },
  });

  broadcastQueue();
}

// ---------------- Socket-händelser ----------------
io.on('connection', (socket) => {
  socket.join('lobby');

  // Skicka aktuell kö + scoreboard-snapshot direkt
  socket.emit('queue:update', { count: queue.length, names: queue.map(p => p.name) });
  socket.emit('score:update', getScoreboard());

  // chat i lobbyn (kö-krav + cooldown)
  socket.on('chat:message', ({ text }) => {
    const now = Date.now();
    if (!isInQueue(socket.id)) {
      socket.emit('chat:error', 'Du måste vara i kön för att chatta.');
      return;
    }
    const last = lastChatAt.get(socket.id) || 0;
    const diff = now - last;
    if (diff < CHAT_COOLDOWN_MS) {
      const secs = Math.ceil((CHAT_COOLDOWN_MS - diff) / 1000);
      socket.emit('chat:error', `Vänta ${secs}s innan du skickar igen.`);
      return;
    }
    const entry = queue.find(p => p.id === socket.id);
    const name = entry?.name || 'Spelare';
    const cleanText = String(text || '').slice(0, 500).trim();
    if (!cleanText) return;
    lastChatAt.set(socket.id, now);
    io.to('lobby').emit('chat:message', { name, text: cleanText, ts: now });
  });

  socket.on('queue:join', (name) => {
    if (queue.some((p) => p.id === socket.id)) return;
    const clean = (name || 'Spelare').trim().slice(0, 18);
    queue.push({ id: socket.id, name: clean });
    socket.emit('queue:joined');
    broadcastQueue();
    tryStartMatch();
  });

  socket.on('queue:leave', () => {
    removeFromQueue(socket.id);
    socket.emit('queue:left');
    broadcastQueue();
  });

  socket.on('winner:cancel', () => { clearWinnerHold(); broadcastQueue(); });

  socket.on('disconnect', () => {
    const wasInQueue = isInQueue(socket.id);
    removeFromQueue(socket.id);
    if (waitingChampion && waitingChampion.id === socket.id) {
      clearWinnerHold();
    }

    for (const [roomId, m] of matches) {
      if (!m.players.includes(socket.id)) continue;
      const other = m.players.find((id) => id !== socket.id);
      const otherSock = io.sockets.sockets.get(other);
      if (otherSock) {
        otherSock.leave(roomId);
        otherSock.join('lobby');
        otherSock.emit('match:opponent-left');
        otherSock.emit('queue:left');
      }
      m.stop();
      matches.delete(roomId);
    }

    if (wasInQueue) socket.emit?.('queue:left');

    broadcastQueue();
    tryStartMatch();
  });

  socket.on('input:move', ({ roomId, targetY }) => {
    const m = matches.get(roomId);
    if (!m) return;
    if (!m.players.includes(socket.id)) return;
    m.inputY[socket.id] = Math.max(0, Math.min(400 - 70, +targetY || 0)); // FIELD_H - PAD_H
  });
});

// ---------------- Start server ----------------
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Ping Pong server running on port ${port}`);
});
