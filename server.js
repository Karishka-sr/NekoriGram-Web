'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { WebSocketServer } = require('ws');

const { db, hashPassword, verifyPassword, publicUser } = require('./db');
const bus = require('./bus');

const PORT = Number(process.env.PORT || 12000);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN_SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex');

const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- helpers ----------

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  try {
    const [body, sig] = String(token || '').split('.');
    const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function auth(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
  return row ? { user: row, token } : null;
}

function now() {
  return Date.now();
}

// ---------- chat query helpers ----------

function lastMessageForChat(chatId) {
  return db.prepare(
    `SELECT m.* FROM messages m
     WHERE m.chat_id = ? AND m.deleted = 0
     ORDER BY m.id DESC LIMIT 1`
  ).get(chatId);
}

function chatDto(chat, viewerId) {
  const last = lastMessageForChat(chat.id);
  const unread = db.prepare(
    `SELECT COUNT(*) AS c FROM messages
     WHERE chat_id = ? AND deleted = 0 AND id > ?
     AND sender_id != ?`
  ).get(chat.id, readMark(viewerId, chat.id), viewerId).c;

  let title = chat.title;
  let avatar = chat.avatar;

  if (chat.type === 'private') {
    const other = db.prepare(
      `SELECT u.* FROM chat_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.chat_id = ? AND cm.user_id != ?`
    ).get(chat.id, viewerId);
    if (other) {
      title = [other.first_name, other.last_name].filter(Boolean).join(' ') || other.username || ('user ' + other.id);
      avatar = other.avatar;
    }
  }

  return {
    id: chat.id,
    type: chat.type,
    title: title || 'Без названия',
    avatar,
    last_message: last ? messageDto(last, viewerId, chat) : null,
    unread,
  };
}

function readMark(userId, chatId) {
  const r = db.prepare('SELECT last_read_message_id FROM read_marks WHERE user_id = ? AND chat_id = ?')
    .get(userId, chatId);
  return r ? r.last_read_message_id : 0;
}

function messageDto(m, viewerId, chat) {
  if (!m) return null;
  const sender = m.sender_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(m.sender_id) : null;
  const chatRow = chat || db.prepare('SELECT * FROM chats WHERE id = ?').get(m.chat_id);
  let reply = null;
  if (m.reply_to) {
    const r = db.prepare('SELECT * FROM messages WHERE id = ?').get(m.reply_to);
    if (r) {
      const rs = r.sender_id ? db.prepare('SELECT first_name, last_name, username FROM users WHERE id = ?').get(r.sender_id) : null;
      reply = { id: r.id, text: r.text, sender_name: nameOf(rs) };
    }
  }
  return {
    id: m.id,
    chat_id: m.chat_id,
    sender_id: m.sender_id,
    sender_name: m.sender_id ? nameOf(sender) : 'Удалённый аккаунт',
    sender_avatar: sender ? sender.avatar : null,
    text: m.text,
    attachment: m.attachment,
    reply,
    edited: !!m.edited_at,
    created_at: m.created_at,
    is_me: m.sender_id === viewerId,
    my_read: chatRow ? readMark(viewerId, chatRow.id) >= m.id : undefined,
  };
}

function nameOf(user) {
  if (!user) return '';
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || ('user ' + user.id);
}

function normalizeUsername(u) {
  return String(u || '').trim().replace(/^@/, '');
}

// ---------- websocket hub ----------

const clients = new Map(); // userId -> Set<ws>

function wsSend(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcastToUser(userId, obj) {
  const set = clients.get(userId);
  if (!set) return;
  for (const ws of set) wsSend(ws, obj);
}

function eventPayloadFor(userId, event) {
  switch (event.type) {
    case 'message': {
      const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(event.message_id);
      if (!msg || msg.deleted) return null;
      return { type: 'message', message: messageDto(msg, userId) };
    }
    case 'message_deleted':
      return {
        type: 'message_deleted',
        chat_id: event.chat_id,
        message_id: event.message_id,
        deleted_by: event.deleted_by,
      };
    case 'read':
      return {
        type: 'read',
        chat_id: event.chat_id,
        user_id: event.user_id,
        message_id: event.message_id,
      };
    case 'typing':
      return {
        type: 'typing',
        chat_id: event.chat_id,
        user_id: event.user_id,
        user_name: event.user_name,
      };
    default:
      return null;
  }
}

/**
 * Рассылает событие чата всем его участникам, кроме exceptUserId: сначала
 * локальным WebSocket-клиентам, затем остальным процессам через шину.
 */
function emitChatEvent(event, exceptUserId) {
  const members = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(event.chat_id);
  for (const { user_id } of members) {
    if (user_id === exceptUserId) continue;
    const payload = eventPayloadFor(user_id, event);
    if (payload) broadcastToUser(user_id, payload);
  }
  bus.publish({ ...event, except_user_id: exceptUserId || null });
}

bus.onEvent((event) => {
  const members = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(event.chat_id);
  for (const { user_id } of members) {
    if (user_id === event.except_user_id) continue;
    const payload = eventPayloadFor(user_id, event);
    if (payload) broadcastToUser(user_id, payload);
  }
});

// ---------- http server & routes ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    // REST API
    if (p.startsWith('/api/')) {
      const method = req.method;
      const session = auth(req);

      // ---- auth ----
      if (p === '/api/auth/register' && method === 'POST') {
        const body = await readBody(req);
        const phone = String(body.phone || '').replace(/\D/g, '');
        const first_name = String(body.first_name || '').trim();
        const last_name = String(body.last_name || '').trim();
        const username = normalizeUsername(body.username) || null;
        const password = String(body.password || '');
        if (phone.length < 5) return json(res, 400, { error: 'Введите корректный номер телефона' });
        if (!first_name) return json(res, 400, { error: 'Укажите имя' });
        if (password.length < 4) return json(res, 400, { error: 'Пароль должен быть не короче 4 символов' });

        const exists = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
        if (exists) return json(res, 409, { error: 'Пользователь с таким номером уже существует' });
        if (username && db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
          return json(res, 409, { error: 'Этот @username уже занят' });
        }

        const info = db.prepare(
          'INSERT INTO users (phone, first_name, last_name, username, avatar, about, password_hash, created_at) VALUES (?,?,?,?,?,?,?,?)'
        ).run(phone, first_name, last_name, username, null, '', hashPassword(password), now());

        const row = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
        const token = signToken({ uid: row.id, exp: Date.now() + 365 * 24 * 3600 * 1000 });
        return json(res, 201, { user: publicUser(row), token });
      }

      if (p === '/api/auth/login' && method === 'POST') {
        const body = await readBody(req);
        const login = String(body.login || '').trim();
        const password = String(body.password || '');
        const row = login.startsWith('+')
          ? db.prepare('SELECT * FROM users WHERE phone = ?').get(login.replace(/\D/g, ''))
          : db.prepare('SELECT * FROM users WHERE username = ?').get(normalizeUsername(login));
        if (!row || !verifyPassword(password, row.password_hash)) {
          return json(res, 401, { error: 'Неверный логин или пароль' });
        }
        const token = signToken({ uid: row.id, exp: Date.now() + 365 * 24 * 3600 * 1000 });
        return json(res, 200, { user: publicUser(row), token });
      }

      if (!session) return json(res, 401, { error: 'Требуется авторизация' });

      const me = session.user;

      if (p === '/api/auth/me' && method === 'GET') {
        return json(res, 200, { user: publicUser(me) });
      }

      // ---- users ----
      if (p === '/api/users' && method === 'GET') {
        const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
        const rows = db.prepare('SELECT * FROM users WHERE id != ? LIMIT 500').all(me.id);
        if (!q) return json(res, 200, { users: rows.slice(0, 20).map(publicUser) });
        const filtered = rows.filter((u) => {
          const full = [u.first_name, u.last_name, u.username].filter(Boolean).join(' ').toLowerCase();
          return full.includes(q);
        });
        return json(res, 200, { users: filtered.slice(0, 20).map(publicUser) });
      }

      if (p.startsWith('/api/users/') && method === 'GET') {
        const id = Number(p.split('/').pop());
        const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        if (!row) return json(res, 404, { error: 'Пользователь не найден' });
        return json(res, 200, { user: publicUser(row) });
      }

      // ---- chats ----
      if (p === '/api/chats' && method === 'GET') {
        const rows = db.prepare(
          `SELECT c.* FROM chats c
           JOIN chat_members cm ON cm.chat_id = c.id
           WHERE cm.user_id = ?
           ORDER BY COALESCE((SELECT MAX(id) FROM messages WHERE chat_id = c.id AND deleted = 0), 0) DESC`
        ).all(me.id);
        return json(res, 200, { chats: rows.map((c) => chatDto(c, me.id)) });
      }

      if (p === '/api/chats' && method === 'POST') {
        const body = await readBody(req);
        const type = body.type === 'group' ? 'group' : 'private';
        const userIds = Array.from(new Set((body.user_ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== me.id)));

        if (!userIds.length) return json(res, 400, { error: 'Выберите участников' });

        if (type === 'private') {
          const otherId = userIds[0];
          const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
          if (!other) return json(res, 404, { error: 'Пользователь не найден' });
          const existing = db.prepare(
            `SELECT c.id FROM chats c
             JOIN chat_members a ON a.chat_id = c.id AND a.user_id = ?
             JOIN chat_members b ON b.chat_id = c.id AND b.user_id = ?
             WHERE c.type = 'private'
             GROUP BY c.id HAVING COUNT(*) = 2`
          ).get(Math.min(me.id, otherId), Math.max(me.id, otherId));
          if (existing) return json(res, 200, { chat: chatDto(db.prepare('SELECT * FROM chats WHERE id = ?').get(existing.id), me.id) });

          const info = db.prepare('INSERT INTO chats (type, title, avatar, created_by, created_at) VALUES (?,?,?,?,?)')
            .run('private', null, null, me.id, now());
          const chatId = info.lastInsertRowid;
          db.prepare('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?,?,?)').run(chatId, me.id, now());
          db.prepare('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?,?,?)').run(chatId, otherId, now());
          db.prepare('INSERT INTO read_marks (user_id, chat_id) VALUES (?,?)').run(me.id, chatId);
          db.prepare('INSERT INTO read_marks (user_id, chat_id) VALUES (?,?)').run(otherId, chatId);
          return json(res, 201, { chat: chatDto(db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId), me.id) });
        }

        const title = String(body.title || '').trim();
        if (!title) return json(res, 400, { error: 'Укажите название группы' });
        const info = db.prepare('INSERT INTO chats (type, title, created_by, created_at) VALUES (?,?,?,?)')
          .run('group', title, me.id, now());
        const chatId = info.lastInsertRowid;
        db.prepare('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?,?,?)').run(chatId, me.id, now());
        db.prepare('INSERT INTO read_marks (user_id, chat_id) VALUES (?,?)').run(me.id, chatId);
        for (const uid of userIds) {
          db.prepare('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?,?,?)').run(chatId, uid, now());
          db.prepare('INSERT INTO read_marks (user_id, chat_id) VALUES (?,?)').run(uid, chatId);
        }
        return json(res, 201, { chat: chatDto(db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId), me.id) });
      }

      // ---- chat detail ----
      const chatMatch = p.match(/^\/api\/chats\/(\d+)(\/messages)?$/);
      if (chatMatch) {
        const chatId = Number(chatMatch[1]);
        const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
        if (!chat) return json(res, 404, { error: 'Чат не найден' });
        const member = db.prepare('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, me.id);
        if (!member) return json(res, 403, { error: 'Вы не состоите в этом чате' });

        if (method === 'GET' && chatMatch[2]) {
          const before = Number(url.searchParams.get('before_id') || 0);
          const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
          const rows = before
            ? db.prepare('SELECT * FROM messages WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
                .all(chatId, before, limit)
            : db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?')
                .all(chatId, limit);
          return json(res, 200, {
            messages: rows.reverse().map((m) => messageDto(m, me.id, chat)),
            chat: chatDto(chat, me.id),
          });
        }

        if (method === 'POST' && chatMatch[2]) {
          const body = await readBody(req);
          const text = String(body.text || '').trim();
          if (!text) return json(res, 400, { error: 'Сообщение не может быть пустым' });
          const replyTo = body.reply_to ? Number(body.reply_to) : null;
          const info = db.prepare(
            'INSERT INTO messages (chat_id, sender_id, text, reply_to, created_at) VALUES (?,?,?,?,?)'
          ).run(chatId, me.id, text, replyTo, now());
          const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
          // auto-read own sent message
          db.prepare(
            'INSERT INTO read_marks (user_id, chat_id, last_read_message_id) VALUES (?,?,?) ON CONFLICT(user_id, chat_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)'
          ).run(me.id, chatId, msg.id);

          emitChatEvent({ type: 'message', chat_id: chatId, message_id: msg.id }, null);
          return json(res, 201, { message: messageDto(msg, me.id, chat) });
        }
      }

      if (p === '/api/chats/:id/read') {
        // handled below via regex
      }

      const readMatch = p.match(/^\/api\/chats\/(\d+)\/read$/);
      if (readMatch && method === 'POST') {
        const chatId = Number(readMatch[1]);
        const body = await readBody(req);
        const msgId = Number(body.message_id || 0);
        db.prepare(
          'INSERT INTO read_marks (user_id, chat_id, last_read_message_id) VALUES (?,?,?) ON CONFLICT(user_id, chat_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)'
        ).run(me.id, chatId, msgId);
        emitChatEvent({ type: 'read', chat_id: chatId, user_id: me.id, message_id: msgId }, me.id);
        return json(res, 200, { ok: true });
      }

      const editMatch = p.match(/^\/api\/messages\/(\d+)\/edit$/);
      if (editMatch && method === 'POST') {
        const msgId = Number(editMatch[1]);
        const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
        if (!msg || msg.sender_id !== me.id) return json(res, 403, { error: 'Нельзя редактировать это сообщение' });
        const body = await readBody(req);
        const text = String(body.text || '').trim();
        if (!text) return json(res, 400, { error: 'Сообщение не может быть пустым' });
        db.prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?').run(text, now(), msgId);
        const updated = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
        emitChatEvent({ type: 'message', chat_id: msg.chat_id, message_id: msgId }, null);
        return json(res, 200, { message: messageDto(updated, me.id) });
      }

      const delMatch = p.match(/^\/api\/messages\/(\d+)\/delete$/);
      if (delMatch && method === 'POST') {
        const msgId = Number(delMatch[1]);
        const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
        if (!msg || msg.sender_id !== me.id) return json(res, 403, { error: 'Нельзя удалить это сообщение' });
        db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(msgId);
        emitChatEvent({ type: 'message_deleted', chat_id: msg.chat_id, message_id: msgId, deleted_by: me.id }, me.id);
        return json(res, 200, { ok: true });
      }

      const leaveMatch = p.match(/^\/api\/chats\/(\d+)\/leave$/);
      if (leaveMatch && method === 'POST') {
        const chatId = Number(leaveMatch[1]);
        db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chatId, me.id);
        db.prepare('DELETE FROM read_marks WHERE chat_id = ? AND user_id = ?').run(chatId, me.id);
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: 'Not found' });
    }

    // ---- static files ----
    const filePath = p === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, p);
    const safe = filePath.startsWith(PUBLIC_DIR);
    if (!safe || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.woff2': 'font/woff2',
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('Request error:', err);
    if (!res.headersSent) json(res, 500, { error: 'Внутренняя ошибка сервера' });
  }
});

// ---------- websocket ----------

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const payload = verifyToken(url.searchParams.get('token'));
  if (!payload) {
    ws.close(4001, 'unauthorized');
    return;
  }
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
  if (!row) {
    ws.close(4001, 'unauthorized');
    return;
  }
  const userId = row.id;
  ws.userId = userId;
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(ws);
  wsSend(ws, { type: 'connected', me: publicUser(row) });

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (data.type) {
      case 'typing': {
        emitChatEvent({
          type: 'typing',
          chat_id: Number(data.chat_id),
          user_id: userId,
          user_name: nameOf(row),
        }, userId);
        break;
      }
      case 'read': {
        const chatId = Number(data.chat_id);
        const msgId = Number(data.message_id) || 0;
        db.prepare(
          'INSERT INTO read_marks (user_id, chat_id, last_read_message_id) VALUES (?,?,?) ON CONFLICT(user_id, chat_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)'
        ).run(userId, chatId, msgId);
        emitChatEvent({ type: 'read', chat_id: chatId, user_id: userId, message_id: msgId }, userId);
        break;
      }
      case 'ping':
        wsSend(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    const set = clients.get(userId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) clients.delete(userId);
    }
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Порт ${PORT} уже занят — узел, вероятно, уже запущен`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`NekoriGram Web listening on http://${HOST}:${PORT}`);
});