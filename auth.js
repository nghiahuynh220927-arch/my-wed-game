const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ĐỔI chuỗi này thành chuỗi bí mật của riêng bạn trước khi đưa game lên mạng
const SECRET = process.env.JWT_SECRET || 'doi-chuoi-bi-mat-nay';
const FILE = path.join(__dirname, 'users.json');

function loadUsers() {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch { return {}; }
}

function saveUsers(users) {
    fs.writeFileSync(FILE, JSON.stringify(users, null, 2));
}

// Chống thử mật khẩu liên tục: tối đa 10 lần / 5 phút / IP
const attempts = {};
function tooMany(ip) {
    const now = Date.now();
    const list = (attempts[ip] || []).filter(t => now - t < 5 * 60 * 1000);
    list.push(now);
    attempts[ip] = list;
    return list.length > 10;
}

function makeToken(username) {
    return jwt.sign({ username }, SECRET, { expiresIn: '7d' });
}

function setupAuth(app, io) {
    // ----- ĐĂNG KÝ -----
    app.post('/api/register', (req, res) => {
        if (tooMany(req.ip)) {
            return res.status(429).json({ error: 'Thử quá nhiều lần, hãy đợi vài phút.' });
        }

        const username = String((req.body && req.body.username) || '').trim();
        const password = String((req.body && req.body.password) || '');

        if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
            return res.status(400).json({
                error: 'Tên tài khoản 3-16 ký tự, chỉ gồm chữ, số và dấu _'
            });
        }
        if (password.length < 6 || password.length > 64) {
            return res.status(400).json({ error: 'Mật khẩu phải từ 6 đến 64 ký tự.' });
        }

        const users = loadUsers();
        const key = username.toLowerCase();

        if (users[key]) {
            return res.status(409).json({ error: 'Tên tài khoản đã có người dùng.' });
        }

        users[key] = {
            username,
            hash: bcrypt.hashSync(password, 10),
            createdAt: Date.now(),
            data: {}   // sau này lưu level, exp... vào đây
        };
        saveUsers(users);

        res.json({ token: makeToken(username), username });
    });

    // ----- ĐĂNG NHẬP -----
    app.post('/api/login', (req, res) => {
        if (tooMany(req.ip)) {
            return res.status(429).json({ error: 'Thử quá nhiều lần, hãy đợi vài phút.' });
        }

        const username = String((req.body && req.body.username) || '').trim();
        const password = String((req.body && req.body.password) || '');

        const user = loadUsers()[username.toLowerCase()];

        if (!user || !bcrypt.compareSync(password, user.hash)) {
            return res.status(401).json({ error: 'Sai tên tài khoản hoặc mật khẩu.' });
        }

        res.json({ token: makeToken(user.username), username: user.username });
    });

    // ----- CHẶN SOCKET NẾU CHƯA ĐĂNG NHẬP -----
    io.use((socket, next) => {
        const token = socket.handshake.auth && socket.handshake.auth.token;

        try {
            const payload = jwt.verify(token, SECRET);
            socket.username = payload.username;

            // Một tài khoản chỉ chơi 1 nơi: đá phiên cũ ra
            for (const [, s] of io.sockets.sockets) {
                if (s.username === socket.username) {
                    s.emit('kicked');
                    s.disconnect(true);
                }
            }

            next();
        } catch (err) {
            next(new Error('Chưa đăng nhập'));
        }
    });
}

module.exports = { setupAuth };