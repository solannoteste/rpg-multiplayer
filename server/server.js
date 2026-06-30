const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// ⬇️ MUDANÇA AQUI: apontar para ../client ao invés de public
app.use(express.static(path.join(__dirname, '../client')));

const players = {};

io.on('connection', (socket) => {
  console.log('Jogador conectou:', socket.id);
  
  players[socket.id] = {
    id: socket.id,
    name: 'Jogador',
    x: 12.5,
    y: 12.5,
    hp: 100,
    maxHp: 100,
    level: 1,
    kills: 0,
    attackAngle: 0,
    attacking: false,
    downed: false,
    downedTime: 0,
    reviveProgress: 0,
    beingRevivedBy: null
  };
  
  socket.emit('init', { 
    playerId: socket.id,
    players: players 
  });
  
  socket.broadcast.emit('playerJoined', players[socket.id]);
  
  socket.on('playerUpdate', (data) => {
    if (players[socket.id]) {
      players[socket.id] = { ...players[socket.id], ...data };
      socket.broadcast.emit('playerUpdated', players[socket.id]);
    }
  });
  
  socket.on('setName', (name) => {
    if (players[socket.id]) {
      players[socket.id].name = name;
      socket.broadcast.emit('playerUpdated', players[socket.id]);
    }
  });
  
  socket.on('playerDowned', (data) => {
    if (players[socket.id]) {
      players[socket.id].downed = true;
      players[socket.id].downedTime = Date.now();
      players[socket.id].x = data.x;
      players[socket.id].y = data.y;
      io.emit('playerUpdated', players[socket.id]);
    }
  });
  
  socket.on('playerRevived', () => {
    if (players[socket.id]) {
      players[socket.id].downed = false;
      players[socket.id].hp = 50;
      players[socket.id].reviveProgress = 0;
      players[socket.id].beingRevivedBy = null;
      io.emit('playerUpdated', players[socket.id]);
    }
  });
  
  socket.on('reviveProgress', (data) => {
    if (players[socket.id]) {
      const targetPlayer = players[data.targetId];
      if (targetPlayer && targetPlayer.downed) {
        targetPlayer.reviveProgress = data.progress;
        targetPlayer.beingRevivedBy = socket.id;
        io.emit('playerUpdated', targetPlayer);
      }
    }
  });
  
  socket.on('disconnect', () => {
    console.log('Jogador desconectou:', socket.id);
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
