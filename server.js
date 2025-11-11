// server.js
bestOf: 3,
rounds: matches.get(roomId).rounds,
names: matches.get(roomId).names
});
}
broadcastQueue();
}


io.on('connection', (socket) => {
socket.on('queue:join', (name) => {
// Om redan i kö – ignorera
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
// 1) Om i kö – ta bort
removeFromQueue(socket.id);


// 2) Om i match – avsluta och skicka motståndaren till toppen av kön
for (const [roomId, m] of matches) {
if (!m.players.includes(socket.id)) continue;
const other = m.players.find(id => id !== socket.id);
const name = m.names[other] || 'Spelare';
const otherSock = io.sockets.sockets.get(other);
if (otherSock) {
otherSock.leave(roomId);
otherSock.emit('match:opponent-left');
// Lägg tillbaka den kvarvarande spelaren i könsfronten
queue.unshift({ id: other, name });
}
matches.delete(roomId);
}
broadcastQueue();
tryStartMatch();
});


// --- Spelrelaterade events ---
socket.on('paddle:move', ({ roomId, y }) => {
socket.to(roomId).emit('paddle:move', { id: socket.id, y });
});


// Endast host deklarerar runda (då en boll passerat mål)
socket.on('round:win', ({ roomId, winnerId }) => {
const m = matches.get(roomId);
if (!m || m.hostId !== socket.id) return; // säkerställ att bara host får avgöra


if (!m.rounds[winnerId]) m.rounds[winnerId] = 0;
m.rounds[winnerId] += 1;


io.to(roomId).emit('series:update', {
bestOf: 3,
rounds: m.rounds,
names: m.names
});


// Kolla om matchen är avgjord (först till 2 rundor)
const [p1, p2] = m.players;
if (m.rounds[p1] >= 2 || m.rounds[p2] >= 2) {
const winner = m.rounds[p1] >= 2 ? p1 : p2;
const loser = winner === p1 ? p2 : p1;
io.to(roomId).emit('match:end', { winnerId: winner, loserId: loser });


// Flytta spelare enligt regler
const loserSock = io.sockets.sockets.get(loser);
const winnerSock = io.sockets.sockets.get(winner);
const loserName = m.names[loser];
const winnerName = m.names[winner];


if (loserSock) {
loserSock.leave(roomId);
queue.push({ id: loser, name: loserName });
}
if (winnerSock) {
winnerSock.leave(roomId);
// Vinnaren ska möta nästa i kön om det finns någon; annars stannar hen överst
queue.unshift({ id: winner, name: winnerName });
}


matches.delete(roomId);
broadcastQueue();
tryStartMatch();
return;
}


// Annars – starta ny boll i samma match
io.to(roomId).emit('round:next');
});
});


server.listen(3000, () => {
console.log('Ping Pong server running on http://localhost:3000');
});
