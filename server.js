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

    const hostId = a.id;            // Host = första spelaren (vänster)
    const otherId = b.id;           // Andra spelaren (höger)
    const names = { [a.id]: a.name, [b.id]: b.name };

    matches.set(roomId, {
      players: [a.id, b.id],
      names,
      hostId,
      rounds: { [a.id]: 0, [b.id]: 0 }, // bäst av 3 => först till 2
    });

    const sA = io.sockets.sockets.get(a.id);
    const sB = io.sockets.sockets.get(b.id);
    if (!sA || !sB) {
      // Om någon hann försvinna, rulla tillbaka den som finns kvar till kö
      if (sA) queue.unshift({ id: a.id, name: a.name });
      if (sB) queue.unshift({ id: b.id, name: b.name });
      matches.delete(roomId);
      continue;
    }

    sA.join(roomId);
    sB.join(roomId);

    // Skicka startinfo till båda (inkl. bådas id och sidmappning)
    const startPayloadA = {
      roomId,
      opponent: b.name,
      youAreHost: true,
      players: { selfId: a.id, oppId: b.id },
      sides: { leftId: hostId, rightId: otherId },
    };
    const startPayloadB = {
      roomId,
      opponent: a.name,
      youAreHost: false,
      players: { selfId: b.id, oppId: a.id },
      sides: { leftId: hostId, rightId: otherId },
    };

    sA.emit('match:start', startPayloadA);
    sB.emit('match:start', startPayloadB);

    io.to(roomId).emit('series:update', {
      bestOf: 3,
      rounds: matches.get(roomId).rounds,
      names: matches.get(roomId).names,
    });
  }
  broadcastQueue();
}

io.on('connection', (socket) => {
  // Gå med i kö
  socket.on('queue:join', (name) => {
    if (queue.some(p => p.id === socket.id)) return;
    queue.push({ id: socket.id, name: (name || 'Spelare').trim().slice(0, 18) });
    broadcastQueue();
    tryStartMatch();
  });

  // Lämna kö
  socket.on('queue:leave', () => {
    removeFromQueue(socket.id);
    broadcastQueue();
  });

  // Kopplar från
  socket.on('disconnect', () => {
    // 1) Om i kö – ta bort
    removeFromQueue(socket.id);

    // 2) Om i match – avsluta och skicka motståndaren till könsfronten
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

  // --- Spelrelaterade relays ---
  socket.on('paddle:move', ({ roomId, y }) => {
    // skicka paddelrörelsen till motståndaren
    socket.to(roomId).emit('paddle:move', { id: socket.id, y });
  });

  // hosten broadcastar spelstate (boll + paddlar)
  socket.on('state:broadcast', ({ roomId, s }) => {
    socket.to(roomId).emit('state:broadcast', { s });
  });

  // Endast host får deklarera runda-vinst
  socket.on('round:win', ({ roomId, winnerId }) => {
    const m = matches.get(roomId);
    if (!m) return;
    if (m.hostId !== socket.id) return; // bara host får avgöra

    m.rounds[winnerId] = (m.rounds[winnerId] || 0) + 1;

    io.to(roomId).emit('series:update', {
      bestOf: 3,
      rounds: m.rounds,
      names: m.names,
    });

    const [p1, p2] = m.players;
    if (m.rounds[p1] >= 2 || m.rounds[p2] >= 2) {
      // Match avgjord
      const winner = m.rounds[p1] >= 2 ? p1 : p2;
      const loser  = winner === p1 ? p2 : p1;

      io.to(roomId).emit('match:end', { winnerId: winner, loserId: loser });

      const loserSock  = io.sockets.sockets.get(loser);
      const winnerSock = io.sockets.sockets.get(winner);

      if (loserSock) {
        loserSock.leave(roomId);
        queue.push({ id: loser, name: m.names[loser] });
      }
      if (winnerSock) {
        winnerSock.leave(roomId);
        // vinnaren ska möta nästa – lägg överst
        queue.unshift({ id: winner, name: m.names[winner] });
      }

      matches.delete(roomId);
      broadcastQueue();
      tryStartMatch();
    } else {
      // Ny boll i samma match
      io.to(roomId).emit('round:next');
    }
  });
});

// Render/production: använd tilldelad PORT
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Ping Pong server running on port ${port}`);
});
