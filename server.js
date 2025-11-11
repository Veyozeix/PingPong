// server.js
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // lite snällare ping för gratisvärd
  pingInterval: 25000,
  pingTimeout: 20000,
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------------- Kö & matcher ----------------
let queue = []; // [{id, name}]
let matches = new Map(); // roomId -> Match

function broadcastQueue() {
  io.emit('queue:update', {
    count: queue.length,
    names: queue.map((p) => p.name),
  });
}

function removeFromQueue(id) {
  const i = queue.findIndex((p) => p.id === id);
  if (i !== -1) queue.splice(i, 1);
}

function nextRoomId() {
  return 'room_' + Math.random().toString(36).slice(2, 10);
}

// ---------------- Server-authoritativ spelmotor ----------------
const TICK_MS = 33;            // ~30 FPS (byt till 16 för ~60 FPS vid behov)
const PAD_H = 70;
const PAD_W = 10;
const FIELD_W = 640;
const FIELD_H = 400;
const BALL_SIZE = 10;
const START_VX = 0.5;          // långsammare startfart
const START_VY_MIN = 1.0;
const START_VY_RAND = 1.0;     // => 1.0 .. 2.0
const PAD_SPEED = 10;          // hur snabbt servern flyttar paddlar mot targetY
const WIN_ROUNDS = 2;          // bäst av 3
const HIT_ACCEL = 0.2;         // <-- NYTT: acceleration per paddelträff
const MAX_SPEED = 7.0;         // <-- NYTT: övre hastighets-tak (|vx|)

class Match {
  constructor(roomId, a, b) {
    this.roomId = roomId;
    this.players = [a.id, b.id]; // vänster = a, höger = b
    this.names = { [a.id]: a.name, [b.id]: b.name };
    this.rounds = { [a.id]: 0, [b.id]: 0 };

    // inputs (servern tar emot "targetY" och styr paddlar mot det)
    this.inputY = {
      [a.id]: FIELD_H / 2 - PAD_H / 2,
      [b.id]: FIELD_H / 2 - PAD_H / 2,
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
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.running = true;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
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
    // flytta paddlar en bit mot targetY (enkelt smoothing)
    const step = PAD_SPEED;
    const lTarget = this.inputY[this.players[0]];
    const rTarget = this.inputY[this.players[1]];

    if (lTarget < this.leftY) this.leftY = Math.max(this.leftY - step, lTarget);
    if (lTarget > this.leftY) this.leftY = Math.min(this.leftY + step, lTarget);
    if (rTarget < this.rightY) this.rightY = Math.max(this.rightY - step, rTarget);
    if (rTarget > this.rightY) this.rightY = Math.min(this.rightY + step, rTarget);

    // clamp
    this.leftY = Math.max(0, Math.min(FIELD_H - PAD_H, this.leftY));
    this.rightY = Math.max(0, Math.min(FIELD_H - PAD_H, this.rightY));
  }

  physics() {
    // boll
    this.ballX += this.ballVX;
    this.ballY += this.ballVY;

    // väggar
    if (this.ballY <= BALL_SIZE / 2 || this.ballY >= FIELD_H - BALL_SIZE / 2) {
      this.ballVY *= -1;
      // clampa tillbaka innanför
      this.ballY = Math.max(BALL_SIZE / 2, Math.min(FIELD_H - BALL_SIZE / 2, this.ballY));
    }

    // paddlar (enkla rektangelkollisioner) + acceleration & tak
    // vänster
    if (
      this.ballX - BALL_SIZE / 2 <= 10 + PAD_W &&
      this.ballY >= this.leftY &&
      this.ballY <= this.leftY + PAD_H
    ) {
      // öka farten lite och behåll riktning åt höger
      this.ballVX = Math.min(Math.abs(this.ballVX) + HIT_ACCEL, MAX_SPEED);
      const offset = (this.ballY - (this.leftY + PAD_H / 2)) * 0.03;
      this.ballVY += offset;
      // nudge ut bollen för att undvika fastna
      this.ballX = 10 + PAD_W + BALL_SIZE / 2;
    }
    // höger
    if (
      this.ballX + BALL_SIZE / 2 >= FIELD_W - 10 - PAD_W &&
      this.ballY >= this.rightY &&
      this.ballY <= this.rightY + PAD_H
    ) {
      // öka farten lite och behåll riktning åt vänster
      const sped = Math.min(Math.abs(this.ballVX) + HIT_ACCEL, MAX_SPEED);
      this.ballVX = -sped;
      const offset = (this.ballY - (this.rightY + PAD_H / 2)) * 0.03;
      this.ballVY += offset;
      this.ballX = FIELD_W - 10 - PAD_W - BALL_SIZE / 2;
    }

    // mål
    if (this.ballX < 0) {
      // höger spelare gör poäng
      this.roundWin(this.players[1]);
    } else if (this.ballX > FIELD_W) {
      // vänster spelare gör poäng
      this.roundWin(this.players[0]);
    }
  }

  roundWin(winnerId) {
    this.rounds[winnerId] = (this.rounds[winnerId] || 0) + 1;

    io.to(this.roomId).emit('series:update', {
      bestOf: WIN_ROUNDS * 2 - 1,
      rounds: this.rounds,
      names: this.names,
    });

    const [L, R] = this.players;
    const done = this.rounds[L] >= WIN_ROUNDS || this.rounds[R] >= WIN_ROUNDS;

    if (done) {
      const winner = this.rounds[L] >= WIN_ROUNDS ? L : R;
      const loser = winner === L ? R : L;
      io.to(this.roomId).emit('match:end', { winnerId: winner, loserId: loser });
      this.stop();
      // flytta i kön
      const loserSock  = io.sockets.sockets.get(loser);
      const winnerSock = io.sockets.sockets.get(winner);
      if (loserSock) {
        loserSock.leave(this.roomId);
        queue.push({ id: loser, name: this.names[loser] });
      }
      if (winnerSock) {
        winnerSock.leave(this.roomId);
        queue.unshift({ id: winner, name: this.names[winner] });
      }
      matches.delete(this.roomId);
      broadcastQueue();
      tryStartMatch();
    } else {
      // fortsätt serien: reset boll och kör vidare
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
    // skicka state till båda
    io.to(this.roomId).emit('state:update', this.snapshot());
  }
}

function tryStartMatch() {
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    const roomId = nextRoomId();

    const sA = io.sockets.sockets.get(a.id);
    const sB = io.sockets.sockets.get(b.id);
    if (!sA || !sB) {
      if (sA) queue.unshift(a);
      if (sB) queue.unshift(b);
      continue;
    }
    sA.join(roomId);
    sB.join(roomId);

    // skapa och starta server-authoritativ match
    const m = new Match(roomId, a, b);
    matches.set(roomId, m);
    m.start();

    // meddela start + id/sidor (vänster = a, höger = b)
    sA.emit('match:start', {
      roomId,
      opponent: b.name,
      youAreHost: false, // ej relevant längre
      players: { selfId: a.id, oppId: b.id },
      sides: { leftId: a.id, rightId: b.id },
    });
    sB.emit('match:start', {
      roomId,
      opponent: a.name,
      youAreHost: false,
      players: { selfId: b.id, oppId: a.id },
      sides: { leftId: a.id, rightId: b.id },
    });

    io.to(roomId).emit('series:update', {
      bestOf: WIN_ROUNDS * 2 - 1,
      rounds: m.rounds,
      names: m.names,
    });
  }
  broadcastQueue();
}

// ---------------- Socket-händelser ----------------
io.on('connection', (socket) => {
  socket.on('queue:join', (name) => {
    if (queue.some((p) => p.id === socket.id)) return;
    queue.push({ id: socket.id, name: (name || 'Spelare').trim().slice(0, 18) });
    broadcastQueue();
    tryStartMatch();
  });

  socket.on('queue:leave', () => {
    removeFromQueue(socket.id);
    broadcastQueue();
  });

  socket.on('disconnect', () => {
    removeFromQueue(socket.id);

    // om socket var i en match – avsluta matchen och lyft motståndaren till kö-toppen
    for (const [roomId, m] of matches) {
      if (!m.players.includes(socket.id)) continue;
      const other = m.players.find((id) => id !== socket.id);
      const otherSock = io.sockets.sockets.get(other);
      if (otherSock) {
        otherSock.leave(roomId);
        otherSock.emit('match:opponent-left');
        queue.unshift({ id: other, name: m.names[other] || 'Spelare' });
      }
      m.stop();
      matches.delete(roomId);
    }
    broadcastQueue();
    tryStartMatch();
  });

  // klienten skickar sitt mål-Y (cursor/keys) så servern flyttar paddeln mot det
  socket.on('input:move', ({ roomId, targetY }) => {
    const m = matches.get(roomId);
    if (!m) return;
    if (!m.players.includes(socket.id)) return;
    m.inputY[socket.id] = Math.max(0, Math.min(FIELD_H - PAD_H, targetY));
  });
});

// ---------------- Start server ----------------
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Ping Pong server running on port ${port}`);
});
