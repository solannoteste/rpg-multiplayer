const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Faz o servidor entregar os arquivos da pasta 'client'
app.use(express.static(path.join(__dirname, '../client')));

// Quando alguém acessa o site
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

// Quando um jogador se conecta
io.on('connection', (socket) => {
  console.log('✅ Um jogador conectou! ID:', socket.id);

  // Quando o jogador desconectar
  socket.on('disconnect', () => {
    console.log('❌ Um jogador saiu.');
  });
});

// Inicia o servidor na porta 3000
server.listen(3000, () => {
  console.log('🚀 Servidor rodando!');
  console.log('📍 Abra http://localhost:3000 no seu navegador');
  console.log('🎮 Divirta-se!');
});