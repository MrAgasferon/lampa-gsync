/*!
 * GSync — синхронизация Lampa / ByLampa через Google Таблицу пользователя
 * Авторизация: OAuth 2.0 Device Flow (google.com/device), scope drive.file
 * Каждый пользователь — своя таблица на своём Google Диске.
 * Версия 0.2.0
 */
(function () {
  'use strict';
  if (window.__gsync_loaded) return;
  window.__gsync_loaded = true;

  /* ============================================================
   * Конфигурация
   * ============================================================ */
  var CFG = {
    CLIENT_ID: '535155307066-9fe6e9hc0gp0gkmkd22uomtt8surte2j.apps.googleusercontent.com',
    CLIENT_SECRET: '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',
    SCOPE: 'openid email https://www.googleapis.com/auth/drive.file',
    FILE_NAME: 'Lampa Sync',
    APP_PROP: 'lampa_gsync',
    SCHEMA: 1,
    DEBOUNCE_MS: 8000,
    PERIODIC_MS: 5 * 60 * 1000,
    CELL_LIMIT: 45000,                       // лимит ячейки Sheets — 50 000 символов
    TOMBSTONE_TTL_MS: 30 * 24 * 3600 * 1000, // tombstones старше 30 дней удаляются при сжатии
    COMPACT_MIN_ROWS: 500,
    APPEND_BATCH: 2000,
    LOCK_MS: 2 * 60 * 1000,                  // блокировка сжатия считается брошенной через 2 минуты
    CLOCK_MIN_SKEW_MS: 5 * 60 * 1000,        // меньшие расхождения часов не корректируются
    TOUCH_TTL_MS: 60 * 24 * 3600 * 1000,
    QR_LIB: 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'
  };

  var URL_DEVICE = 'https://oauth2.googleapis.com/device/code';
  var URL_TOKEN = 'https://oauth2.googleapis.com/token';
  var URL_REVOKE = 'https://oauth2.googleapis.com/revoke';
  var SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
  var DRIVE = 'https://www.googleapis.com/drive/v3/files';

  /* ------------------------------------------------------------
   * Классификация ключей localStorage
   * ------------------------------------------------------------ */
  // Никогда не синхронизируются и не попадают в снимки. Переопределить нельзя.
  var HARD_DENY = [/^gsync_/, /token/i, /password/i, /secret/i, /^account/, /^cub_/, /^lampa_uid$/];

  // Привязаны к устройству / служебные. По умолчанию локальные, можно переопределить в «Исключениях».
  var DEFAULT_DENY = [
    /^player/, /^torrserver_url/, /^torrserver_login/, /^interface_size$/, /keyboard/i,
    /^proxy/, /^device/, /cache/i, /^activity$/, /^platform/, /^app_/, /^notice/,
    /^recomends/, /^timeline/, /^screen/, /^navigation_type$/, /^start_time$/
  ];

  // Распределение «прочих» ключей по группам настроек
  var SOURCE_RE = /^(source|parser|jackett|prowlarr|torrserver|torrent|online_|balanser|tmdb|kp_|kinopoisk|filmix|rezka|alloha|collaps|videocdn|lampac|iptv)/i;
  var UI_RE = /^(interface|language|background|animation|glass|card|menu|start_page|screensaver|light_version|black_style|font|scale|mask|theme|poster|subtitles|video_quality|hide_|show_|time_offset|helper|advanced)/i;

  var DEFAULT_GROUPS = {
    bookmarks: true, progress: true, views: true, search: false,
    settings_ui: true, settings_sources: true, plugins: true, plugin_settings: true
  };

  /* ============================================================
   * Утилиты
   * ============================================================ */
  function lsGet(k, def) {
    var v = localStorage.getItem(k);
    if (v === null) return def;
    try { return JSON.parse(v); } catch (e) { return v; }
  }
  function lsSet(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
  function writeKey(k, obj) { localStorage.setItem(k, JSON.stringify(obj)); }
  function safeParse(s) { try { return JSON.parse(s); } catch (e) { return s; } }
  function allKeys() { var a = []; for (var i = 0; i < localStorage.length; i++) a.push(localStorage.key(i)); return a; }
  function keysMatching(fn) { return allKeys().filter(fn); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function num(x) { return typeof x === 'number' ? x : ''; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function msg(e) { return (e && e.message) || String(e); }
  function hash(s) { var h = 5381, i = s.length; while (i) h = (h * 33) ^ s.charCodeAt(--i); return (h >>> 0).toString(36) + ':' + s.length; }
  function noty(t) { try { Lampa.Noty.show(t); } catch (e) { console.log('[gsync]', t); } }
  function fmtDate(t) { var d = new Date(Number(t)); function p(n) { return n < 10 ? '0' + n : n; } return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  function backToSettings() { try { Lampa.Controller.toggle('settings_component'); } catch (e) {} }

  function boolSetting(name, def) { var v = localStorage.getItem(name); return v === null ? def : (v === 'true' || v === true); }
  function mode() { return localStorage.getItem('gsync_mode') || 'auto'; }        // auto | start | manual
  function direction() { return localStorage.getItem('gsync_dir') || 'both'; }    // both | push | pull
  function groupEnabled(id) { return boolSetting('gsync_g_' + id, DEFAULT_GROUPS[id]); }
  function overrides() { return lsGet('gsync_overrides', {}) || {}; }
  function deviceName() { return localStorage.getItem('gsync_device') || 'device'; }
  function defaultDeviceName() {
    var p = 'device';
    try { if (Lampa.Platform && Lampa.Platform.get) p = Lampa.Platform.get() || p; } catch (e) {}
    return p + '-' + Math.random().toString(36).slice(2, 6);
  }

  function log(text) {
    var a = lsGet('gsync_log', []) || [];
    a.push({ t: Date.now(), m: text });
    lsSet('gsync_log', a.slice(-30));
  }

  function authError(text) { var e = new Error(text); e.auth = true; return e; }
  var SESSION = Math.random().toString(36).slice(2, 8);

  /* ---------- Время: поправка часов устройства по серверу Google ---------- */
  var clockOffset = Number(lsGet('gsync_clock', 0)) || 0, clockKnown = false;
  function now() { return Date.now() + clockOffset; }
  function setClock(serverMs, localMs) {
    if (!isFinite(serverMs) || !isFinite(localMs)) return;
    var o = serverMs - localMs;
    if (Math.abs(o) > 365 * 24 * 3600 * 1000) return;
    if (Math.abs(o) < CFG.CLOCK_MIN_SKEW_MS) o = 0;
    if (o !== clockOffset) log('Поправка часов устройства: ' + Math.round(o / 1000) + ' с');
    clockOffset = o; clockKnown = true;
    lsSet('gsync_clock', o);
  }

  /* ---------- Журнал изменений ключей (время правки, а не время синхронизации) ---------- */
  function touch(k) { var m = lsGet('gsync_touch', {}) || {}; m[k] = now(); lsSet('gsync_touch', m); }
  function pruneTouches() {
    var m = lsGet('gsync_touch', {}) || {}, T = now();
    Object.keys(m).forEach(function (k) { if (T - m[k] > CFG.TOUCH_TTL_MS) delete m[k]; });
    lsSet('gsync_touch', m);
  }

  /* ---------- CUB ---------- */
  var CUB_GROUPS = ['bookmarks', 'progress'];
  function cubActive() {
    var a = lsGet('account', null);
    return !!(a && typeof a === 'object' && a.token) && boolSetting('account_use', true);
  }
  function cubYield() { return boolSetting('gsync_cub_yield', true) && cubActive(); }

  /* ============================================================
   * Группы синхронизации (один лист на группу)
   * ============================================================ */
  function isHardDenied(k) { return HARD_DENY.some(function (r) { return r.test(k); }); }
  function isDefaultDenied(k) { return DEFAULT_DENY.some(function (r) { return r.test(k); }); }
  function isLocalOnly(k) {
    if (isHardDenied(k)) return true;
    var o = overrides()[k];
    if (o === 'deny') return true;
    if (o === 'allow') return false;
    return isDefaultDenied(k);
  }
  function claimedByCollection(k) {
    return GROUPS.some(function (g) { return g.kind === 'col' && g.claim(k); });
  }
  function kvCategory(k) {
    if (isHardDenied(k) || claimedByCollection(k)) return null;
    if (SOURCE_RE.test(k)) return 'settings_sources';
    if (UI_RE.test(k)) return 'settings_ui';
    return 'plugin_settings';
  }

  // Закладки: favorite = { card:[...], book:[id], like:[id], wath:[id], history:[id], ... }
  var bookmarksGroup = {
    id: 'bookmarks', sheet: 'bookmarks', kind: 'col', order: 'desc', cached: true,
    title: 'Закладки и история', descr: 'favorite: закладки, «позже», история',
    header: ['item_id', 'list', 'card_id', 'type', 'title', 'json', 'updated_at', 'deleted', 'device'],
    claim: function (k) { return k === 'favorite'; },
    keyOf: function () { return 'favorite'; },
    read: function () {
      var fav = lsGet('favorite', {}) || {}, cards = {}, out = [];
      (fav.card || []).forEach(function (c) { if (c && c.id !== undefined) cards[c.id] = c; });
      Object.keys(fav).forEach(function (list) {
        if (list === 'card' || !Array.isArray(fav[list])) return;
        fav[list].forEach(function (id, i) {
          var c = cards[id];
          out.push([list + ':' + id, {
            v: JSON.stringify(c || { id: id }), i: i,
            cols: [list, String(id), c ? (c.name || c.original_name ? 'tv' : 'movie') : '', c ? (c.title || c.name || '') : '']
          }]);
        });
      });
      return out;
    },
    write: function (entries) {
      var fav = lsGet('favorite', {}) || {}, cards = {};
      Object.keys(fav).forEach(function (l) { if (l !== 'card' && Array.isArray(fav[l])) fav[l] = []; });
      entries.forEach(function (e) {
        var p = e.id.indexOf(':'), list = e.id.slice(0, p), c = safeParse(e.v) || {};
        var cid = c.id !== undefined ? c.id : e.id.slice(p + 1);
        (fav[list] = fav[list] || []).push(cid);
        if (!cards[cid] || Object.keys(c).length > 1) cards[cid] = c;
      });
      fav.card = Object.keys(cards).map(function (k) { return cards[k]; });
      writeKey('favorite', fav);
    }
  };

  // Универсальный адаптер для ключей-контейнеров (массив или объект)
  function containerGroup(def) {
    var g = {
      kind: 'col', order: null, cached: false,
      header: ['item_id', 'storage_key', 'item', 'json', 'updated_at', 'deleted', 'device'],
      cols: function (k, sub, x) { return [k, x !== null && typeof x === 'object' ? (x.name || x.url || sub) : String(x).slice(0, 200)]; },
      keyOf: function (id) { return id.slice(0, id.indexOf('|')); },
      read: function () {
        var out = [];
        keysMatching(g.claim).forEach(function (k) {
          var c = lsGet(k, null);
          if (Array.isArray(c)) {
            c.forEach(function (x, i) {
              var s = JSON.stringify(x);
              var sub = (x !== null && typeof x === 'object') ? (x.url || hash(s)) : String(x);
              out.push([k + '|a|' + sub, { v: s, i: i, cols: g.cols(k, sub, x) }]);
            });
          } else if (c && typeof c === 'object') {
            Object.keys(c).forEach(function (p) {
              out.push([k + '|o|' + p, { v: JSON.stringify(c[p]), cols: g.cols(k, p, c[p]) }]);
            });
          }
        });
        return out;
      },
      write: function (entries) {
        var by = {};
        keysMatching(g.claim).forEach(function (k) {
          var c = lsGet(k, null);
          by[k] = Array.isArray(c) ? [] : (c && typeof c === 'object') ? {} : null;
        });
        entries.forEach(function (e) {
          var m = e.id.match(/^(.*?)\|([ao])\|(.*)$/);
          if (!m) return;
          var k = m[1], t = m[2], sub = m[3], val = safeParse(e.v);
          if (by[k] == null) by[k] = t === 'a' ? [] : {};
          if (t === 'a' && Array.isArray(by[k])) by[k].push(val);
          else if (t === 'o' && !Array.isArray(by[k])) by[k][sub] = val;
        });
        Object.keys(by).forEach(function (k) { if (by[k] !== null) writeKey(k, by[k]); });
      }
    };
    Object.keys(def).forEach(function (k) { g[k] = def[k]; });
    return g;
  }

  // Ключ-значение (настройки), last-write-wins по ключу
  function kvGroup(id, title, descr) {
    return {
      id: id, sheet: id, kind: 'kv', order: null, cached: false, title: title, descr: descr,
      header: ['key', 'value', 'updated_at', 'deleted', 'device'],
      claim: function () { return false; },
      keyOf: function (id) { return id; },
      read: function () {
        return allKeys()
          .filter(function (k) { return kvCategory(k) === id && !isLocalOnly(k); })
          .map(function (k) { return [k, { v: localStorage.getItem(k), cols: [] }]; });
      },
      write: function (entries, removed) {
        entries.forEach(function (e) { if (localStorage.getItem(e.id) !== e.v) localStorage.setItem(e.id, e.v); });
        (removed || []).forEach(function (k) { if (kvCategory(k) === id && !isLocalOnly(k)) localStorage.removeItem(k); });
      }
    };
  }

  var GROUPS = [
    bookmarksGroup,
    containerGroup({
      id: 'progress', sheet: 'progress', title: 'Прогресс просмотра', descr: 'file_view: таймкоды и проценты',
      header: ['item_id', 'storage_key', 'hash', 'percent', 'time', 'duration', 'json', 'updated_at', 'deleted', 'device'],
      claim: function (k) { return /^file_view(_.+)?$/.test(k); },
      cols: function (k, sub, x) { x = x || {}; return [k, sub, num(x.percent), num(x.time), num(x.duration)]; }
    }),
    containerGroup({
      id: 'views', sheet: 'views', title: 'Отметки просмотренного', descr: 'online_view, torrents_view',
      claim: function (k) { return k === 'online_view' || k === 'torrents_view'; }
    }),
    containerGroup({
      id: 'search', sheet: 'search', order: 'desc', title: 'История поиска', descr: 'search_history',
      claim: function (k) { return k === 'search_history'; }
    }),
    kvGroup('settings_ui', 'Настройки интерфейса', 'Язык, оформление, вид карточек'),
    kvGroup('settings_sources', 'Источники и парсеры', 'Источник по умолчанию, парсеры, балансеры'),
    containerGroup({
      id: 'plugins', sheet: 'plugins', order: 'asc', cached: true, title: 'Список плагинов',
      descr: 'Установленные плагины. Новые с других устройств — с выбором галочками',
      claim: function (k) { return k === 'plugins'; },
      confirm: true,                                                          // добавления/удаления — через диалог
      skip: function () { return lsGet('gsync_plugins_declined', {}) || {}; } // отклонённые на этом устройстве
    }),
    kvGroup('plugin_settings', 'Настройки плагинов', 'Всё остальное, кроме исключений')
  ];
  var GROUP_BY_ID = {};
  GROUPS.forEach(function (g) { GROUP_BY_ID[g.id] = g; });

  /* ============================================================
   * Авторизация: OAuth 2.0 Device Flow
   * ============================================================ */
  function auth() { return lsGet('gsync_auth', null); }
  function isLoggedIn() { var a = auth(); return !!(a && a.refresh_token); }

  function formPost(url, data) {
    var body = Object.keys(data).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(data[k]); }).join('&');
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body })
      .then(function (r) { return r.text().then(function (t) { var j = {}; try { j = t ? JSON.parse(t) : {}; } catch (e) {} return { status: r.status, json: j }; }); });
  }

  function decodeJwt(t) {
    try {
      var p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (p.length % 4) p += '=';
      return JSON.parse(decodeURIComponent(escape(atob(p))));
    } catch (e) { return {}; }
  }

  function saveAuth(j) {
    var old = auth() || {};
    lsSet('gsync_auth', {
      access_token: j.access_token,
      expires_at: Date.now() + (j.expires_in || 3600) * 1000,
      refresh_token: j.refresh_token || old.refresh_token,
      email: j.id_token ? (decodeJwt(j.id_token).email || old.email) : old.email
    });
  }

  async function accessToken() {
    var a = auth();
    if (!a || !a.refresh_token) throw authError('не выполнен вход в Google');
    if (a.access_token && Date.now() < a.expires_at - 60000) return a.access_token;
    var r = await formPost(URL_TOKEN, {
      client_id: CFG.CLIENT_ID, client_secret: CFG.CLIENT_SECRET,
      refresh_token: a.refresh_token, grant_type: 'refresh_token'
    });
    if (r.status === 200 && r.json.access_token) { saveAuth(r.json); return r.json.access_token; }
    if (r.json.error === 'invalid_grant') { localStorage.removeItem('gsync_auth'); throw authError('доступ к Google отозван или истёк — войдите заново'); }
    throw new Error('не удалось обновить токен: ' + (r.json.error || r.status));
  }

  function loadQr() {
    if (window.QRCode) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = CFG.QR_LIB; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  async function login() {
    if (CFG.CLIENT_ID.indexOf('PASTE') === 0) return noty('Укажите CLIENT_ID и CLIENT_SECRET в gsync.js');
    var r;
    try { r = await formPost(URL_DEVICE, { client_id: CFG.CLIENT_ID, scope: CFG.SCOPE }); }
    catch (e) { return noty('Нет связи с Google: ' + msg(e) + ' (сеть или CORS)'); }
    if (r.status !== 200) return noty('Google: ' + (r.json.error_description || r.json.error || r.json.error_code || r.status));

    var d = r.json, cancelled = false;
    var html = $(
      '<div style="text-align:center;padding:1em 0">' +
        '<div>На телефоне или компьютере откройте</div>' +
        '<div style="font-size:1.6em;font-weight:600;margin:.4em 0">' + esc(d.verification_url.replace(/^https?:\/\//, '')) + '</div>' +
        '<div>и введите код</div>' +
        '<div style="font-size:2.4em;font-weight:700;letter-spacing:.08em;white-space:nowrap;margin:.3em 0">' + esc(d.user_code) + '</div>' +
        '<div class="gsync-qr" style="display:inline-block;background:#fff;padding:10px;margin-top:.8em"></div>' +
        '<div class="gsync-status" style="margin-top:1em;opacity:.7">Ожидание подтверждения…</div>' +
      '</div>'
    );
    var status = function (t) { html.find('.gsync-status').text(t); };

    Lampa.Modal.open({
      title: 'Вход через Google', html: html, size: 'medium',
      onBack: function () { cancelled = true; Lampa.Modal.close(); backToSettings(); }
    });
    loadQr().then(function () {
      try { new QRCode(html.find('.gsync-qr')[0], { text: d.verification_url, width: 180, height: 180 }); } catch (e) {}
    }).catch(function () { html.find('.gsync-qr').remove(); });

    var interval = (d.interval || 5) * 1000;
    var deadline = Date.now() + (d.expires_in || 1800) * 1000;
    while (!cancelled && Date.now() < deadline) {
      await sleep(interval);
      if (cancelled) return;
      var p;
      try {
        p = await formPost(URL_TOKEN, {
          client_id: CFG.CLIENT_ID, client_secret: CFG.CLIENT_SECRET,
          device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        });
      } catch (e) { continue; }

      if (p.status === 200 && p.json.access_token) {
        if (String(p.json.scope || '').indexOf('/auth/drive.file') < 0) {
          try { await formPost(URL_REVOKE, { token: p.json.refresh_token || p.json.access_token }); } catch (e) {}
          status('Не выдан доступ к Google Диску. Начните вход заново и отметьте пункт про файлы Google Диска.');
          log('Вход отклонён: не выдан scope drive.file');
          return;
        }
        saveAuth(p.json);
        Lampa.Modal.close(); backToSettings();
        noty('Вход выполнен: ' + (auth().email || 'Google'));
        log('Вход: ' + (auth().email || ''));
        authNotified = false;
        try { sessionStorage.removeItem('gsync_reloaded'); } catch (e) {} // чтобы первая синхронизация могла применить закладки
        syncAll({ startup: true });
        return;
      }
      var err = p.json.error;
      if (err === 'authorization_pending') continue;
      if (err === 'slow_down') { interval += 5000; continue; }
      status(err === 'access_denied' ? 'Доступ отклонён' : 'Ошибка: ' + (p.json.error_description || err || p.status));
      return;
    }
    if (!cancelled) status('Код истёк — начните вход заново');
  }

  function resetSyncState() {
    GROUPS.forEach(function (g) {
      localStorage.removeItem('gsync_shadow_' + g.id);
      localStorage.removeItem('gsync_inited_' + g.id);
    });
  }

  async function logout() {
    var a = auth();
    if (a && a.refresh_token) { try { await formPost(URL_REVOKE, { token: a.refresh_token }); } catch (e) {} }
    localStorage.removeItem('gsync_auth');
    localStorage.removeItem('gsync_sheet_id');
    localStorage.removeItem('gsync_cfg_t');
    localStorage.removeItem('gsync_plugins_declined');
    resetSyncState();
    log('Выход из аккаунта');
    noty('Вы вышли из аккаунта Google');
  }

  /* ============================================================
   * Google Sheets / Drive API
   * ============================================================ */
  async function api(method, url, body, attempt) {
    attempt = attempt || 0;
    var tok = await accessToken();
    var headers = { Authorization: 'Bearer ' + tok };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    var res;
    try {
      res = await fetch(url, { method: method, headers: headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (e) {
      if (attempt < 2) { await sleep(1500 * (attempt + 1)); return api(method, url, body, attempt + 1); }
      throw new Error('сеть недоступна');
    }
    if (res.status === 401 && attempt === 0) {
      var a = auth(); if (a) { a.expires_at = 0; lsSet('gsync_auth', a); }
      return api(method, url, body, 1);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(2000 * Math.pow(2, attempt));
      return api(method, url, body, attempt + 1);
    }
    if (!clockKnown && res.headers) {
      var dh = res.headers.get('date');
      if (dh) setClock(Date.parse(dh), Date.now());
    }
    var text = await res.text(), json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) {}
    if (res.status === 403 && /insufficient authentication scopes/i.test(text)) {
      localStorage.removeItem('gsync_auth');
      var se = authError('нет доступа к Google Диску — войдите заново и отметьте пункт про файлы Диска');
      se.status = 403;
      throw se;
    }
    if (!res.ok) {
      var er = new Error((json && json.error && json.error.message) || ('HTTP ' + res.status));
      er.status = res.status;
      throw er;
    }
    return json;
  }

  function valuesUrl(id, range) { return SHEETS + '/' + id + '/values/' + encodeURIComponent(range); }

  async function batchGet(id, ranges) {
    var q = ranges.map(function (r) { return 'ranges=' + encodeURIComponent(r); }).join('&');
    var res = await api('GET', SHEETS + '/' + id + '/values:batchGet?' + q + '&valueRenderOption=UNFORMATTED_VALUE');
    return (res.valueRanges || []).map(function (v) { return v.values || []; });
  }

  async function appendRows(id, sheet, rows) {
    for (var i = 0; i < rows.length; i += CFG.APPEND_BATCH) {
      await api('POST', valuesUrl(id, sheet + '!A1') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
        { values: rows.slice(i, i + CFG.APPEND_BATCH) });
    }
  }

  function putRange(id, range, rows) { return api('PUT', valuesUrl(id, range) + '?valueInputOption=RAW', { values: rows }); }
  function clearRange(id, range) { return api('POST', valuesUrl(id, range) + ':clear', {}); }

  function pad(row, n) { var r = (row || []).slice(0, n); while (r.length < n) r.push(''); return r; }

  // Перезапись без промежуточного пустого листа: сначала новые строки поверх старых, потом очистка хвоста
  async function rewriteSheet(id, sheet, rows, cols, oldCount) {
    if (rows.length) await putRange(id, sheet + '!A2', rows);
    if (oldCount > rows.length) await clearRange(id, sheet + '!A' + (rows.length + 2) + ':' + cols + (oldCount + 1));
  }

  var META_HEADER = ['key', 'value'];
  var SVC_HEADER = ['service', 'value'];
  var SNAP_HEADER = ['snapshot_id', 'chunk_no', 'chunks', 'data', 'created_at', 'device'];
  function headerFor(sheet) {
    if (sheet === '_meta') return META_HEADER;
    if (sheet === 'snapshots') return SNAP_HEADER;
    return GROUP_BY_ID[sheet].header;
  }
  function sheetSpec(title) { return { properties: { title: title, gridProperties: { frozenRowCount: 1 } } }; }

  async function sheetTitles(id) {
    var meta = await api('GET', SHEETS + '/' + id + '?fields=sheets.properties.title');
    return (meta.sheets || []).map(function (s) { return s.properties.title; });
  }

  /* ---------- Служебные ячейки _meta (колонки D:E) ---------- */
  // D2:E2 — блокировка сжатия, D3+:E3+ — горизонт очистки удалений по группам
  function svcRow(key) {
    if (key === 'compact_lock') return 2;
    var g = key.replace(/^purged_/, '');
    return 3 + GROUPS.indexOf(GROUP_BY_ID[g]);
  }
  function writeSvc(id, key, value) {
    var r = svcRow(key);
    return putRange(id, '_meta!D' + r + ':E' + r, [[key, String(value)]]);
  }
  async function readSvc(id) {
    var rows = (await batchGet(id, ['_meta!D2:E']))[0], svc = {};
    rows.forEach(function (r) { if (r[0]) svc[r[0]] = r[1]; });
    return svc;
  }

  /* ---------- Поиск таблицы, дубликаты, корзина ---------- */
  async function findTables() {
    var q = encodeURIComponent("appProperties has { key='" + CFG.APP_PROP + "' and value='1' } and trashed=false");
    var list = await api('GET', DRIVE + '?q=' + q + '&spaces=drive&orderBy=createdTime&fields=files(id,name,createdTime)');
    return list.files || [];
  }

  // Переносит все строки групп и снимков из таблицы-дубликата в основную и отправляет дубликат в корзину
  async function mergeInto(main, dup) {
    var titles = await sheetTitles(dup);
    var sheets = titles.filter(function (t) { return GROUP_BY_ID[t] || t === 'snapshots'; });
    if (sheets.length) {
      var mainSs = { id: main, titles: await sheetTitles(main) };
      await ensureSheets(mainSs, sheets);
      var data = await batchGet(dup, sheets.map(function (t) { return t + '!A2:Z'; }));
      for (var i = 0; i < sheets.length; i++) {
        var n = headerFor(sheets[i]).length;
        var rows = data[i].filter(function (r) { return r[0] !== undefined && r[0] !== ''; }).map(function (r) { return pad(r, n); });
        if (rows.length) await appendRows(main, sheets[i], rows);
      }
    }
    await api('PATCH', DRIVE + '/' + dup + '?fields=id', { trashed: true });
  }

  async function ensureSpreadsheet() {
    var saved = lsGet('gsync_sheet_id', ''), files = await findTables(), id;
    if (files.length) {
      id = files[0].id; // основная — самая старая
      var savedAlive = files.some(function (f) { return f.id === saved; });
      if (saved && saved !== id) {
        if (savedAlive) { await mergeInto(id, saved); log('Своя таблица-дубликат объединена с основной'); }
        else { resetSyncState(); log('Таблица в корзине или удалена — переключение на основную'); }
      }
      for (var i = 1; i < files.length; i++) {
        if (files[i].id === saved) continue;
        await mergeInto(id, files[i].id);
        log('Таблица-дубликат «' + files[i].name + '» объединена с основной');
      }
      lsSet('gsync_sheet_id', id);
      return { id: id, titles: await sheetTitles(id) };
    }
    if (saved) { resetSyncState(); log('Таблица не найдена — создаётся новая'); }
    var created = await api('POST', SHEETS, { properties: { title: CFG.FILE_NAME }, sheets: [sheetSpec('_meta')] });
    id = created.spreadsheetId;
    var props = {}; props[CFG.APP_PROP] = '1';
    await api('PATCH', DRIVE + '/' + id + '?fields=id', { appProperties: props });
    await api('POST', SHEETS + '/' + id + '/values:batchUpdate', {
      valueInputOption: 'RAW',
      data: [{ range: '_meta!A1', values: [META_HEADER] }, { range: '_meta!D1', values: [SVC_HEADER] }]
    });
    lsSet('gsync_sheet_id', id);
    log('Создана таблица «' + CFG.FILE_NAME + '»');
    return { id: id, titles: ['_meta'] };
  }

  async function ensureSheets(ss, needed) {
    var missing = needed.filter(function (t) { return ss.titles.indexOf(t) < 0; });
    if (!missing.length) return;
    var add = function () {
      return api('POST', SHEETS + '/' + ss.id + ':batchUpdate', {
        requests: missing.map(function (t) { return { addSheet: sheetSpec(t) }; })
      });
    };
    try { await add(); }
    catch (e) {
      if (!/already exists/i.test(msg(e))) throw e;
      // лист только что создало другое устройство
      ss.titles = await sheetTitles(ss.id);
      missing = needed.filter(function (t) { return ss.titles.indexOf(t) < 0; });
      if (!missing.length) return;
      await add();
    }
    await api('POST', SHEETS + '/' + ss.id + '/values:batchUpdate', {
      valueInputOption: 'RAW',
      data: missing.map(function (t) { return { range: t + '!A1', values: [headerFor(t)] }; })
    });
    ss.titles = ss.titles.concat(missing);
  }

  /* ---------- Серверное время ---------- */
  // Если в ответах Google нет доступного заголовка Date — один раз за сеанс пишем ячейку и читаем modifiedTime файла
  async function probeClock(id) {
    var t0 = Date.now();
    await putRange(id, '_meta!G1', [[deviceName() + ' ' + t0]]);
    var t1 = Date.now();
    var f = await api('GET', DRIVE + '/' + id + '?fields=modifiedTime');
    setClock(Date.parse(f.modifiedTime), (t0 + t1) / 2);
  }

  /* ============================================================
   * Общая конфигурация (лист _meta, колонки A:B)
   * ============================================================ */
  function sharedCfg() {
    var groups = {};
    GROUPS.forEach(function (g) { groups[g.id] = groupEnabled(g.id); });
    return {
      groups: groups, overrides: overrides(), mode: mode(),
      progress_pause: boolSetting('gsync_progress_pause', true),
      reload: boolSetting('gsync_reload', true)
    };
  }
  function applySharedCfg(c) {
    if (!c || typeof c !== 'object') return;
    if (c.groups) Object.keys(c.groups).forEach(function (id) {
      if (!GROUP_BY_ID[id]) return;
      var was = groupEnabled(id);
      localStorage.setItem('gsync_g_' + id, String(!!c.groups[id]));
      if (was && !c.groups[id]) { localStorage.removeItem('gsync_shadow_' + id); localStorage.removeItem('gsync_inited_' + id); }
    });
    if (c.overrides) lsSet('gsync_overrides', c.overrides);
    if (c.mode) localStorage.setItem('gsync_mode', c.mode);
    if (c.progress_pause !== undefined) localStorage.setItem('gsync_progress_pause', String(!!c.progress_pause));
    if (c.reload !== undefined) localStorage.setItem('gsync_reload', String(!!c.reload));
    restartTimers();
  }
  function markCfgChanged() { lsSet('gsync_cfg_t', now()); }

  async function writeMeta(id, m, oldCount) {
    var rows = Object.keys(m).map(function (k) { return [k, String(m[k])]; });
    await rewriteSheet(id, '_meta', rows, 'B', oldCount);
  }

  /* ============================================================
   * Синхронизация группы
   * ============================================================ */
  function isDel(x) { return x === 1 || x === true || x === '1' || x === 'TRUE'; }
  function tomb(t) { return { v: null, h: '', t: t, d: true, cols: [], dirty: false }; }

  function reduceRows(g, rows) {
    var H = g.header.length, out = {};
    rows.forEach(function (row) {
      var id = row[0];
      if (id === undefined || id === '') return;
      id = String(id);
      var t = Number(row[H - 3]) || 0, d = isDel(row[H - 2]);
      var v = row[H - 4];
      if (!d && (v === undefined || v === '')) return;
      var cur = out[id];
      if (!cur || t >= cur.t) out[id] = { v: d ? null : String(v), t: t, d: d, cols: row.slice(1, H - 4), raw: row };
    });
    return out;
  }

  function syncGroup(g, rows, ctx) {
    var dir = direction(), T = now(), dev = deviceName();
    var shadowKey = 'gsync_shadow_' + g.id;
    var first = !lsGet('gsync_inited_' + g.id, false);
    var shadow = lsGet(shadowKey, {}) || {};
    var applyRemote = dir !== 'push' && (!g.cached || ctx.canApplyCached);
    var skip = g.skip ? g.skip() : {};
    var purged = ctx.purged[g.id] || 0;
    var touches = lsGet('gsync_touch', {}) || {};
    // Время локального изменения: из журнала изменений ключа, иначе — текущее
    function changedAt(id, after) { var x = touches[g.keyOf(id)]; return x && x > after ? Math.min(x, T) : T; }

    var remote = reduceRows(g, rows);
    Object.keys(skip).forEach(function (id) { delete remote[id]; });
    var local = [], kept = [];
    g.read().forEach(function (p) { (skip[p[0]] ? kept : local).push(p); });
    var n = local.length, state = {}, present = {}, synced = {};

    // 1. Локальные изменения относительно тени (последнего подтверждённого таблицей состояния)
    local.forEach(function (pair, idx) {
      var id = pair[0], e = pair[1];
      if (e.v === null || e.v === undefined) return;
      var i = e.i !== undefined ? e.i : idx;
      var h = hash(e.v), s = shadow[id], t;
      present[id] = true;
      if (!s || s.d) { var base = changedAt(id, s ? s.t : 0); t = g.order === 'asc' ? base - (n - idx) : base - i; }
      else if (s.h !== h) t = changedAt(id, s.t);
      else if (g.order === 'desc' && i === 0 && s.i !== undefined && s.i !== 0) t = changedAt(id, s.t); // поднят наверх списка
      else t = s.t;
      state[id] = { v: e.v, h: h, t: t, d: false, i: i, cols: e.cols || [], dirty: !s || !!s.d || t !== s.t };
    });
    Object.keys(shadow).forEach(function (id) {
      if (present[id] || skip[id]) return;
      var s = shadow[id];
      if (s.d) { if (T - s.t < CFG.TOMBSTONE_TTL_MS) state[id] = tomb(s.t); return; }
      if (g.kind === 'kv' && localStorage.getItem(id) !== null) return; // ключ стал локальным — у других не удаляем
      state[id] = { v: null, h: '', t: changedAt(id, s.t), d: true, cols: [], dirty: true };
    });

    // 2. Мерж с таблицей
    var received = 0, deferred = 0, removed = [], pending = { add: [], del: [] };
    function accept(id, r, l) {
      if (r.d) removed.push(id);
      state[id] = { v: r.v, h: r.d ? '' : hash(r.v), t: r.t, d: r.d, i: l ? l.i : undefined, cols: r.cols || [], dirty: false };
      synced[id] = state[id];
      received++;
    }
    Object.keys(remote).forEach(function (id) {
      if (g.kind === 'kv' && isLocalOnly(id)) return;
      var r = remote[id], l = state[id];
      // При первой синхронизации устройства/группы побеждает таблица — включая удаления
      var remoteWins = !l || first || r.t > l.t;
      if (!remoteWins) {
        if (l.d && r.d) return;
        if (!l.d && !r.d && l.h === hash(r.v)) { l.t = r.t; l.dirty = false; synced[id] = l; return; }
        if (!l.dirty && l.t > r.t) l.dirty = true; // в таблице устаревшая версия (в т.ч. не дошедшее удаление)
        return;
      }
      if (r.d && (!l || l.d)) { state[id] = tomb(Math.max(r.t, l ? l.t : 0)); synced[id] = state[id]; return; }
      if (l && !l.d && !r.d && l.h === hash(r.v)) { l.t = r.t; l.dirty = false; synced[id] = l; return; }
      if (dir === 'push') return;
      if (!applyRemote) { if (l) l.dirty = false; deferred++; return; }
      if (g.confirm) {
        if ((!l || l.d) && !r.d) { pending.add.push({ id: id, v: r.v, t: r.t }); return; }
        if (r.d && l && !l.d) { l.dirty = false; pending.del.push({ id: id, v: l.v, t: r.t }); return; }
      }
      accept(id, r, l);
    });

    // 3. Есть локально, но нет в таблице
    Object.keys(state).forEach(function (id) {
      var l = state[id];
      if (remote[id] || l.d || l.dirty) return;
      var s = shadow[id];
      if (s && !s.d && s.t < purged) {
        // удалён на других устройствах давно, его tombstone уже вычищен сжатием
        if (dir === 'push') return;
        if (!applyRemote) { deferred++; return; }
        if (g.confirm) { pending.del.push({ id: id, v: l.v, t: purged }); return; }
        accept(id, { v: null, t: purged, d: true, cols: [] }, l);
      } else {
        l.dirty = true; // строка потерялась (ручная правка, гонка сжатия) — дозаписать
      }
    });

    // 4. Применить полученное локально
    if (received) {
      var entries = Object.keys(state)
        .filter(function (id) { return !state[id].d; })
        .map(function (id) { return { id: id, v: state[id].v, t: state[id].t }; });
      if (g.order === 'desc') entries.sort(function (a, b) { return b.t - a.t; });
      else if (g.order === 'asc') entries.sort(function (a, b) { return a.t - b.t; });
      kept.forEach(function (p) { entries.push({ id: p[0], v: p[1].v, t: T }); });
      g.write(entries, removed);
      // хеш и позиция — по тому, как значения реально легли в хранилище (иначе нормализация вызовет повторную отправку)
      var fresh = {};
      g.read().forEach(function (p, idx) { fresh[p[0]] = { v: p[1].v, i: p[1].i !== undefined ? p[1].i : idx }; });
      Object.keys(state).forEach(function (id) {
        var x = state[id];
        if (x.d || !fresh[id]) return;
        x.i = fresh[id].i;
        if (synced[id] && fresh[id].v != null) x.h = hash(fresh[id].v);
      });
    }

    // Тень фазы A: то, что уже совпадает с таблицей, фиксируется сразу
    var shadowA = {};
    Object.keys(shadow).forEach(function (id) { if (!skip[id]) shadowA[id] = shadow[id]; });
    Object.keys(synced).forEach(function (id) { var x = synced[id]; shadowA[id] = { h: x.h, t: x.t, d: x.d, i: x.i }; });
    lsSet(shadowKey, shadowA);

    // 5. Строки для отправки
    var out = [], skipped = 0, nCols = g.header.length - 5;
    if (dir !== 'pull') {
      Object.keys(state).forEach(function (id) {
        var l = state[id];
        if (!l.dirty) return;
        if (!l.d && l.v.length > CFG.CELL_LIMIT) { skipped++; return; }
        var cols = (l.cols || []).slice(0, nCols);
        while (cols.length < nCols) cols.push('');
        out.push([id].concat(cols, [l.d ? '' : l.v, l.t, l.d ? 1 : 0, dev]));
      });
    }
    if (skipped) log(g.title + ': пропущено ' + skipped + ' значений больше ' + CFG.CELL_LIMIT + ' символов');

    // Полная тень — фиксируется только после успешной отправки (фаза B)
    var ns = {}, live = 0;
    Object.keys(state).forEach(function (id) {
      var l = state[id];
      ns[id] = { h: l.h, t: l.t, d: l.d, i: l.i };
      if (!l.d) live++;
    });
    function commit(full) {
      if (full) lsSet(shadowKey, ns);
      if (!deferred && (full || dir === 'pull')) lsSet('gsync_inited_' + g.id, true);
    }

    return { rows: out, received: received, deferred: deferred, live: live, pending: pending, commit: commit };
  }

  /* ============================================================
   * Сжатие (с блокировкой между устройствами)
   * ============================================================ */
  async function takeLock(id) {
    var svc = await readSvc(id), cur = String(svc.compact_lock || '').split('|'), me = deviceName() + '#' + SESSION;
    if (cur[0] && cur[0] !== me && now() - Number(cur[1]) < CFG.LOCK_MS) return false;
    await writeSvc(id, 'compact_lock', me + '|' + now());
    await sleep(2000);
    var v = (await batchGet(id, ['_meta!E' + svcRow('compact_lock')]))[0];
    return !!(v[0] && String(v[0][0]).split('|')[0] === me);
  }
  function releaseLock(id) { return writeSvc(id, 'compact_lock', '').catch(function () {}); }

  async function compactGroup(id, g) {
    var rows = (await batchGet(id, [g.sheet + '!A2:Z']))[0];
    var red = reduceRows(g, rows), H = g.header.length, horizon = now() - CFG.TOMBSTONE_TTL_MS;
    var keep = Object.keys(red).map(function (k) { return red[k]; })
      .filter(function (x) { return !(x.d && x.t < horizon); })
      .map(function (x) { return pad(x.raw, H); });
    // сначала горизонт очистки, потом удаление строк: устройства, не видевшие удаление, поймут, что элемент удалён
    await writeSvc(id, 'purged_' + g.id, horizon);
    await rewriteSheet(id, g.sheet, keep, 'Z', rows.length);
    return { before: rows.length, after: keep.length };
  }

  async function maybeCompact(id, results) {
    var todo = results.filter(function (x) { return x.rowCount > Math.max(CFG.COMPACT_MIN_ROWS, x.r.live * 2); });
    if (!todo.length || !(await takeLock(id))) return;
    try { for (var i = 0; i < todo.length; i++) await compactGroup(id, todo[i].g); }
    finally { await releaseLock(id); }
  }

  /* ============================================================
   * Полный цикл синхронизации
   * ============================================================ */
  var busy = null, again = false, authNotified = false, cubNoted = false;

  function syncAll(opts) {
    opts = opts || {};
    if (busy) { again = true; return busy; }
    busy = doSync(opts).catch(function (e) {
      log('Ошибка: ' + msg(e));
      // ошибки авторизации показываем даже в фоне — иначе синхронизация молча остановится
      if (!opts.silent || (e.auth && !authNotified)) {
        noty('Lampa GSync: ' + msg(e));
        if (e.auth) authNotified = true;
      }
    }).then(function () {
      busy = null;
      if (again) { again = false; syncAll({ silent: true }); }
    });
    return busy;
  }

  function reloadedThisSession() { try { return sessionStorage.getItem('gsync_reloaded') === '1'; } catch (e) { return false; } }
  function doReload(text) {
    try { sessionStorage.setItem('gsync_reloaded', '1'); } catch (e) {}
    noty(text);
    setTimeout(function () { location.reload(); }, 1500);
  }

  async function doSync(opts) {
    if (!isLoggedIn()) throw authError('не выполнен вход в Google');
    var ss = await ensureSpreadsheet();
    if (!clockKnown) { try { await probeClock(ss.id); } catch (e) {} clockKnown = true; }

    // Конфигурация
    var metaRows = (await batchGet(ss.id, ['_meta!A2:E']))[0], meta = {}, svc = {};
    metaRows.forEach(function (r) { if (r[0]) meta[r[0]] = r[1]; if (r[3]) svc[r[3]] = r[4]; });
    if (Number(meta.schema_version || 0) > CFG.SCHEMA) throw new Error('таблица от более новой версии плагина — обновите плагин');
    var remoteCfgT = Number(meta.cfg_t || 0), localCfgT = Number(lsGet('gsync_cfg_t', 0)) || 0;
    if (remoteCfgT > localCfgT && meta.cfg) {
      applySharedCfg(safeParse(meta.cfg));
      lsSet('gsync_cfg_t', remoteCfgT);
    } else if (localCfgT > remoteCfgT || !meta.schema_version) {
      var t = localCfgT || now();
      await writeMeta(ss.id, { schema_version: CFG.SCHEMA, cfg: JSON.stringify(sharedCfg()), cfg_t: t, updated_by: deviceName() }, metaRows.length);
      lsSet('gsync_cfg_t', t);
    }

    var cub = cubYield();
    if (cub && !cubNoted) { log('Вход в CUB: закладки и прогресс синхронизирует CUB, GSync их пропускает'); cubNoted = true; }
    var groups = GROUPS.filter(function (g) { return groupEnabled(g.id) && !(cub && CUB_GROUPS.indexOf(g.id) >= 0); });
    if (!groups.length) { log('Нет групп для синхронизации'); return; }
    await ensureSheets(ss, groups.map(function (g) { return g.sheet; }));
    var data = await batchGet(ss.id, groups.map(function (g) { return g.sheet + '!A2:Z'; }));

    var reloaded = reloadedThisSession(), purged = {};
    GROUPS.forEach(function (g) { purged[g.id] = Number(svc['purged_' + g.id]) || 0; });
    var ctx = { startup: !!opts.startup, canApplyCached: !!opts.startup && !reloaded, purged: purged };

    var total = { pushed: 0, received: 0, deferred: 0 }, reloadCached = false, reloadSettings = false, results = [], pending = null;
    groups.forEach(function (g, i) {
      var r = syncGroup(g, data[i], ctx);
      results.push({ g: g, r: r, rowCount: data[i].length + r.rows.length });
      total.pushed += r.rows.length; total.received += r.received; total.deferred += r.deferred;
      if (r.received && g.cached) reloadCached = true;
      if (r.received && g.kind === 'kv') reloadSettings = true;
      if (r.pending.add.length || r.pending.del.length) pending = { g: g, list: r.pending };
    });

    // Отправка; тень группы фиксируется только после успешной записи её строк
    var full = direction() !== 'pull';
    for (var i = 0; i < results.length; i++) {
      if (results[i].r.rows.length) await appendRows(ss.id, results[i].g.sheet, results[i].r.rows);
      results[i].r.commit(full);
    }
    await maybeCompact(ss.id, results);
    pruneTouches();

    lsSet('gsync_last', Date.now());
    log('Синхронизация: отправлено ' + total.pushed + ', получено ' + total.received + (total.deferred ? ', отложено ' + total.deferred : ''));

    // Закладки и плагины Lampa держит в памяти — применённые изменения требуют перезапуска всегда
    var willReload = !!opts.startup && !reloaded && (reloadCached || (reloadSettings && boolSetting('gsync_reload', true)));
    if (pending) return showPluginsDialog(pending.g, pending.list, willReload);
    if (willReload) doReload('Получены изменения с других устройств — перезапуск…');
    else if (total.received) {
      noty('Lampa GSync: получено ' + total.received + (reloadSettings ? '. Часть настроек применится после перезапуска' : ''));
    } else if (total.deferred && !opts.silent) {
      noty('Lampa GSync: изменения закладок/плагинов применятся при следующем запуске');
    } else if (opts.manual) {
      noty('Синхронизировано: отправлено ' + total.pushed);
    }
  }

  /* ============================================================
   * Плагины с других устройств — выбор галочками
   * ============================================================ */
  function pluginLabelOf(v) {
    var o = safeParse(v), url = typeof o === 'string' ? o : ((o && o.url) || '');
    var name = (o && typeof o === 'object' && o.name) || url.split('/').pop().replace(/\?.*$/, '') || url;
    return { name: name, url: url };
  }

  function showPluginsDialog(g, list, willReload) {
    var items = list.add.map(function (x) { return { x: x, kind: 'add', on: true }; })
      .concat(list.del.map(function (x) { return { x: x, kind: 'del', on: true }; }));
    function toContent() { try { Lampa.Controller.toggle('content'); } catch (e) {} }

    function render(focus) {
      var rows = [{ title: 'Применить', subtitle: 'Отмеченное установить/удалить и перезапустить. Неотмеченное больше не предлагать', apply: true }];
      items.forEach(function (it, n) {
        var lb = pluginLabelOf(it.x.v);
        rows.push({
          title: (it.on ? '☑ ' : '☐ ') + (it.kind === 'add' ? 'Установить: ' : 'Удалить: ') + lb.name,
          subtitle: lb.url, n: n, selected: n === focus
        });
      });
      Lampa.Select.show({
        title: 'Плагины с других устройств',
        items: rows,
        onSelect: function (s) {
          if (s.apply) return applyPlugins(g, items, willReload);
          items[s.n].on = !items[s.n].on;
          render(s.n);
        },
        onBack: function () {
          // отложить решение до следующего запуска
          if (willReload) doReload('Получены изменения с других устройств — перезапуск…');
          else toContent();
        }
      });
    }
    render(-1);
  }

  function applyPlugins(g, items, willReload) {
    var add = [], del = {};
    var declined = lsGet('gsync_plugins_declined', {}) || {};
    items.forEach(function (it) {
      if (!it.on) declined[it.x.id] = true;
      else if (it.kind === 'add') add.push(it.x);
      else del[it.x.id] = it.x;
    });
    lsSet('gsync_plugins_declined', declined);

    var entries = g.read().filter(function (p) { return !del[p[0]]; }).map(function (p) { return { id: p[0], v: p[1].v }; });
    add.forEach(function (x) { entries.push({ id: x.id, v: x.v }); });
    g.write(entries, []);

    // Тень: установленное и удалённое теперь совпадает с таблицей
    var shadow = lsGet('gsync_shadow_' + g.id, {}) || {}, fresh = {};
    g.read().forEach(function (p) { fresh[p[0]] = p[1]; });
    add.forEach(function (x) { if (fresh[x.id]) shadow[x.id] = { h: hash(fresh[x.id].v), t: x.t, d: false }; });
    Object.keys(del).forEach(function (id) { shadow[id] = { h: '', t: del[id].t, d: true }; });
    lsSet('gsync_shadow_' + g.id, shadow);

    var changed = add.length + Object.keys(del).length;
    log('Плагины: установлено ' + add.length + ', удалено ' + Object.keys(del).length + ', отклонено ' + items.filter(function (it) { return !it.on; }).length);
    if (changed || willReload) doReload(changed ? 'Плагины обновлены — перезапуск…' : 'Получены изменения с других устройств — перезапуск…');
    else { try { Lampa.Controller.toggle('content'); } catch (e) {} }
  }

  /* ============================================================
   * Снимки (полный бэкап)
   * ============================================================ */
  async function saveSnapshot() {
    if (!isLoggedIn()) return noty('Сначала войдите в аккаунт Google');
    try {
      var ss = await ensureSpreadsheet();
      await ensureSheets(ss, ['snapshots']);
      var dump = {};
      allKeys().forEach(function (k) { if (!isHardDenied(k) && !/cache/i.test(k)) dump[k] = localStorage.getItem(k); });
      var s = JSON.stringify({ v: 1, device: deviceName(), keys: dump }), chunks = [];
      for (var i = 0; i < s.length; i += CFG.CELL_LIMIT) chunks.push(s.slice(i, i + CFG.CELL_LIMIT));
      var now = Date.now(), sid = 'snap-' + now.toString(36);
      await appendRows(ss.id, 'snapshots', chunks.map(function (c, n) { return [sid, n, chunks.length, c, now, deviceName()]; }));
      log('Снимок сохранён: ' + Math.round(s.length / 1024) + ' КБ');
      noty('Снимок сохранён (' + Math.round(s.length / 1024) + ' КБ)');
    } catch (e) { noty('Снимок: ' + msg(e)); log('Снимок: ошибка ' + msg(e)); }
  }

  async function restoreSnapshot() {
    if (!isLoggedIn()) return noty('Сначала войдите в аккаунт Google');
    var rows;
    try {
      var ss = await ensureSpreadsheet();
      if (ss.titles.indexOf('snapshots') < 0) return noty('Снимков пока нет');
      rows = (await batchGet(ss.id, ['snapshots!A2:F']))[0];
    } catch (e) { return noty('Снимки: ' + msg(e)); }

    var snaps = {};
    rows.forEach(function (r) {
      var id = r[0]; if (!id) return;
      var s = snaps[id] = snaps[id] || { id: id, chunks: {}, total: Number(r[2]) || 0, t: Number(r[4]) || 0, device: r[5] || '' };
      s.chunks[Number(r[1])] = String(r[3] || '');
    });
    var list = Object.keys(snaps).map(function (k) { return snaps[k]; }).sort(function (a, b) { return b.t - a.t; });
    if (!list.length) return noty('Снимков пока нет');

    Lampa.Select.show({
      title: 'Восстановить снимок',
      items: list.map(function (s) {
        var ok = Object.keys(s.chunks).length === s.total;
        return { title: fmtDate(s.t) + ' — ' + s.device, subtitle: ok ? (s.total + ' фрагм.') : 'повреждён', snap: s, ghost: !ok };
      }),
      onSelect: function (it) {
        if (it.ghost) return noty('Снимок повреждён');
        Lampa.Select.show({
          title: 'Восстановить снимок от ' + fmtDate(it.snap.t) + '?',
          items: [{ title: 'Восстановить и перезапустить', yes: true }, { title: 'Отмена' }],
          onSelect: function (c) { if (c.yes) applySnapshot(it.snap); else backToSettings(); },
          onBack: backToSettings
        });
      },
      onBack: backToSettings
    });
  }

  function applySnapshot(s) {
    try {
      var data = '';
      for (var i = 0; i < s.total; i++) data += s.chunks[i];
      var obj = JSON.parse(data), same = obj.device === deviceName();
      Object.keys(obj.keys || {}).forEach(function (k) {
        if (isHardDenied(k)) return;
        if (!same && isLocalOnly(k)) return; // привязанное к устройству и твои исключения со снимка чужого устройства не переносим
        localStorage.setItem(k, obj.keys[k]);
        touch(k); // восстановленное считается свежей правкой и уйдёт в таблицу
      });
      // Сброс теней: восстановленное состояние уйдёт в таблицу как новое
      GROUPS.forEach(function (g) { localStorage.removeItem('gsync_shadow_' + g.id); });
      log('Восстановлен снимок от ' + fmtDate(s.t));
      noty('Снимок восстановлен — перезапуск…');
      setTimeout(function () { location.reload(); }, 1200);
    } catch (e) { noty('Не удалось восстановить: ' + msg(e)); }
  }

  async function compactAll() {
    if (!isLoggedIn()) return noty('Сначала войдите в аккаунт Google');
    var ss;
    try {
      ss = await ensureSpreadsheet();
      if (!(await takeLock(ss.id))) return noty('Таблицу сейчас сжимает другое устройство');
      var before = 0, after = 0;
      for (var i = 0; i < GROUPS.length; i++) {
        var g = GROUPS[i];
        if (ss.titles.indexOf(g.sheet) < 0) continue;
        var r = await compactGroup(ss.id, g);
        before += r.before; after += r.after;
      }
      log('Сжатие: ' + before + ' → ' + after + ' строк');
      noty('Таблица сжата: ' + before + ' → ' + after + ' строк');
    } catch (e) { noty('Сжатие: ' + msg(e)); }
    finally { if (ss) await releaseLock(ss.id); }
  }

  /* ============================================================
   * Экраны: аккаунт, исключения, журнал
   * ============================================================ */
  function accountAction() {
    if (!isLoggedIn()) return login();
    Lampa.Select.show({
      title: auth().email || 'Аккаунт Google',
      items: [{ title: 'Синхронизировать сейчас', action: 'sync' }, { title: 'Выйти из аккаунта', action: 'logout' }],
      onSelect: function (it) {
        backToSettings();
        if (it.action === 'sync') syncAll({ manual: true });
        if (it.action === 'logout') logout();
      },
      onBack: backToSettings
    });
  }

  /* ---------- Исключения: группировка и описания ключей ---------- */

  // Описания известных ключей Lampa. Для ключей сторонних плагинов описания нет —
  // показывается сам ключ и текущее значение.
  var KEY_INFO = {
    language: 'Язык интерфейса',
    source: 'Источник каталога по умолчанию',
    start_page: 'Стартовая страница',
    interface_size: 'Размер интерфейса',
    background: 'Фон из постеров',
    background_type: 'Тип фона',
    animation: 'Анимации интерфейса',
    glass_style: 'Эффект стекла',
    mask: 'Затемнение краёв',
    light_version: 'Облегчённая версия интерфейса',
    card_interfice_type: 'Вид карточки фильма',
    screensaver: 'Заставка при бездействии',
    screensaver_type: 'Тип заставки',
    keyboard_type: 'Тип экранной клавиатуры',
    navigation_type: 'Тип навигации (пульт / мышь)',
    player: 'Плеер для онлайн-видео',
    player_torrent: 'Плеер для торрентов',
    player_iptv: 'Плеер для IPTV',
    torrserver_url: 'Адрес TorrServer',
    torrserver_url_two: 'Запасной адрес TorrServer',
    torrserver_use_link: 'Какой адрес TorrServer использовать',
    parser_use: 'Использовать парсер торрентов',
    parser_type: 'Тип парсера (Jackett / Prowlarr)',
    jackett_url: 'Адрес Jackett',
    jackett_key: 'API-ключ Jackett',
    video_quality_default: 'Качество видео по умолчанию',
    subtitles_size: 'Размер субтитров',
    subtitles_stroke: 'Обводка субтитров',
    proxy_tmdb: 'Прокси для TMDB',
    tmdb_lang: 'Язык данных TMDB'
  };

  var SECTION_INFO = {
    device: { title: 'Привязано к устройству', descr: 'Плеер, TorrServer, размер интерфейса, прокси — по умолчанию не синхронизируется' },
    settings_ui: { title: 'Интерфейс', descr: 'Язык, оформление, вид карточек' },
    settings_sources: { title: 'Источники и парсеры', descr: 'Источник каталога, парсеры, балансеры' },
    other: { title: 'Прочее', descr: 'Ключи, которые не удалось отнести к плагину' }
  };

  function keyPrefix(k) { return String(k).split(/[_\-.]/)[0].toLowerCase(); }

  // Пытаемся сопоставить префикс ключа с установленным плагином (по URL или имени)
  function pluginLabel(prefix) {
    var list = lsGet('plugins', []) || [];
    if (!Array.isArray(list) || prefix.length < 3) return '';
    for (var i = 0; i < list.length; i++) {
      var p = list[i] || {}, url = String(p.url || p || '').toLowerCase(), name = String(p.name || '');
      if (url.indexOf(prefix) >= 0 || name.toLowerCase().indexOf(prefix) >= 0) {
        return name || url.split('/').pop().replace(/\?.*$/, '');
      }
    }
    return '';
  }

  function exclusionSections() {
    var keys = allKeys().filter(function (k) { return !isHardDenied(k) && !claimedByCollection(k); }).sort();
    var sec = {}, prefixes = {};
    function add(id, k) { (sec[id] = sec[id] || []).push(k); }

    keys.forEach(function (k) {
      if (isDefaultDenied(k)) return add('device', k);
      var cat = kvCategory(k);
      if (cat === 'settings_ui' || cat === 'settings_sources') return add(cat, k);
      var p = keyPrefix(k);
      (prefixes[p] = prefixes[p] || []).push(k);
    });

    // Ключи плагинов: группа по префиксу, если ключей с ним ≥ 2, иначе — «Прочее»
    Object.keys(prefixes).sort().forEach(function (p) {
      if (prefixes[p].length < 2) return prefixes[p].forEach(function (k) { add('other', k); });
      var label = pluginLabel(p);
      SECTION_INFO['p:' + p] = {
        title: 'Плагин: ' + (label || p),
        descr: label ? 'Ключи с префиксом «' + p + '»' : 'Ключи с префиксом «' + p + '» — плагин не определён'
      };
      sec['p:' + p] = prefixes[p];
    });

    var order = ['device', 'settings_ui', 'settings_sources'];
    Object.keys(sec).forEach(function (id) { if (/^p:/.test(id)) order.push(id); });
    order.push('other');
    return order.filter(function (id) { return sec[id] && sec[id].length; })
      .map(function (id) { return { id: id, keys: sec[id], info: SECTION_INFO[id] }; });
  }

  function valuePreview(k) {
    var v = localStorage.getItem(k);
    if (v === null) return '';
    v = v.replace(/^"|"$/g, '');
    if (v.length > 40) v = v.slice(0, 40) + '…';
    return v === '' ? '(пусто)' : v;
  }

  function setLocal(k, wantLocal) {
    var o = overrides();
    if (wantLocal === isDefaultDenied(k)) delete o[k];
    else o[k] = wantLocal ? 'deny' : 'allow';
    lsSet('gsync_overrides', o);
  }

  function openExclusions(focusId) {
    var sections = exclusionSections();
    if (!sections.length) return noty('Нет ключей для настройки');
    Lampa.Select.show({
      title: 'Исключения',
      items: sections.map(function (s) {
        var loc = s.keys.filter(isLocalOnly).length;
        return {
          title: s.info.title,
          subtitle: s.keys.length + ' кл. · ' + (loc === 0 ? 'все синхронизируются' : loc === s.keys.length ? 'все локально' : loc + ' локально') + ' — ' + s.info.descr,
          section: s, selected: s.id === focusId
        };
      }),
      onSelect: function (it) { openSection(it.section.id); },
      onBack: backToSettings
    });
  }

  function openSection(id, focusKey) {
    var s = exclusionSections().filter(function (x) { return x.id === id; })[0];
    if (!s) return openExclusions();
    var allLocal = s.keys.every(isLocalOnly);
    var items = [{
      title: allLocal ? '✓ Синхронизировать всю группу' : '✗ Оставить всю группу на этом устройстве',
      subtitle: 'Применить ко всем ' + s.keys.length + ' ключам ниже',
      all: true
    }];
    s.keys.forEach(function (k) {
      var loc = isLocalOnly(k), info = KEY_INFO[k];
      items.push({
        title: (loc ? '✗ ' : '✓ ') + (info || k),
        subtitle: (info ? k + ' · ' : '') + 'значение: ' + valuePreview(k) + ' · ' + (loc ? 'только здесь' : 'синхронизируется'),
        key: k, selected: k === focusKey
      });
    });
    Lampa.Select.show({
      title: s.info.title + ' (✗ — только на этом устройстве)',
      items: items,
      onSelect: function (it) {
        if (it.all) s.keys.forEach(function (k) { setLocal(k, !allLocal); });
        else setLocal(it.key, !isLocalOnly(it.key));
        markCfgChanged();
        openSection(id, it.key);
      },
      onBack: function () { openExclusions(id); }
    });
  }

  function openLog() {
    var a = (lsGet('gsync_log', []) || []).slice().reverse();
    if (!a.length) return noty('Журнал пуст');
    Lampa.Select.show({
      title: 'Журнал синхронизации',
      items: a.map(function (x) { return { title: x.m, subtitle: fmtDate(x.t) }; }),
      onSelect: backToSettings,
      onBack: backToSettings
    });
  }

  /* ============================================================
   * Настройки
   * ============================================================ */
  var ICON = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 12a8 8 0 0 1 13.66-5.66L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.66 5.66L4 15.5M4 20v-4.5h4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function addSettings() {
    if (!Lampa.SettingsApi) return;
    var C = 'gsync';
    Lampa.SettingsApi.addComponent({ component: C, name: 'Lampa GSync', icon: ICON });

    function title(name, text) {
      Lampa.SettingsApi.addParam({ component: C, param: { name: 'gsync_title_' + name, type: 'title' }, field: { name: text } });
    }
    function button(name, label, descr, fn, render) {
      Lampa.SettingsApi.addParam({
        component: C, param: { name: name, type: 'button' }, field: { name: label, description: descr || ' ' },
        onChange: fn, onRender: render
      });
    }
    function trigger(name, label, descr, def, fn, render) {
      Lampa.SettingsApi.addParam({
        component: C, param: { name: name, type: 'trigger', default: def }, field: { name: label, description: descr || '' },
        onChange: function () { setTimeout(fn || function () {}, 0); },
        onRender: render
      });
    }
    function select(name, label, values, def, fn) {
      Lampa.SettingsApi.addParam({
        component: C, param: { name: name, type: 'select', values: values, default: def }, field: { name: label },
        onChange: function () { setTimeout(fn || function () {}, 0); }
      });
    }

    title('account', 'Аккаунт');
    button('gsync_account', 'Аккаунт Google', '', accountAction, function (item) {
      var last = lsGet('gsync_last', 0);
      item.find('.settings-param__descr').text(isLoggedIn()
        ? 'Подключено: ' + (auth().email || 'Google') + (last ? ' · синхронизировано ' + fmtDate(last) : '')
        : 'Не подключено — нажмите, чтобы войти');
    });

    title('groups', 'Что синхронизировать');
    GROUPS.forEach(function (g) {
      trigger('gsync_g_' + g.id, g.title, g.descr, DEFAULT_GROUPS[g.id], function () {
        if (!groupEnabled(g.id)) { localStorage.removeItem('gsync_shadow_' + g.id); localStorage.removeItem('gsync_inited_' + g.id); }
        markCfgChanged();
      }, function (item) {
        if (CUB_GROUPS.indexOf(g.id) >= 0 && cubYield()) {
          item.find('.settings-param__descr').text(g.descr + ' · Сейчас пропускается: выполнен вход в CUB');
        }
      });
    });
    trigger('gsync_cub_yield', 'Уступать CUB (для этого устройства)',
      'Если выполнен вход в CUB, закладки и прогресс синхронизирует CUB, а GSync их пропускает — иначе две системы перетирают друг друга', true);

    title('mode', 'Режим');
    select('gsync_mode', 'Когда синхронизировать',
      { auto: 'При запуске и изменениях', start: 'Только при запуске', manual: 'Вручную' }, 'auto',
      function () { markCfgChanged(); restartTimers(); });
    select('gsync_dir', 'Направление (для этого устройства)',
      { both: 'В обе стороны', push: 'Только отправлять', pull: 'Только получать' }, 'both');
    trigger('gsync_progress_pause', 'Прогресс — только на паузе и выходе', 'Не отправлять таймкоды во время просмотра', true, markCfgChanged);
    trigger('gsync_reload', 'Перезапуск после получения изменений', 'При запуске, если пришли закладки, плагины или настройки', true, markCfgChanged);

    title('actions', 'Действия');
    button('gsync_now', 'Синхронизировать сейчас', '', function () {
      if (!isLoggedIn()) return noty('Сначала войдите в аккаунт Google');
      syncAll({ manual: true });
    });
    button('gsync_snap_save', 'Сохранить снимок', 'Полная копия состояния Lampa', saveSnapshot);
    button('gsync_snap_restore', 'Восстановить из снимка', '', restoreSnapshot);
    button('gsync_compact', 'Сжать таблицу', 'Убрать устаревшие версии строк', compactAll);

    title('advanced', 'Расширенные');
    Lampa.SettingsApi.addParam({
      component: C, param: { name: 'gsync_device', type: 'input', values: '', placeholder: 'Например: tv-living', default: '' },
      field: { name: 'Имя устройства', description: 'Пишется в колонку device' }
    });
    button('gsync_exclusions', 'Исключения', 'Какие настройки остаются только на этом устройстве', function () { openExclusions(); });
    button('gsync_log', 'Журнал', 'Последние синхронизации и ошибки', openLog);
    button('gsync_declined_reset', 'Отклонённые плагины', '', function () {
      var n = Object.keys(lsGet('gsync_plugins_declined', {}) || {}).length;
      if (!n) return noty('Отклонённых плагинов нет');
      localStorage.removeItem('gsync_plugins_declined');
      log('Сброшен список отклонённых плагинов (' + n + ')');
      noty('Сброшено: ' + n + '. Плагины будут предложены снова при следующем запуске');
    }, function (item) {
      var n = Object.keys(lsGet('gsync_plugins_declined', {}) || {}).length;
      item.find('.settings-param__descr').text(n ? 'Не ставить на этом устройстве: ' + n + '. Нажмите, чтобы сбросить' : 'Нет отклонённых');
    });
  }

  /* ============================================================
   * Триггеры синхронизации
   * ============================================================ */
  var debounceTimer = null, periodicTimer = null;

  function schedule(ms) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () { syncAll({ silent: true }); }, ms);
  }

  function restartTimers() {
    clearInterval(periodicTimer);
    if (mode() === 'auto') periodicTimer = setInterval(function () { if (isLoggedIn()) syncAll({ silent: true }); }, CFG.PERIODIC_MS);
  }

  function relevantKey(k) {
    if (isHardDenied(k)) return false;
    for (var i = 0; i < GROUPS.length; i++) {
      var g = GROUPS[i];
      if (g.kind === 'col' && g.claim(k)) return groupEnabled(g.id);
    }
    var cat = kvCategory(k);
    return !!cat && groupEnabled(cat) && !isLocalOnly(k);
  }

  function bindListeners() {
    if (Lampa.Storage && Lampa.Storage.listener) {
      Lampa.Storage.listener.follow('change', function (e) {
        if (!e || !e.name || /^gsync_/.test(e.name) || !relevantKey(e.name)) return;
        touch(e.name); // время правки — для честного разрешения конфликтов
        if (!isLoggedIn() || mode() !== 'auto') return;
        if (/^file_view/.test(e.name) && boolSetting('gsync_progress_pause', true)) return;
        schedule(CFG.DEBOUNCE_MS);
      });
    }
    try {
      Lampa.Player.listener.follow('destroy', function () { if (isLoggedIn() && mode() === 'auto') schedule(1500); });
    } catch (e) {}
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && isLoggedIn() && mode() === 'auto') schedule(2000);
    });
  }

  /* ============================================================
   * Запуск
   * ============================================================ */
  function start() {
    if (!localStorage.getItem('gsync_device')) localStorage.setItem('gsync_device', defaultDeviceName());
    addSettings();
    bindListeners();
    restartTimers();
    if (isLoggedIn() && mode() !== 'manual') setTimeout(function () { syncAll({ startup: true, silent: true }); }, 1500);
  }

  if (window.appready) start();
  else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') start(); });
})();
