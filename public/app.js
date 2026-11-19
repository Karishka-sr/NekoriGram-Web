'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);

  let token = localStorage.getItem('ng_token') || null;
  let me = JSON.parse(localStorage.getItem('ng_me') || 'null');
  let ws = null;
  let chats = [];
  let activeChatId = null;
  let messagesCache = new Map(); // chatId -> array
  let selectedUserIds = new Set();
  let typingTimers = new Map(); // chatId -> {timer, userIds:Set}
  let replyTarget = null;

  const EMOJIS = ['😀','😂','😊','😍','🤔','😎','😢','😡','👍','👎','🙏','🔥','❤️','🎉','😂','😅','🥰','🤯','💯','🍕','🚀','✅','❌','❗','❓','💬','📎','🎵','🎮','⚽'];

  // ---------- api ----------
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Ошибка запроса');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------- helpers ----------
  function avatarText(user) {
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
    return (name.trim() ? name.trim()[0] : (user.username || '?')[0]).toUpperCase();
  }

  function renderAvatar(el, user, size) {
    if (!el) return;
    if (user && user.avatar) {
      el.innerHTML = `<img src="${user.avatar}" alt="">`;
    } else {
      const text = user ? avatarText(user) : '?';
      const hue = user ? (user.id % 360) : 200;
      el.innerHTML = text;
      el.style.background = `hsl(${hue}, 45%, 45%)`;
    }
    el.style.width = el.style.height = (size || '40') + 'px';
    el.style.minWidth = (size || '40') + 'px';
    el.style.fontSize = Math.round((size || 40) * 0.4) + 'px';
  }

  function timeLabel(ts) {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'вчера';
    const diff = (now - d) / 86400000;
    if (diff < 7) return d.toLocaleDateString('ru-RU', { weekday: 'short' });
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }

  function dayLabel(ts) {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Сегодня';
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Вчера';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function scrollToBottom(smooth = false) {
    const m = $('#messages');
    if (m) m.scrollTo({ top: m.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  function showAuthError(msg) {
    const el = $('#auth-error');
    el.textContent = msg;
    el.hidden = false;
  }

  // ---------- socket ----------
  function connectSocket() {
    if (ws) ws.close();
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => console.log('ws connected');
    ws.onclose = () => setTimeout(() => { if (token) connectSocket(); }, 2000);
    ws.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }
      handleSocket(data);
    };
  }

  function handleSocket(data) {
    switch (data.type) {
      case 'connected':
        break;
      case 'message': {
        const msg = data.message;
        // update chat list ordering
        const chatIdx = chats.findIndex((c) => c.id === msg.chat_id);
        if (chatIdx >= 0) {
          const chat = chats[chatIdx];
          chat.last_message = msg;
          chats.splice(chatIdx, 1);
          chats.unshift(chat);
          renderChatList();
        }
        appendMessage(msg);
        if (msg.chat_id === activeChatId && !msg.is_me) sendRead(msg);
        break;
      }
      case 'message_deleted':
        removeMessage(data.chat_id, data.message_id);
        break;
      case 'read':
        updateReadMarks(data.chat_id, data.user_id, data.message_id);
        break;
      case 'typing':
        setTyping(data.chat_id, data.user_id, data.user_name);
        break;
    }
  }

  // ---------- rendering: chat list ----------
  function chatTitle(chat) {
    return chat.title || 'Чат';
  }

  function chatPreview(chat) {
    if (!chat.last_message) return 'Нет сообщений';
    const pref = chat.type !== 'private' ? `${chat.last_message.sender_name}: ` : '';
    return pref + chat.last_message.text;
  }

  function renderChatList() {
    const list = $('#chat-list');
    list.innerHTML = '';
    const q = $('#search-input').value.trim().toLowerCase();
    for (const chat of chats) {
      const title = chatTitle(chat).toLowerCase();
      if (q && !title.includes(q)) continue;
      const el = document.createElement('div');
      el.className = 'chat-item' + (chat.id === activeChatId ? ' active' : '');
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      renderAvatar(avatar, { id: chat.id, first_name: chatTitle(chat), username: chatTitle(chat), avatar: chat.avatar });
      const info = document.createElement('div');
      info.className = 'chat-item-info';
      info.innerHTML = `
        <div class="chat-item-top">
          <span class="chat-item-name">${escapeHtml(chatTitle(chat))}</span>
          <span class="chat-item-time">${chat.last_message ? timeLabel(chat.last_message.created_at) : ''}</span>
        </div>
        <div class="chat-item-preview">
          <span>${escapeHtml(chatPreview(chat))}</span>
          ${chat.unread ? `<span class="unread-badge">${chat.unread}</span>` : ''}
        </div>`;
      el.appendChild(avatar);
      el.appendChild(info);
      el.onclick = () => openChat(chat);
      list.appendChild(el);
    }
  }

  function renderChatListTyping(chatId, userName) {
    const list = $('#chat-list');
    for (const item of list.children) {
      if (item.dataset.chatId === String(chatId)) { }
    }
  }

  // ---------- rendering: messages ----------
  function messagesContainer(chatId) {
    const m = $('#messages');
    m.innerHTML = '';
    const arr = messagesCache.get(chatId) || [];
    for (const msg of arr) appendMessage(msg);
    scrollToBottom();
  }

  function insertDayDividers(chatId) {
    const m = $('#messages');
    const arr = messagesCache.get(chatId) || [];
    // rebuild with dividers
    m.innerHTML = '';
    let lastDay = null;
    for (const msg of arr) {
      const d = new Date(msg.created_at || 0).toDateString();
      if (d !== lastDay) {
        lastDay = d;
        const div = document.createElement('div');
        div.className = 'day-divider';
        div.textContent = dayLabel(msg.created_at);
        m.appendChild(div);
      }
      m.appendChild(createMessageEl(msg));
    }
  }

  function appendMessage(msg) {
    if (!msg || typeof msg.chat_id === 'undefined') return;
    if (!messagesCache.has(msg.chat_id)) messagesCache.set(msg.chat_id, []);
    const arr = messagesCache.get(msg.chat_id);
    const existing = arr.find((x) => x.id === msg.id);
    if (existing) Object.assign(existing, msg);
    else arr.push(msg);
    arr.sort((a, b) => a.id - b.id);

    if (msg.chat_id !== activeChatId) return;
    const isActive = messagesCache.get(msg.chat_id).some((x) => x.id === msg.id);
    renderActiveMessages();
  }

  function renderActiveMessages() {
    const m = $('#messages');
    const arr = messagesCache.get(activeChatId) || [];
    m.innerHTML = '';
    let lastDay = null;
    for (const msg of arr) {
      const d = new Date(msg.created_at || 0).toDateString();
      if (d !== lastDay) {
        lastDay = d;
        const div = document.createElement('div');
        div.className = 'day-divider';
        div.textContent = dayLabel(msg.created_at);
        m.appendChild(div);
      }
      m.appendChild(createMessageEl(msg));
    }
    scrollToBottom();
  }

  function createMessageEl(msg) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${msg.is_me ? 'mine' : 'theirs'}`;
    wrap.dataset.id = msg.id;

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    if (msg.deleted) {
      bubble.innerHTML = `<div class="deleted-msg">Сообщение удалено</div>`;
    } else {
      if (!msg.is_me && msg.sender_name && (messagesCache.get(activeChatId) || []).some((x) => x.chat_id === activeChatId)) {
        const chat = chats.find((c) => c.id === activeChatId);
        if (chat && chat.type !== 'private') {
          const sender = document.createElement('div');
          sender.className = 'msg-sender';
          sender.textContent = msg.sender_name;
          bubble.appendChild(sender);
        }
      }

      if (msg.reply && msg.reply.id) {
        const rp = document.createElement('div');
        rp.className = 'reply-bubble';
        rp.innerHTML = `<span class="reply-name">${escapeHtml(msg.reply.sender_name)}</span><br>${escapeHtml(msg.reply.text.slice(0, 80))}`;
        rp.title = 'Ответ на сообщение';
        bubble.appendChild(rp);
      }

      const text = document.createElement('div');
      text.className = 'msg-text';
      text.textContent = msg.text;
      bubble.appendChild(text);

      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.innerHTML = `
        <span>${timeLabel(msg.created_at)}</span>
        ${msg.edited ? '<span class="edited">ред.</span>' : ''}
        ${msg.is_me ? `<span class="check">${msg.my_read ? '✓✓' : '✓'}</span>` : ''}`;
      bubble.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      const replyBtn = document.createElement('button');
      replyBtn.textContent = 'Ответить';
      replyBtn.onclick = () => { replyTarget = msg; updateComposerHint(); };
      actions.appendChild(replyBtn);
      if (msg.is_me) {
        const editBtn = document.createElement('button');
        editBtn.textContent = 'Изменить';
        editBtn.onclick = () => startEdit(msg);
        actions.appendChild(editBtn);
        const delBtn = document.createElement('button');
        delBtn.textContent = 'Удалить';
        delBtn.onclick = () => deleteMessage(msg);
        actions.appendChild(delBtn);
      }
      bubble.appendChild(actions);
    }

    wrap.appendChild(bubble);
    return wrap;
  }

  function removeMessage(chatId, messageId) {
    const arr = messagesCache.get(chatId);
    if (!arr) return;
    const idx = arr.findIndex((m) => m.id === messageId);
    if (idx >= 0) arr.splice(idx, 1);
    if (chatId === activeChatId) renderActiveMessages();
    const chat = chats.find((c) => c.id === chatId);
    if (chat && chat.last_message && chat.last_message.id === messageId) {
      chat.last_message = null;
      renderChatList();
    }
  }

  function updateReadMarks(chatId, userId, messageId) {
    const arr = messagesCache.get(chatId);
    if (!arr) return;
    for (const m of arr) {
      if (m.sender_id === userId && m.id <= messageId) m.my_read = m.id <= messageId;
    }
    if (chatId === activeChatId) renderActiveMessages();
  }

  // ---------- chat interactions ----------
  async function loadChats() {
    const data = await api('/api/chats');
    chats = data.chats;
    renderChatList();
    if (activeChatId && !chats.find((c) => c.id === activeChatId)) activeChatId = null;
    if (activeChatId) openChat(chats.find((c) => c.id === activeChatId), true);
  }

  async function openChat(chat, keepMessages = false) {
    activeChatId = chat.id;
    replyTarget = null;
    $('#empty-state').hidden = true;
    $('#chat-view').hidden = false;
    $('#chat-area').classList.add('mobile-open');

    const nameEl = $('#chat-name');
    const avatarEl = $('#chat-avatar');
    nameEl.textContent = chatTitle(chat);
    renderAvatar(avatarEl, { id: chat.id, first_name: chatTitle(chat), username: chatTitle(chat), avatar: chat.avatar }, 40);
    $('#chat-status').textContent = chat.type === 'private' ? ' ' : (chat.type === 'group' ? 'группа' : 'канал');

    if (!keepMessages || !messagesCache.has(chat.id)) {
      const data = await api(`/api/chats/${chat.id}/messages`);
      messagesCache.set(chat.id, data.messages);
      chat.last_message = data.chat.last_message;
      chat.unread = data.chat.unread;
    }
    renderActiveMessages();
    renderChatList();
    scrollToBottom();
    const lastMsg = (messagesCache.get(chat.id) || []).at(-1);
    if (lastMsg && !lastMsg.is_me) sendRead(lastMsg);
    $('#message-input').focus();
  }

  function sendRead(msg) {
    api(`/api/chats/${msg.chat_id}/read`, { method: 'POST', body: { message_id: msg.id } }).catch(() => {});
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'read', chat_id: msg.chat_id, message_id: msg.id }));
    }
    const chat = chats.find((c) => c.id === msg.chat_id);
    if (chat) chat.unread = 0;
    renderChatList();
  }

  async function sendMessage() {
    const input = $('#message-input');
    const text = input.value.trim();
    if (!text || !activeChatId) return;
    const body = { text };
    if (replyTarget && replyTarget.chat_id === activeChatId) body.reply_to = replyTarget.id;
    input.value = '';
    replyTarget = null;
    updateComposerHint();
    autoResize(input);
    try {
      const data = await api(`/api/chats/${activeChatId}/messages`, { method: 'POST', body });
      appendMessage(data.message);
      const chat = chats.find((c) => c.id === activeChatId);
      if (chat) { chat.last_message = data.message; chat.unread = 0; }
      chats.sort((a, b) => {
        const ma = a.last_message ? a.last_message.id : 0;
        const mb = b.last_message ? b.last_message.id : 0;
        return mb - ma;
      });
      renderChatList();
    } catch (e) {
      input.value = text;
      alert(e.message);
    }
  }

  function sendTyping() {
    if (!activeChatId || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'typing', chat_id: activeChatId }));
  }

  function setTyping(chatId, userId, userName) {
    let state = typingTimers.get(chatId);
    if (!state) {
      state = { userIds: new Set(), timer: null };
      typingTimers.set(chatId, state);
    }
    state.userIds.add(userId);
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.userIds.clear();
      refreshTypingUI(chatId);
    }, 3500);
    refreshTypingUI(chatId);
  }

  function refreshTypingUI(chatId) {
    const state = typingTimers.get(chatId);
    const typing = state && state.userIds.size > 0;
    if (chatId === activeChatId) {
      $('#chat-status').textContent = typing
        ? `${[...state.userIds].map((u) => u).join(', ')} печатает…`
        : (chats.find((c) => c.id === chatId)?.type === 'private' ? ' ' : '');
    }
  }

  function startEdit(msg) {
    const input = $('#message-input');
    input.value = msg.text;
    input.focus();
    input.dataset.editId = msg.id;
    updateComposerHint();
    autoResize(input);
  }

  async function applyEdit() {
    const input = $('#message-input');
    const msgId = Number(input.dataset.editId);
    if (!msgId) return;
    const text = input.value.trim();
    if (!text) return;
    try {
      const data = await api(`/api/messages/${msgId}/edit`, { method: 'POST', body: { text } });
      appendMessage(data.message);
    } catch (e) {
      alert(e.message);
    }
    input.value = '';
    delete input.dataset.editId;
    updateComposerHint();
    autoResize(input);
  }

  async function deleteMessage(msg) {
    if (!confirm('Удалить сообщение?')) return;
    try {
      await api(`/api/messages/${msg.id}/delete`, { method: 'POST' });
    } catch (e) {
      alert(e.message);
    }
  }

  function updateComposerHint() {
    const input = $('#message-input');
    const editId = input.dataset.editId;
    const hint = editId
      ? `Редактирование #${editId} — Enter сохранить, Esc отмена`
      : (replyTarget ? `Ответ: ${replyTarget.sender_name}` : '');
    let el = $('#composer-hint');
    if (!el && hint) {
      el = document.createElement('div');
      el.id = 'composer-hint';
      el.style.cssText = 'padding:6px 16px 0; background:var(--bg-panel); font-size:12px; color:var(--accent);';
      $('#chat-view').insertBefore(el, $('#chat-view').querySelector('.composer'));
    }
    if (el) {
      el.textContent = hint;
      el.style.display = hint ? 'block' : 'none';
    }
    const sendBtn = $('#send-btn');
    const editing = !!editId;
    sendBtn.textContent = editing ? '✓' : '➤';
    sendBtn.style.background = editing ? 'var(--accent)' : '';
  }

  // ---------- new chat modal ----------
  async function openNewChatModal() {
    selectedUserIds.clear();
    $('#modal-title').textContent = 'Новое сообщение';
    $('#modal-create').hidden = true;
    $('#user-search-input').value = '';
    const data = await api('/api/users');
    renderUserResults(data.users);
    $('#modal-overlay').hidden = false;
    $('#user-search-input').focus();
  }

  function renderUserResults(users) {
    const box = $('#user-results');
    box.innerHTML = '';
    for (const u of users) {
      const el = document.createElement('div');
      el.className = 'user-result' + (selectedUserIds.has(u.id) ? ' selected' : '');
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      renderAvatar(avatar, u, 38);
      const name = document.createElement('span');
      name.textContent = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `user ${u.id}`;
      if (u.username) name.textContent += ` (${u.username})`;
      el.appendChild(avatar);
      el.appendChild(name);
      el.onclick = () => {
        if (selectedUserIds.has(u.id)) selectedUserIds.delete(u.id);
        else selectedUserIds.add(u.id);
        renderUserResults(users);
        $('#modal-create').hidden = selectedUserIds.size === 0;
      };
      box.appendChild(el);
    }
  }

  async function createChat() {
    if (!selectedUserIds.size) return;
    const users = [...selectedUserIds];
    try {
      const data = await api('/api/chats', { method: 'POST', body: { type: 'private', user_ids: users } });
      $('#modal-overlay').hidden = true;
      await loadChats();
      openChat(data.chat);
    } catch (e) {
      alert(e.message);
    }
  }

  async function leaveChat() {
    if (!activeChatId) return;
    if (!confirm('Выйти из этого чата?')) return;
    try {
      await api(`/api/chats/${activeChatId}/leave`, { method: 'POST' });
      activeChatId = null;
      messagesCache.delete(activeChatId);
      $('#chat-view').hidden = true;
      $('#empty-state').hidden = false;
      $('#chat-area').classList.remove('mobile-open');
      await loadChats();
    } catch (e) {
      alert(e.message);
    }
  }

  // ---------- auth ----------
  function showApp() {
    $('#auth-screen').hidden = true;
    $('#app-screen').hidden = false;
    $('#me-name').textContent = [me.first_name, me.last_name].filter(Boolean).join(' ') || me.username;
    renderAvatar($('#me-avatar'), me, 40);
    connectSocket();
    loadChats().catch((e) => { if (e.status === 401) logout(); });
  }

  function logout() {
    token = null;
    me = null;
    localStorage.removeItem('ng_token');
    localStorage.removeItem('ng_me');
    $('#app-screen').hidden = true;
    $('#auth-screen').hidden = false;
    window.location.reload();
  }

  // ---------- init / events ----------
  function autoResize(t) {
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 150) + 'px';
  }

  function initEmojiPalette() {
    const pal = $('#emoji-palette');
    EMOJIS.forEach((e) => {
      const b = document.createElement('button');
      b.textContent = e;
      b.onclick = () => {
        const input = $('#message-input');
        input.value += e;
        input.focus();
        autoResize(input);
      };
      pal.appendChild(b);
    });
  }

  function init() {
    // tabs
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.onclick = () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        const isLogin = tab.dataset.tab === 'login';
        $('#login-form').hidden = !isLogin;
        $('#register-form').hidden = isLogin;
        $('#auth-error').hidden = true;
      };
    });

    $('#login-form').onsubmit = async (e) => {
      e.preventDefault();
      const form = e.target;
      try {
        const data = await api('/api/auth/login', { method: 'POST', body: {
          login: form.login.value.trim(),
          password: form.password.value,
        }});
        token = data.token;
        me = data.user;
        localStorage.setItem('ng_token', token);
        localStorage.setItem('ng_me', JSON.stringify(me));
        showApp();
      } catch (err) {
        showAuthError(err.message);
      }
    };

    $('#register-form').onsubmit = async (e) => {
      e.preventDefault();
      const form = e.target;
      try {
        const data = await api('/api/auth/register', { method: 'POST', body: {
          phone: form.phone.value.trim(),
          first_name: form.first_name.value.trim(),
          last_name: form.last_name.value.trim(),
          username: form.username.value.trim(),
          password: form.password.value,
        }});
        token = data.token;
        me = data.user;
        localStorage.setItem('ng_token', token);
        localStorage.setItem('ng_me', JSON.stringify(me));
        showApp();
      } catch (err) {
        showAuthError(err.message);
      }
    };

    $('#send-btn').onclick = () => {
      const editing = $('#message-input').dataset.editId;
      if (editing) applyEdit();
      else sendMessage();
    };
    $('#message-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const editing = e.target.dataset.editId;
        if (editing) applyEdit();
        else sendMessage();
      } else if (e.key === 'Escape') {
        if (e.target.dataset.editId) {
          delete e.target.dataset.editId;
          e.target.value = '';
          updateComposerHint();
          autoResize(e.target);
        } else if (replyTarget) {
          replyTarget = null;
          updateComposerHint();
        }
      }
    });
    $('#message-input').addEventListener('input', (e) => {
      autoResize(e.target);
      sendTyping();
    });

    $('#new-chat-btn').onclick = openNewChatModal;
    $('#modal-cancel').onclick = () => { $('#modal-overlay').hidden = true; };
    $('#modal-create').onclick = createChat;
    $('#modal-overlay').onclick = (e) => { if (e.target.id === 'modal-overlay') e.target.hidden = true; };
    $('#user-search-input').addEventListener('input', async (e) => {
      const q = e.target.value.trim();
      const data = await api('/api/users?q=' + encodeURIComponent(q));
      renderUserResults(data.users);
    });

    $('#emoji-btn').onclick = (e) => {
      const pal = $('#emoji-palette');
      pal.hidden = !pal.hidden;
      e.stopPropagation();
    };
    document.addEventListener('click', () => { $('#emoji-palette').hidden = true; });

    $('#leave-chat-btn').onclick = leaveChat;
    $('#profile-btn').onclick = () => logout();

    $('#search-input').addEventListener('input', renderChatList);
    $('#search-users-btn').onclick = openNewChatModal;

    initEmojiPalette();

    if (token && me) {
      showApp();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();