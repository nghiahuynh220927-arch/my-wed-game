const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
 
const app = express();
const server = http.createServer(app);
const io = new Server(server);
 
app.use(express.static(path.join(__dirname, 'public')));
 
// ---- Cấu hình ----
const WORLD_W = 3000, WORLD_H = 2000;
const MONSTER_COUNT = 15;
const ATTACK = { range: 90, dmg: 15, cooldown: 400 };
const SKILL = { range: 180, dmg: 35, cooldown: 1000, mana: 30 };
 
const players = {};
const monsters = {};
let nextId = 1;
 
const rand = (a, b) => a + Math.random() * (b - a);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
 
function spawnMonster() {
    const id = 'm' + (nextId++);
    monsters[id] = {
        id,
        x: rand(100, WORLD_W - 100),
        y: rand(100, WORLD_H - 100),
        hp: 50, maxHp: 50, speed: 2, lastHit: 0
    };
}
for (let i = 0; i < MONSTER_COUNT; i++) spawnMonster();
 
// ---- Kinh nghiệm và cấp độ ----
const EXP_MONSTER = 25; // chỉ hạ quái mới nhận EXP
function addExp(p, amount) {
    p.exp += amount;
    io.emit('fx', { type: 'exp', x: p.x, y: p.y - 80, v: amount });
    while (p.exp >= p.expNext) {
        p.exp -= p.expNext;
        p.level++;
        p.expNext = 50 + (p.level - 1) * 30;
        p.maxHp += 20;
        p.maxMana += 10;
        p.hp = p.maxHp;
        p.mana = p.maxMana;
        io.emit('fx', { type: 'levelup', x: p.x, y: p.y - 60 });
    }
}
 
function damagePlayer(id, amount) {
    const p = players[id];
    if (!p || p.dead) return false;
    p.hp = Math.max(0, p.hp - amount);
    io.emit('fx', { type: 'dmg', x: p.x, y: p.y - 50, v: amount });
    if (p.hp <= 0) {
        p.dead = true;
        setTimeout(() => {
            if (!players[id]) return;
            p.hp = p.maxHp;
            p.mana = p.maxMana;
            p.dead = false;
            p.x = rand(200, WORLD_W - 200);
            p.y = rand(200, WORLD_H - 200);
            io.to(id).emit('respawn', { x: p.x, y: p.y });
        }, 3000);
        return true;
    }
    return false;
}
 
function hitArea(attackerId, range, dmg) {
    const me = players[attackerId];
    if (!me) return;
    dmg += (me.level - 1) * 4; // mỗi cấp tăng 4 sát thương
    for (const mid in monsters) {
        const m = monsters[mid];
        if (dist(me, m) <= range) {
            m.hp -= dmg;
            io.emit('fx', { type: 'dmg', x: m.x, y: m.y - 30, v: dmg });
            if (m.hp <= 0) {
                delete monsters[mid];
                addExp(me, EXP_MONSTER);
                setTimeout(spawnMonster, 5000);
            }
        }
    }
    for (const qid in players) {
        if (qid === attackerId) continue;
        const q = players[qid];
        if (q.dead || dist(me, q) > range) continue;
        damagePlayer(qid, dmg); // đánh người chơi: gây sát thương, KHÔNG nhận EXP
    }
}
 
io.on('connection', (socket) => {
    players[socket.id] = {
        x: rand(200, WORLD_W - 200),
        y: rand(200, WORLD_H - 200),
        isMoving: false, hp: 100, mana: 100, color: '#ff3333',
        maxHp: 100, maxMana: 100, level: 1, exp: 0, expNext: 50,
        dead: false, lastAttack: 0, lastSkill: 0
    };
    socket.emit('respawn', { x: players[socket.id].x, y: players[socket.id].y });
 
    socket.on('move', (data) => {
        const p = players[socket.id];
        if (!p || p.dead || !data) return;
        if (typeof data.x === 'number') p.x = Math.max(0, Math.min(WORLD_W, data.x));
        if (typeof data.y === 'number') p.y = Math.max(0, Math.min(WORLD_H, data.y));
        p.isMoving = !!data.isMoving;
    });
 
    socket.on('attack', () => {
        const p = players[socket.id];
        if (!p || p.dead) return;
        const now = Date.now();
        if (now - p.lastAttack < ATTACK.cooldown) return;
        p.lastAttack = now;
        io.emit('fx', { type: 'slash', x: p.x, y: p.y, r: ATTACK.range });
        hitArea(socket.id, ATTACK.range, ATTACK.dmg);
    });
 
    socket.on('skill', () => {
        const p = players[socket.id];
        if (!p || p.dead) return;
        const now = Date.now();
        if (now - p.lastSkill < SKILL.cooldown || p.mana < SKILL.mana) return;
        p.lastSkill = now;
        p.mana -= SKILL.mana;
        io.emit('fx', { type: 'blast', x: p.x, y: p.y, r: SKILL.range });
        hitArea(socket.id, SKILL.range, SKILL.dmg);
    });
 
    socket.on('disconnect', () => { delete players[socket.id]; });
});
 
// Hồi Mana mỗi giây
setInterval(() => {
    for (const id in players) {
        const p = players[id];
        if (!p.dead) p.mana = Math.min(p.maxMana, p.mana + 5);
    }
}, 1000);
 
// Vòng lặp game: quái đuổi và đánh người chơi, gửi trạng thái
setInterval(() => {
    const now = Date.now();
    for (const mid in monsters) {
        const m = monsters[mid];
        let target = null, best = 500;
        for (const id in players) {
            const p = players[id];
            if (p.dead) continue;
            const d = dist(m, p);
            if (d < best) { best = d; target = id; }
        }
        if (!target) continue;
        const t = players[target];
        if (best > 40) {
            m.x += (t.x - m.x) / best * m.speed;
            m.y += (t.y - m.y) / best * m.speed;
        } else if (now - m.lastHit > 1000) {
            m.lastHit = now;
            damagePlayer(target, 8);
        }
    }
    io.emit('state', { players, monsters });
}, 1000 / 60);
 
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Game chạy tại http://localhost:' + PORT));