const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// Các trang được phép kết nối vào server
const ALLOWED_ORIGINS = [
    'http://localhost:3000',
    'https://my-wed-game.onrender.com'
];
const io = new Server(server, {
    cors: { origin: ALLOWED_ORIGINS }
});

// ---- TÍCH HỢP XÁC THỰC (AUTH) ----
const { setupAuth } = require('./auth');
app.use(express.json()); 
setupAuth(app, io);        

app.use(express.static(path.join(__dirname, 'public')));

// ---- Cấu hình game ----
const WORLD_W = 3000, WORLD_H = 2000;
const MONSTER_COUNT = 15;
const ATTACK = { range: 90, dmg: 15, cooldown: 400 };
const SKILL = { range: 180, dmg: 35, cooldown: 1000, mana: 30 };

const players = {};
const monsters = {};
let nextId = 1;

const USERS_FILE = path.join(__dirname, 'users.json');
function saveUserData(username, data) {
    try {
        if (!username) return;
        const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        const key = username.toLowerCase();
        if (users[key]) {
            users[key].data = data;
            fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        }
    } catch (e) {
        console.error('Lỗi khi lưu dữ liệu người chơi:', e);
    }
}

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
const EXP_MONSTER = 25; 
function addExp(socketId, amount) {
    const p = players[socketId];
    if (!p) return;
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
    saveUserData(p.name, {
        hp: p.hp, maxHp: p.maxHp, mana: p.mana, maxMana: p.maxMana,
        level: p.level, exp: p.exp, expNext: p.expNext, x: p.x, y: p.y
    });
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
            saveUserData(p.name, {
                hp: p.hp, maxHp: p.maxHp, mana: p.mana, maxMana: p.maxMana,
                level: p.level, exp: p.exp, expNext: p.expNext, x: p.x, y: p.y
            });
        }, 3000);
        return true;
    }
    saveUserData(p.name, {
        hp: p.hp, maxHp: p.maxHp, mana: p.mana, maxMana: p.maxMana,
        level: p.level, exp: p.exp, expNext: p.expNext, x: p.x, y: p.y
    });
    return false;
}

function hitArea(attackerId, range, dmg) {
    const me = players[attackerId];
    if (!me) return;
    dmg += (me.level - 1) * 4; 
    for (const mid in monsters) {
        const m = monsters[mid];
        if (dist(me, m) <= range) {
            m.hp -= dmg;
            io.emit('fx', { type: 'dmg', x: m.x, y: m.y - 30, v: dmg });
            if (m.hp <= 0) {
                delete monsters[mid];
                addExp(attackerId, EXP_MONSTER);
                setTimeout(spawnMonster, 5000);
            }
        }
    }
    for (const qid in players) {
        if (qid === attackerId) continue;
        const q = players[qid];
        if (q.dead || dist(me, q) > range) continue;
        damagePlayer(qid, dmg);
    }
}

// ---- KẾT NỐI SOCKET ----
io.on('connection', (socket) => {
    console.log('Người chơi kết nối:', socket.username, socket.id);

    let savedData = {};
    try {
        const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        const key = (socket.username || '').toLowerCase();
        if (users[key] && users[key].data) {
            savedData = users[key].data;
        }
    } catch (e) {}

    players[socket.id] = {
        x: savedData.x ?? rand(200, WORLD_W - 200),
        y: savedData.y ?? rand(200, WORLD_H - 200),
        isMoving: false, 
        hp: savedData.hp ?? 100, 
        mana: savedData.mana ?? 100, 
        color: '#ff3333',
        maxHp: savedData.maxHp ?? 100, 
        maxMana: savedData.maxMana ?? 100, 
        level: savedData.level ?? 1, 
        exp: savedData.exp ?? 0, 
        expNext: savedData.expNext ?? 50,
        dead: false, 
        lastAttack: 0, 
        lastSkill: 0,
        name: socket.username
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
        saveUserData(p.name, {
            hp: p.hp, maxHp: p.maxHp, mana: p.mana, maxMana: p.maxMana,
            level: p.level, exp: p.exp, expNext: p.expNext, x: p.x, y: p.y
        });
    });

    socket.on('disconnect', () => { 
        const p = players[socket.id];
        if (p) {
            saveUserData(p.name, {
                hp: p.hp, maxHp: p.maxHp, mana: p.mana, maxMana: p.maxMana,
                level: p.level, exp: p.exp, expNext: p.expNext, x: p.x, y: p.y
            });
        }
        delete players[socket.id]; 
    });
});

// Hồi Mana mỗi giây
setInterval(() => {
    for (const id in players) {
        const p = players[id];
        if (!p.dead) p.mana = Math.min(p.maxMana, p.mana + 5);
    }
}, 1000);

// Vòng lặp game: quái đuổi và đánh người chơi
setInterval(() => {
    const now = Date.now();
    for (const mid in monsters) {
        const m = monsters[mid];
        let target = null, best = 1000;
        for (const id in players) {
            const p = players[id];
            if (p.dead) continue;
            const d = dist(m, p);
            if (d < best) { best = d; target = id; }
        }
        if (!target) continue;
        const t = players[target];
        if (best > 40) {
            const angle = Math.atan2(t.y - m.y, t.x - m.x);
            m.x += Math.cos(angle) * m.speed;
            m.y += Math.sin(angle) * m.speed;
        } else if (now - m.lastHit > 1000) {
            m.lastHit = now;
            damagePlayer(target, 8);
        }
    }
}, 1000 / 60);

// Gửi trạng thái game về client (60 lần/giây)
setInterval(() => {
    io.emit('state', { players, monsters });
}, 1000 / 60);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Game chạy tại http://localhost:' + PORT));
