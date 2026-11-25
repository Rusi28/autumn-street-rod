import { Server } from 'socket.io';

const PORT = process.env.PORT || 3001;
const io = new Server(PORT, { cors: { origin: '*' } });
const rooms = new Map();

io.on('connection', (socket) => {
  socket.on('create_room', ({ mode, track, carModel }) => {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    rooms.set(code, {
      mode,
      track,
      players: [{ id: socket.id, carModel }]
    });
    socket.join(code);
    socket.emit('room_created', { code });
  });

  socket.on('join_room', ({ code, carModel }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit('room_error', 'Nincs ilyen szobakód!');
    if (room.players.length >= 2) return socket.emit('room_error', 'Ez a szoba már tele van!');

    room.players.push({ id: socket.id, carModel });
    socket.join(code);

    // Mindkét játékos megkapja a rajtjelet és a saját sávját (slot: 0 bal, 1 jobb)
    room.players.forEach((p, idx) => {
      const opp = room.players[1 - idx];
      io.to(p.id).emit('match_start', {
        code,
        slot: idx,
        mode: room.mode,
        track: room.track,
        oppCarModel: opp.carModel
      });
    });
  });

  socket.on('state', ({ code, data }) => {
    socket.to(code).emit('opp_state', data);
  });

  socket.on('player_finished', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.finished) return;
    room.finished = true;
    io.to(code).emit('race_over', { winnerId: socket.id });
    rooms.delete(code);
  });

  socket.on('disconnect', () => {
    for (const [code, room] of rooms.entries()) {
      if (room.players.some((p) => p.id === socket.id)) {
        socket.to(code).emit('opp_left');
        rooms.delete(code);
      }
    }
  });
});

console.log('Multiplayer szerver fut a 3001-es porton!');