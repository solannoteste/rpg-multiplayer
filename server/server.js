const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, '../client')));

const players = {};

const TILE = 32;
const MAP_W = 25;
const MAP_H = 25;

let enemies = [];
let hordeInstances = [];
let goblinKingInstances = [];
let mapObjects = [];
let playerSpawnPos = { x: 12, y: 12 };
let hordeSpawns = [];
let goblinKingSpawns = [];

for (let y = 0; y < MAP_H; y++) {
  mapObjects[y] = [];
  for (let x = 0; x < MAP_W; x++) {
    mapObjects[y][x] = null;
  }
}

function createEnemy(type, x, y, hp, atk, xpReward, fromHorde = false, spawnId = null) {
  return {
    id: Date.now() + Math.random(),
    type, x, y,
    spawnX: x, spawnY: y,
    hp, maxHp: hp, atk, xpReward,
    lastAttack: 0,
    bouncePhase: 0, isMoving: false,
    facingRight: Math.random() < 0.5,
    state: 'idle', idleTimer: 0,
    fromHorde, spawnId,
    stunTimer: 0,
    isKing: false,
    isArcanjo: false,
    lastBeam: 0
  };
}

function createSkeletonOrShield(x, y, fromHorde = false, spawnId = null) {
  if (Math.random() < 0.20) {
    return createEnemy('skeleton_shield', x, y, 200, 20, 50, fromHorde, spawnId);
  } else {
    return createEnemy('skeleton', x, y, 80, 20, 25, fromHorde, spawnId);
  }
}

function createDemonOrArcanjo(x, y, fromHorde = false, spawnId = null) {
  if (Math.random() < 0.01) {
    const e = createEnemy('arcanjo', x, y, 500, 80, 150, fromHorde, spawnId);
    e.isArcanjo = true;
    return e;
  } else {
    return createEnemy('demon', x, y, 200, 50, 60, fromHorde, spawnId);
  }
}

function createGoblinKing(x, y, spawnId) {
  return {
    id: Date.now() + Math.random(),
    type: 'goblin_king',
    x, y,
    spawnX: x, spawnY: y,
    hp: 1000, maxHp: 1000,
    atk: 80,
    xpReward: 500,
    lastAttack: 0,
    bouncePhase: 0,
    isMoving: false,
    facingRight: true,
    state: 'idle',
    stateTimer: 0,
    jumpTarget: null,
    jumpStart: null,
    jumpProgress: 0,
    carriedGoblin: null,
    throwTarget: null,
    stunTimer: 0,
    spawnId: spawnId,
    isKing: true,
    abilityCooldown: 0,
    lastAbilityUsed: null
  };
}

function loadInitialEnemies() {
  enemies = [];
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const cell = mapObjects[y][x];
      if (cell === 'skeleton') {
        enemies.push(createSkeletonOrShield(x + 0.5, y + 0.5));
      } else if (cell === 'goblin') {
        enemies.push(createEnemy('goblin', x + 0.5, y + 0.5, 90, 15, 20));
      } else if (cell === 'escuridao') {
        enemies.push(createEnemy('escuridao', x + 0.5, y + 0.5, 200, 60, 40));
      } else if (cell === 'golem') {
        enemies.push(createEnemy('golem', x + 0.5, y + 0.5, 250, 40, 35));
      } else if (cell === 'demon') {
        enemies.push(createDemonOrArcanjo(x + 0.5, y + 0.5));
      }
    }
  }
  console.log(`Carregados ${enemies.length} inimigos iniciais`);
}

function isBlocked(x, y) {
  const offsets = [[-0.4,-0.4],[0.4,-0.4],[-0.4,0.4],[0.4,0.4]];
  for (const [ox, oy] of offsets) {
    const bx = Math.floor(x + ox); const by = Math.floor(y + oy);
    if (bx < 0 || bx >= MAP_W || by < 0 || by >= MAP_H) return true;
    if (mapObjects[by][bx] === 'tree') return true;
  }
  return false;
}

function isEnemyBlocked(x, y, self) {
  for (const e of enemies) {
    if (e === self) continue;
    if (e.isKing) continue;
    if (Math.hypot(e.x - x, e.y - y) < 0.8) return true;
  }
  return false;
}

function findFreeSpawnPosition(centerX, centerY, radius, excludePositions = []) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * radius;
    let ex = centerX + Math.cos(angle) * dist;
    let ey = centerY + Math.sin(angle) * dist;
    ex = Math.max(0.5, Math.min(MAP_W - 0.5, ex));
    ey = Math.max(0.5, Math.min(MAP_H - 0.5, ey));
    
    if (isBlocked(ex, ey)) continue;
    
    let tooClose = false;
    for (const e of enemies) {
      if (Math.hypot(e.x - ex, e.y - ey) < 1.2) {
        tooClose = true; break;
      }
    }
    if (tooClose) continue;
    
    for (const pos of excludePositions) {
      if (Math.hypot(pos.x - ex, pos.y - ey) < 1.2) {
        tooClose = true; break;
      }
    }
    if (tooClose) continue;
    
    return { x: ex, y: ey };
  }
  
  return { x: centerX, y: centerY };
}

function updateEnemies(dt) {
  const now = Date.now();
  
  enemies.forEach(e => {
    if (e.isKing) {
      updateGoblinKing(e, dt, now);
      return;
    }
    
    if (e.stunTimer > 0) {
      e.stunTimer -= dt;
      e.isMoving = false;
      return;
    }

    let closestPlayer = null;
    let closestDist = Infinity;
    
    Object.values(players).forEach(p => {
      if (p.downed) return;
      const dist = Math.hypot(p.x - e.x, p.y - e.y);
      if (dist < closestDist) {
        closestDist = dist;
        closestPlayer = p;
      }
    });

    if (!closestPlayer) return;

    e.isMoving = false;

    if (e.state === 'chasing') {
      if (closestDist > 12) {
        e.state = 'returning';
      } else {
        const angle = Math.atan2(closestPlayer.y - e.y, closestPlayer.x - e.x);
        let espeed = 1.5 * dt;
        if (e.type === 'escuridao') espeed = 2.2 * dt;
        
        const ex = e.x + Math.cos(angle) * espeed;
        const ey = e.y + Math.sin(angle) * espeed;
        let moved = false;
        if (!isBlocked(ex, e.y) && !isEnemyBlocked(ex, e.y, e)) { e.x = ex; moved = true; }
        if (!isBlocked(e.x, ey) && !isEnemyBlocked(e.x, ey, e)) { e.y = ey; moved = true; }
        if (!moved) {
          const perpAngle = angle + Math.PI / 2;
          const sideX = e.x + Math.cos(perpAngle) * espeed * 2;
          const sideY = e.y + Math.sin(perpAngle) * espeed * 2;
          if (!isBlocked(sideX, e.y) && !isEnemyBlocked(sideX, e.y, e)) e.x = sideX;
          else if (!isBlocked(e.x, sideY) && !isEnemyBlocked(e.x, sideY, e)) e.y = sideY;
        }
        e.isMoving = true;
        if (Math.cos(angle) < -0.1) e.facingRight = false;
        else if (Math.cos(angle) > 0.1) e.facingRight = true;
      }
    } else if (e.state === 'returning') {
      const distToSpawn = Math.hypot(e.spawnX - e.x, e.spawnY - e.y);
      if (distToSpawn < 1.5) {
        e.state = 'idle';
        e.idleTimer = 2 + Math.random() * 3;
      } else {
        const angle = Math.atan2(e.spawnY - e.y, e.spawnX - e.x);
        let espeed = 2.0 * dt;
        if (e.type === 'escuridao') espeed = 2.5 * dt;
        
        const ex = e.x + Math.cos(angle) * espeed;
        const ey = e.y + Math.sin(angle) * espeed;
        if (!isBlocked(ex, e.y) && !isEnemyBlocked(ex, e.y, e)) e.x = ex;
        if (!isBlocked(e.x, ey) && !isEnemyBlocked(e.x, ey, e)) e.y = ey;
        e.isMoving = true;
        if (Math.cos(angle) < -0.1) e.facingRight = false;
        else if (Math.cos(angle) > 0.1) e.facingRight = true;
      }
    } else if (e.state === 'idle') {
      e.idleTimer -= dt;
      if (e.idleTimer <= 0) {
        const action = Math.random();
        if (action < 0.4) {
          const angle = Math.random() * Math.PI * 2;
          for (let i = 0; i < 2; i++) {
            const ex = e.x + Math.cos(angle) * 0.3;
            const ey = e.y + Math.sin(angle) * 0.3;
            if (!isBlocked(ex, ey) && !isEnemyBlocked(ex, ey, e)) { e.x = ex; e.y = ey; }
          }
          e.isMoving = true;
          if (Math.cos(angle) < -0.1) e.facingRight = false;
          else if (Math.cos(angle) > 0.1) e.facingRight = true;
          e.idleTimer = 3 + Math.random() * 4;
        } else {
          e.idleTimer = 2 + Math.random() * 3;
        }
      }
    }

    if (closestDist < 8 && e.state !== 'chasing') e.state = 'chasing';

    if (e.isMoving) e.bouncePhase += dt * 8;
    else { e.bouncePhase *= 0.9; if (Math.abs(e.bouncePhase) < 0.01) e.bouncePhase = 0; }

    if (closestDist < 1.2 && now - e.lastAttack > 1000 && e.stunTimer <= 0) {
      const isCrit = Math.random() < 0.05;
      let dmg = isCrit ? e.atk * 2 : e.atk;

      if (closestPlayer.hp > 0 && !closestPlayer.downed) {
        dmg = dmg * (1 - (closestPlayer.resistance || 0));
        closestPlayer.hp -= dmg;
        closestPlayer.lastHit = now;
        
        io.emit('playerDamaged', {
          playerId: closestPlayer.id,
          damage: dmg,
          isCrit: isCrit,
          attackerX: e.x,
          attackerY: e.y
        });

        if (closestPlayer.hp <= 0 && !closestPlayer.downed) {
          closestPlayer.hp = 0;
          closestPlayer.downed = true;
          closestPlayer.downedTime = Date.now();
          io.emit('playerDowned', {
            playerId: closestPlayer.id,
            x: closestPlayer.x,
            y: closestPlayer.y
          });
        }
      }

      e.lastAttack = now;
    }
  });
}

function updateGoblinKing(king, dt, now) {
  if (king.stunTimer > 0) {
    king.stunTimer -= dt;
    king.isMoving = false;
    if (king.state === 'jumpCharge' || king.state === 'jumping') {
      king.state = 'chasing';
      king.jumpTarget = null;
    }
    return;
  }

  let closestPlayer = null;
  let closestDist = Infinity;
  
  Object.values(players).forEach(p => {
    if (p.downed) return;
    const dist = Math.hypot(p.x - king.x, p.y - king.y);
    if (dist < closestDist) {
      closestDist = dist;
      closestPlayer = p;
    }
  });

  if (!closestPlayer) return;

  if (king.stateTimer > 0) king.stateTimer -= dt;
  if (king.abilityCooldown > 0) king.abilityCooldown -= dt;

  if (king.state === 'jumpCharge') {
    king.isMoving = false;
    if (king.stateTimer <= 0) {
      king.state = 'jumping';
      king.jumpStart = { x: king.x, y: king.y };
      king.jumpProgress = 0;
      king.stateTimer = 0.6;
    }
  } else if (king.state === 'jumping') {
    king.jumpProgress += dt / 0.6;
    if (king.jumpProgress >= 1) {
      king.x = king.jumpTarget.x;
      king.y = king.jumpTarget.y;
      king.state = 'chasing';
      king.jumpTarget = null;
      king.abilityCooldown = 4;
      
      io.emit('kingJumped', { x: king.x, y: king.y });
      
      const distToImpact = Math.hypot(closestPlayer.x - king.x, closestPlayer.y - king.y);
      if (distToImpact < 1.8) {
        let dmg = 150 * (1 - (closestPlayer.resistance || 0));
        closestPlayer.hp -= dmg;
        closestPlayer.lastHit = Date.now();
        
        io.emit('playerDamaged', {
          playerId: closestPlayer.id,
          damage: dmg,
          isCrit: false,
          attackerX: king.x,
          attackerY: king.y
        });
        
        if (closestPlayer.hp <= 0 && !closestPlayer.downed) {
          closestPlayer.hp = 0;
          closestPlayer.downed = true;
          closestPlayer.downedTime = Date.now();
          io.emit('playerDowned', {
            playerId: closestPlayer.id,
            x: closestPlayer.x,
            y: closestPlayer.y
          });
        }
      }
    } else {
      const t = king.jumpProgress;
      king.x = king.jumpStart.x + (king.jumpTarget.x - king.jumpStart.x) * t;
      king.y = king.jumpStart.y + (king.jumpTarget.y - king.jumpStart.y) * t;
    }
  } else {
    king.isMoving = false;
    
    if (closestDist > 15) {
      king.state = 'idle';
    } else {
      king.state = 'chasing';
      
      const angle = Math.atan2(closestPlayer.y - king.y, closestPlayer.x - king.x);
      const espeed = 1.8 * dt;
      const ex = king.x + Math.cos(angle) * espeed;
      const ey = king.y + Math.sin(angle) * espeed;
      let moved = false;
      if (!isBlocked(ex, king.y)) { king.x = ex; moved = true; }
      if (!isBlocked(king.x, ey)) { king.y = ey; moved = true; }
      king.isMoving = true;
      if (Math.cos(angle) < -0.1) king.facingRight = false;
      else if (Math.cos(angle) > 0.1) king.facingRight = true;
      
      if (king.abilityCooldown <= 0 && closestDist < 12 && closestDist > 2.5) {
        const roll = Math.random();
        
        if (roll < 0.5) {
          const nearbyGoblin = findNearbyGoblin(king.x, king.y, 2.5);
          if (nearbyGoblin) {
            king.state = 'throwCharge';
            king.stateTimer = 0.8;
            king.carriedGoblin = nearbyGoblin;
            king.throwTarget = { x: closestPlayer.x, y: closestPlayer.y };
            const idx = enemies.indexOf(nearbyGoblin);
            if (idx >= 0) enemies.splice(idx, 1);
          } else {
            startKingJump(king, closestPlayer);
          }
        } else {
          startKingJump(king, closestPlayer);
        }
      }
      
      if (closestDist < 1.5 && Date.now() - king.lastAttack > 1200) {
        let dmg = king.atk;
        dmg = dmg * (1 - (closestPlayer.resistance || 0));
        closestPlayer.hp -= dmg;
        closestPlayer.lastHit = Date.now();
        
        io.emit('playerDamaged', {
          playerId: closestPlayer.id,
          damage: dmg,
          isCrit: false,
          attackerX: king.x,
          attackerY: king.y
        });
        
        if (closestPlayer.hp <= 0 && !closestPlayer.downed) {
          closestPlayer.hp = 0;
          closestPlayer.downed = true;
          closestPlayer.downedTime = Date.now();
          io.emit('playerDowned', {
            playerId: closestPlayer.id,
            x: closestPlayer.x,
            y: closestPlayer.y
          });
        }
        
        king.lastAttack = Date.now();
      }
    }
    
    if (king.isMoving) king.bouncePhase += dt * 6;
  }
}

function startKingJump(king, target) {
  king.state = 'jumpCharge';
  king.stateTimer = 2.0;
  king.jumpTarget = { x: target.x, y: target.y };
  io.emit('kingJumpCharge', { x: king.x, y: king.y, targetX: target.x, targetY: target.y });
}

function findNearbyGoblin(x, y, radius) {
  for (const e of enemies) {
    if (e.isKing) continue;
    if (e.type !== 'goblin') continue;
    if (Math.hypot(e.x - x, e.y - y) < radius) {
      return e;
    }
  }
  return null;
}

function spawnHorde(horde) {
  horde.state = 'active';
  horde.spawnedOnce = true;
  const count = 6;
  const spawnedPositions = [];
  
  for (let i = 0; i < count; i++) {
    const pos = findFreeSpawnPosition(horde.x + 0.5, horde.y + 0.5, 5, spawnedPositions);
    spawnedPositions.push(pos);
    
    if (horde.type === 'skeleton') {
      enemies.push(createSkeletonOrShield(pos.x, pos.y, true, horde.spawnId));
    } else if (horde.type === 'goblin') {
      enemies.push(createEnemy('goblin', pos.x, pos.y, 90, 15, 20, true, horde.spawnId));
    } else if (horde.type === 'escuridao') {
      enemies.push(createEnemy('escuridao', pos.x, pos.y, 200, 60, 40, true, horde.spawnId));
    } else if (horde.type === 'golem') {
      enemies.push(createEnemy('golem', pos.x, pos.y, 250, 40, 35, true, horde.spawnId));
    } else if (horde.type === 'demon') {
      enemies.push(createDemonOrArcanjo(pos.x, pos.y, true, horde.spawnId));
    }
  }
  
  let name = horde.type === 'skeleton' ? 'Esqueletos' : 
             horde.type === 'goblin' ? 'Goblins' : 
             horde.type === 'escuridao' ? 'Escuridões' : 
             horde.type === 'golem' ? 'Golems' : 'Demônios';
  
  io.emit('hordeSpawned', {
    x: horde.x + 0.5,
    y: horde.y,
    count: count,
    name: name
  });
}

function spawnGoblinKing(kingInstance) {
  kingInstance.state = 'active';
  const pos = findFreeSpawnPosition(kingInstance.x + 0.5, kingInstance.y + 0.5, 3, []);
  const king = createGoblinKing(pos.x, pos.y, kingInstance.spawnId);
  enemies.push(king);
  io.emit('goblinKingSpawned', { x: pos.x, y: pos.y });
}

let lastTime = Date.now();

setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  updateEnemies(dt);

  hordeInstances.forEach(horde => {
    if (horde.state === 'ready') {
      let closestDist = Infinity;
      Object.values(players).forEach(p => {
        if (p.downed) return;
        const dist = Math.hypot(p.x - (horde.x + 0.5), p.y - (horde.y + 0.5));
        if (dist < closestDist) closestDist = dist;
      });
      
      if (closestDist < 15 || horde.spawnedOnce) {
        spawnHorde(horde);
      }
    } else if (horde.state === 'active') {
      let alive = 0;
      enemies.forEach(e => { if (e.fromHorde && e.spawnId === horde.spawnId) alive++; });
      horde.aliveCount = alive;
      if (alive === 0) {
        horde.state = 'cooldown';
        horde.cooldownTimer = 15;
      }
    } else if (horde.state === 'cooldown') {
      horde.cooldownTimer -= dt;
      if (horde.cooldownTimer <= 0) {
        horde.state = 'ready';
      }
    }
  });

  goblinKingInstances.forEach(kingInstance => {
    if (kingInstance.state === 'ready') {
      let closestDist = Infinity;
      Object.values(players).forEach(p => {
        if (p.downed) return;
        const dist = Math.hypot(p.x - (kingInstance.x + 0.5), p.y - (kingInstance.y + 0.5));
        if (dist < closestDist) closestDist = dist;
      });
      
      if (closestDist < 15) {
        spawnGoblinKing(kingInstance);
      }
    } else if (kingInstance.state === 'active') {
      const kingAlive = enemies.some(e => e.isKing && e.spawnId === kingInstance.spawnId);
      if (!kingAlive) {
        kingInstance.state = 'cooldown';
        kingInstance.cooldownTimer = 600;
      }
    } else if (kingInstance.state === 'cooldown') {
      kingInstance.cooldownTimer -= dt;
      if (kingInstance.cooldownTimer <= 0) {
        kingInstance.state = 'ready';
      }
    }
  });

  console.log(`Enviando ${enemies.length} inimigos`);
  io.emit('enemiesUpdate', enemies);
}, 50);

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
    beingRevivedBy: null,
    resistance: 0
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

  socket.on('playerAttack', (attackData) => {
    enemies.forEach((e, index) => {
      const dist = Math.hypot(attackData.x - e.x, attackData.y - e.y);
      const hitRange = e.isKing ? 2.5 : 2.0;
      
      if (dist < hitRange) {
        const angleToEnemy = Math.atan2(e.y - attackData.y, e.x - attackData.x);
        let angleDiff = angleToEnemy - attackData.angle;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        
        if (Math.abs(angleDiff) <= Math.PI / 4) {
          const isCrit = Math.random() < 0.05;
          const dmg = isCrit ? attackData.damage * 2 : attackData.damage;
          
          e.hp -= dmg;
          
          io.emit('enemyDamaged', {
            enemyId: e.id,
            damage: dmg,
            isCrit: isCrit,
            x: e.x,
            y: e.y
          });

          if (e.isKing && (e.state === 'jumpCharge' || e.state === 'throwCharge')) {
            e.state = 'chasing';
            e.jumpTarget = null;
            if (e.carriedGoblin) {
              enemies.push(e.carriedGoblin);
              e.carriedGoblin = null;
            }
          }

          if (e.hp <= 0) {
            io.emit('enemyKilled', {
              enemyId: e.id,
              type: e.type,
              x: e.x,
              y: e.y,
              xp: e.xpReward,
              isKing: e.isKing,
              isArcanjo: e.isArcanjo,
              killerId: socket.id
            });
            
            if (players[socket.id]) {
              players[socket.id].kills++;
            }
            
            enemies.splice(index, 1);
          }
        }
      }
    });
  });
  
  socket.on('disconnect', () => {
    console.log('Jogador desconectou:', socket.id);
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

loadInitialEnemies();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Inimigos carregados: ${enemies.length}`);
});