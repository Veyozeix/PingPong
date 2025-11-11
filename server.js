// server.js
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- Kö- och matchmaking ---
let queue = []; // [{id, name}]
let matches = new Map(); // roomId -> { players:[id1,id2], names:{}, hostId, rounds:{} }

function broadcastQueue() {
  io.emit('queue:update', {
    count: queue.length,
    names: queue.map(p => p.name),
  });
}

function removeFromQueue(socketId) {
  const i = queue.findIndex(p => p.id === socketId);
  if (i !== -1) queue.splice(i, 1);
}

function nextRoomId() {
  return 'room_' + Math.random().toString(36).slice(2, 10);
}

function tryStartMatch() {
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    const roomId = nextRoomId();

    const hostId = a.id; // låt första spelaren simulera bollen
    matches.set(roomId, {
      players: [a.id, b.id],
      names: { [a.id]: a.name, [b.id]: b.name },
      hostId,
      rounds: { [a.id]: 0, [b.id]: 0 },
    });

    const sA = io.sockets.sockets.get(a.id);
    const sB = io.sockets.sockets.get(b.id);
    if (!sA || !sB) continue;

    sA.join(roomId);
    sB.join(roomId);

    sA.emit('match:start', { roomId, opponent: b.name, youAreHost: a.id === hostId });
    sB.emit('match:start', { roomId, opponent: a.name, youAreHost: b.id === hostId });

    io.to(roomId).emit('series:update', {
      bestOf: 3,
      rounds: matches.get(roomId).rounds,
      names: matches.get(roomId).names,
    });
  }
  broadcastQueue();
}

io.on('connection', (socket) => {
  socket.on('queue:join', (name) => {
    if (queue.some(p => p.id === socket.id)) return;
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

    for (const [roomId, m] of matches) {
      if (!m.players.includes(socket.id)) continue;
      const other = m.players.find(id => id !== socket.id);
      const otherSock = io.sockets.sockets.get(other);
      if (otherSock) {
        otherSock.leave(roomId);
        otherSock.emit('match:opponent-left');
        queue.unshift({ id: other, name: m.names[other] || 'Spelare' });
      }
      matches.delete(roomId);
    }
    broadcastQueue();
    tryStartMatch();
  });

  // --- Spel relaterat ---
  socket.on('paddle:move', ({ roomId, y }) => {
    socket.to(roomId).emit('paddle:move', { id: socket.id, y });
  });

  // Klienten låter hosten skicka state till andra spelaren
  socket.on('state:broadcast', ({ roomId, s }) => {
    socket.to(roomId).emit('state:broadcast', { s });
  });

  // Endast host får markera rundavinst
  socket.on('round:win', ({ roomId, winnerId }) => {
    const m = matches.get(roomId);
    if (!m || m.hostId !== socket.id) return;

    m.rounds[winnerId] = (m.rounds[winnerId] || 0) + 1;

    io.to(roomId).emit('series:update', {
      bestOf: 3,
      rounds: m.rounds,
      names: m.names,
    });

    const [p1, p2] = m.players;
    if (m.rounds[p1] >= 2 || m.rounds[p2] >= 2) {
      const winner = m.rounds[p1] >= 2 ? p1 : p2;
      const loser = winner === p1 ? p2 : p1;

      io.to(roomId).emit('match:end', { winnerId: winner, loserId: loser });

      const loserSock = io.sockets.sockets.get(loser);
      const winnerSock = io.sockets.sockets.get(winner);

      if (loserSock) {
        loserSock.leave(roomId);
        queue.push({ id: loser, name: m.names[loser] });
      }
      if (winnerSock) {
        winnerSock.leave(roomId);
        queue.unshift({ id: winner, name: m.names[winner] });
      }

      matches.delete(roomId);
      broadcastQueue();
      tryStartMatch();
    } else {
      io.to(roomId).emit('round:next');
    }
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Ping Pong server running on port ${port}`);
});
