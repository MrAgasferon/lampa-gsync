/*!
 * GSync — синхронизация Lampa / ByLampa через Google Таблицу пользователя
 * Авторизация: OAuth 2.0 Device Flow (google.com/device), scope drive.file
 * Каждый пользователь — своя таблица на своём Google Диске.
 * Версия 0.3.4
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
    SCHEMA: 2,                               // 2: колонка sig в листе plugins
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
    /^recomends/, /^timeline/, /^timetable$/, /^screen/, /^navigation_type$/, /^start_time$/
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
  // Ссылка плагина для сравнения: без схемы, слэша на конце, параметров кэша; домен — без учёта регистра
  function normUrl(u) {
    u = String(u || '').trim().replace(/^https?:\/\//i, '').replace(/#.*$/, '');
    var q = u.indexOf('?'), path = q < 0 ? u : u.slice(0, q), query = q < 0 ? '' : u.slice(q + 1);
    var slash = path.indexOf('/');
    path = (slash < 0 ? path.toLowerCase() : path.slice(0, slash).toLowerCase() + path.slice(slash)).replace(/\/+$/, '');
    query = query.split('&').filter(function (kv) { return kv && !/^(v|ver|version|_|t|nocache|cache)=/i.test(kv); }).join('&');
    return path + (query ? '?' + query : '');
  }
  function pluginNorm(v) {
    var o = safeParse(v);
    return normUrl(typeof o === 'string' ? o : (o && o.url) || '');
  }
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

  /* ---------- Другие синхронизации: CUB и серверная синхронизация Lampac (ByLampa) ---------- */
  // Плагины синхронизации Lampac ставят признаки при запуске — только если сервер их подгрузил
  function lampacSync() {
    var full = !!window.sync_init && !window.sync_disable; // sync.js: закладки, таймкоды, отметки
    var g = [];
    if (full || window.lampacBookmarkSyncInitialized) g.push('bookmarks');
    if (full || window.lampac_timecode_plugin) g.push('progress');
    if (full) g.push('views');
    return g;
  }
  // Какие группы и кому уступлены на этом устройстве: { bookmarks: 'CUB', progress: 'ByLampa', ... }
  function yielded() {
    var out = {};
    if (!boolSetting('gsync_cub_yield', true)) return out;
    lampacSync().forEach(function (id) { out[id] = 'ByLampa'; });
    if (cubActive()) CUB_GROUPS.forEach(function (id) { out[id] = out[id] ? out[id] + ', CUB' : 'CUB'; });
    return out;
  }
  function yieldedText(y) {
    var by = {};
    Object.keys(y).forEach(function (id) { (by[y[id]] = by[y[id]] || []).push(GROUP_BY_ID[id].title.toLowerCase()); });
    return Object.keys(by).map(function (who) { return by[who].join(', ') + ' — ' + who; }).join('; ');
  }

  /* ============================================================
   * Криптография: SHA-256 / HMAC / PBKDF2 на чистом JS
   * (crypto.subtle недоступен на http-страницах, например http://lampa.mx)
   * ============================================================ */
  var Crypto = (function () {
    var K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    var IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var W = new Array(64);

    function compress(H, b, off) {
      var i, a, bb, c, d, e, f, g, h, s0, s1, t1, t2;
      for (i = 0; i < 16; i++) W[i] = (b[off + i * 4] << 24) | (b[off + i * 4 + 1] << 16) | (b[off + i * 4 + 2] << 8) | b[off + i * 4 + 3];
      for (i = 16; i < 64; i++) {
        s0 = ((W[i - 15] >>> 7) | (W[i - 15] << 25)) ^ ((W[i - 15] >>> 18) | (W[i - 15] << 14)) ^ (W[i - 15] >>> 3);
        s1 = ((W[i - 2] >>> 17) | (W[i - 2] << 15)) ^ ((W[i - 2] >>> 19) | (W[i - 2] << 13)) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      a = H[0]; bb = H[1]; c = H[2]; d = H[3]; e = H[4]; f = H[5]; g = H[6]; h = H[7];
      for (i = 0; i < 64; i++) {
        s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        t1 = (h + s1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
        s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        t2 = (s0 + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }

    // Хеш сообщения msg (массив байт), продолжая состояние init, уже обработавшее prefixLen байт (кратно 64)
    function digest(msg, init, prefixLen) {
      var H = (init || IV).slice(), total = (prefixLen || 0) + msg.length;
      var padLen = ((msg.length + 9 + 63) >> 6) << 6, b = new Array(padLen), i;
      for (i = 0; i < msg.length; i++) b[i] = msg[i];
      b[msg.length] = 0x80;
      for (i = msg.length + 1; i < padLen; i++) b[i] = 0;
      var bits = total * 8;
      b[padLen - 4] = (bits >>> 24) & 255; b[padLen - 3] = (bits >>> 16) & 255; b[padLen - 2] = (bits >>> 8) & 255; b[padLen - 1] = bits & 255;
      b[padLen - 5] = Math.floor(bits / 4294967296) & 255;
      for (i = 0; i < padLen; i += 64) compress(H, b, i);
      var out = new Array(32);
      for (i = 0; i < 8; i++) { out[i * 4] = (H[i] >>> 24) & 255; out[i * 4 + 1] = (H[i] >>> 16) & 255; out[i * 4 + 2] = (H[i] >>> 8) & 255; out[i * 4 + 3] = H[i] & 255; }
      return out;
    }

    function utf8(s) {
      var out = [], i, c;
      s = unescape(encodeURIComponent(String(s)));
      for (i = 0; i < s.length; i++) { c = s.charCodeAt(i); out.push(c); }
      return out;
    }
    function hex(b) { var s = '', i; for (i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16); return s; }
    function unhex(s) { var b = [], i; for (i = 0; i < s.length; i += 2) b.push(parseInt(s.substr(i, 2), 16)); return b; }

    // Состояния после блоков key^ipad и key^opad — HMAC без повторного хеширования ключа
    function hmacState(key) {
      if (key.length > 64) key = digest(key);
      var ip = new Array(64), op = new Array(64), i;
      for (i = 0; i < 64; i++) { var k = i < key.length ? key[i] : 0; ip[i] = k ^ 0x36; op[i] = k ^ 0x5c; }
      var Hi = IV.slice(), Ho = IV.slice();
      compress(Hi, ip, 0); compress(Ho, op, 0);
      return { i: Hi, o: Ho };
    }
    function hmacWith(st, msg) { return digest(digest(msg, st.i, 64), st.o, 64); }
    function hmac(key, msg) { return hmacWith(hmacState(key), msg); }

    function pbkdf2(pass, salt, iter, len) {
      var st = hmacState(pass), out = [], block = 1;
      while (out.length < len) {
        var u = hmacWith(st, salt.concat([(block >>> 24) & 255, (block >>> 16) & 255, (block >>> 8) & 255, block & 255]));
        var t = u.slice();
        for (var n = 1; n < iter; n++) { u = hmacWith(st, u); for (var j = 0; j < 32; j++) t[j] ^= u[j]; }
        out = out.concat(t); block++;
      }
      return out.slice(0, len);
    }

    return { sha256: digest, hmac: hmac, pbkdf2: pbkdf2, utf8: utf8, hex: hex, unhex: unhex };
  })();

  /* ---------- Ключ синхронизации: подпись строк листа plugins ---------- */
  var KEY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // без 0/O, 1/I/L
  var KEY_SALT = 'lampa-gsync-v1', KEY_ITER = 20000, KEY_MIN = 12;
  var keyStatus = '';  // '' | 'ok' | 'mismatch' | 'need' — результат последней синхронизации

  function normKey(s) { return String(s || '').replace(/[\s\-]/g, '').toUpperCase(); }
  function fmtKey(s) { return /^[0-9A-Z]{16}$/.test(s) ? s.replace(/(.{4})(?=.)/g, '$1-') : s; }
  function genKey() {
    var out = '', b = new Uint8Array(1);
    while (out.length < 16) {
      try { crypto.getRandomValues(b); } catch (e) { b[0] = Math.floor(Math.random() * 256); }
      if (b[0] < 248) out += KEY_ALPHABET[b[0] % 31]; // отбрасываем хвост — без перекоса распределения
    }
    return out;
  }
  function deriveKey(phrase) { return Crypto.pbkdf2(Crypto.utf8(normKey(phrase)), Crypto.utf8(KEY_SALT), KEY_ITER, 32); }
  function syncKey() { var k = localStorage.getItem('gsync_key'); return k ? Crypto.unhex(k) : null; }
  function keyCheck(key) { return Crypto.hex(Crypto.hmac(key, Crypto.utf8('gsync-key-check'))).slice(0, 32); }
  function rowSig(key, id, v, t, d) {
    return Crypto.hex(Crypto.hmac(key, Crypto.utf8([id, d ? '' : v, Number(t) || 0, d ? 1 : 0].join('\n')))).slice(0, 32);
  }

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
      id: 'progress', sheet: 'progress', cached: true, // Lampa держит прогресс в памяти — применять только при запуске
      title: 'Прогресс просмотра', descr: 'file_view: таймкоды и проценты',
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
      header: ['item_id', 'storage_key', 'item', 'sig', 'json', 'updated_at', 'deleted', 'device'],
      signed: true,                                                           // строки подписываются ключом синхронизации
      descr: 'Установленные плагины. Новые с других устройств — с выбором галочками',
      claim: function (k) { return k === 'plugins'; },
      confirm: true,                                                          // добавления/удаления — через диалог
      norm: pluginNorm,                                                       // сравнение ссылок без мелочей — защита от дублей
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
        JUST_RELOADED = false; // чтобы первая синхронизация могла применить закладки и прогресс
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
    if (key === 'key_check') return 4 + GROUPS.length;
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
      groups: groups, overrides: overrides(),
      snap_keep: snapKeep()
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
    // mode / progress_pause / reload — с версии 0.3.4 настройки устройства, из таблицы не применяются
    if (c.snap_keep !== undefined) localStorage.setItem('gsync_snap_keep', String(Number(c.snap_keep) || 0));
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

    // Подпись: строки без верной подписи ключом синхронизации игнорируются
    var rejected = {}, badSig = 0, unsigned = 0, sigCol = g.signed ? g.header.indexOf('sig') : -1;
    if (g.signed && ctx.key) {
      var HH = g.header.length;
      rows = rows.filter(function (r) {
        if (r[0] === undefined || r[0] === '') return false;
        var d = isDel(r[HH - 2]), v = r[HH - 4] === undefined ? '' : String(r[HH - 4]);
        var ok = !!r[sigCol] && String(r[sigCol]) === rowSig(ctx.key, String(r[0]), v, r[HH - 3], d);
        if (!ok) { rejected[String(r[0])] = true; if (r[sigCol]) badSig++; else unsigned++; }
        return ok;
      });
    }
    var remote = reduceRows(g, rows);
    Object.keys(skip).forEach(function (id) { delete remote[id]; });
    var local = [], kept = [], localNorms = {};
    g.read().forEach(function (p) {
      (skip[p[0]] ? kept : local).push(p);
      if (g.norm && p[1].v != null) localNorms[g.norm(p[1].v)] = p[0];
    });
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
        if ((!l || l.d) && !r.d) {
          var twin = g.norm && localNorms[g.norm(r.v)];
          if (twin && twin !== id) return; // уже стоит под чуть другой ссылкой — не предлагать
          pending.add.push({ id: id, v: r.v, t: r.t });
          return;
        }
        if (r.d && l && !l.d) { l.dirty = false; pending.del.push({ id: id, v: l.v, t: r.t }); return; }
      }
      accept(id, r, l);
    });

    // 3. Есть локально, но нет в таблице
    Object.keys(state).forEach(function (id) {
      var l = state[id];
      if (remote[id] || l.d || l.dirty) return;
      var s = shadow[id];
      if (s && !s.d && s.t < purged && !rejected[id]) {
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
        if (sigCol > 0 && ctx.key) cols[sigCol - 1] = rowSig(ctx.key, id, l.v, l.t, l.d);
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

    if (badSig || unsigned) log(g.title + ': проигнорировано строк — с неверной подписью ' + badSig + ', без подписи ' + unsigned);
    return { rows: out, received: received, deferred: deferred, live: live, pending: pending, commit: commit, badSig: badSig };
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
   * Миграции схемы таблицы
   * ============================================================ */
  async function migrate(ss, from) {
    if (from < 2 && ss.titles.indexOf('plugins') >= 0) {
      var rows = (await batchGet(ss.id, ['plugins!A1:Z']))[0];
      if (rows.length && rows[0][3] === 'json') {
        var H = GROUP_BY_ID.plugins.header;
        var out = rows.map(function (r, i) {
          return i === 0 ? H.slice() : pad([r[0], r[1], r[2], ''].concat(r.slice(3, 7)), H.length);
        });
        await putRange(ss.id, 'plugins!A1', out);
        log('Лист plugins переведён на схему 2 (колонка sig)');
      }
    }
  }

  /* ============================================================
   * Полный цикл синхронизации
   * ============================================================ */
  var busy = null, again = false, authNotified = false, yieldNoted = '', keyNoted = false, badSigNoted = false;

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

  // Метка одноразовая: «перезапущен» только тот запуск, который вызван перезапуском плагина.
  // sessionStorage переживает F5, поэтому метку читаем и сразу удаляем при загрузке.
  var JUST_RELOADED = (function () {
    try {
      var at = Number(sessionStorage.getItem('gsync_reload_at')) || 0;
      sessionStorage.removeItem('gsync_reload_at');
      sessionStorage.removeItem('gsync_reloaded'); // метка версии 0.2.0
      return !!at && Date.now() - at < 2 * 60 * 1000;
    } catch (e) { return false; }
  })();
  function reloadedThisSession() { return JUST_RELOADED; }
  function doReload(text) {
    try { sessionStorage.setItem('gsync_reload_at', String(Date.now())); } catch (e) {}
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
    var needMeta = false;
    if (remoteCfgT > localCfgT && meta.cfg) {
      applySharedCfg(safeParse(meta.cfg));
      lsSet('gsync_cfg_t', remoteCfgT);
    } else if (localCfgT > remoteCfgT || !meta.schema_version) needMeta = true;
    if (Number(meta.schema_version || 0) < CFG.SCHEMA) { await migrate(ss, Number(meta.schema_version || 0)); needMeta = true; }
    if (needMeta) {
      var t = Number(lsGet('gsync_cfg_t', 0)) || now();
      await writeMeta(ss.id, { schema_version: CFG.SCHEMA, cfg: JSON.stringify(sharedCfg()), cfg_t: t, updated_by: deviceName() }, metaRows.length);
      lsSet('gsync_cfg_t', t);
    }

    // Ключ синхронизации: проверка совпадения с таблицей
    var key = syncKey(), skipPlugins = false;
    if (key) {
      var kc = keyCheck(key);
      if (!svc.key_check) { await writeSvc(ss.id, 'key_check', kc); keyStatus = 'ok'; log('Ключ синхронизации заведён в таблице'); }
      else if (svc.key_check !== kc) { keyStatus = 'mismatch'; skipPlugins = true; }
      else keyStatus = 'ok';
    } else if (svc.key_check) { keyStatus = 'need'; skipPlugins = true; }
    else keyStatus = '';
    if (skipPlugins && groupEnabled('plugins') && !keyNoted) {
      keyNoted = true;
      var km = keyStatus === 'need'
        ? 'В таблице включена защита ключом — введите ключ синхронизации, иначе плагины на этом устройстве не синхронизируются'
        : 'Ключ синхронизации не совпадает с таблицей — плагины на этом устройстве не синхронизируются';
      log(km); noty('Lampa GSync: ' + km);
    }

    var yl = yielded(), ylText = yieldedText(yl);
    if (ylText && ylText !== yieldNoted) { log('Уступлено другим синхронизациям: ' + ylText); yieldNoted = ylText; }
    var groups = GROUPS.filter(function (g) {
      return groupEnabled(g.id) && !yl[g.id] && !(skipPlugins && g.signed);
    });
    if (!groups.length) { log('Нет групп для синхронизации'); return; }
    await ensureSheets(ss, groups.map(function (g) { return g.sheet; }));
    var data = await batchGet(ss.id, groups.map(function (g) { return g.sheet + '!A2:Z'; }));

    var reloaded = reloadedThisSession(), purged = {};
    GROUPS.forEach(function (g) { purged[g.id] = Number(svc['purged_' + g.id]) || 0; });
    var ctx = { startup: !!opts.startup, canApplyCached: !!opts.startup && !reloaded, purged: purged, key: key };

    var total = { pushed: 0, received: 0, deferred: 0 }, reloadCached = false, reloadSettings = false, results = [], pending = null;
    groups.forEach(function (g, i) {
      var r = syncGroup(g, data[i], ctx);
      results.push({ g: g, r: r, rowCount: data[i].length + r.rows.length });
      total.pushed += r.rows.length; total.received += r.received; total.deferred += r.deferred;
      if (r.received && g.cached) reloadCached = true;
      if (r.received && g.kind === 'kv') reloadSettings = true;
      if (r.pending.add.length || r.pending.del.length) pending = { g: g, list: r.pending };
      if (r.badSig && !badSigNoted) {
        badSigNoted = true;
        noty('⚠ Lampa GSync: в листе ' + g.sheet + ' ' + r.badSig + ' строк с неверной подписью — проигнорированы. Возможна попытка подмены');
      }
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
    var have = {};
    entries.forEach(function (e) { have[g.norm ? g.norm(e.v) : e.id] = true; });
    add = add.filter(function (x) {
      var k = g.norm ? g.norm(x.v) : x.id;
      if (have[k]) return false; // такой плагин уже есть в списке
      have[k] = true;
      return true;
    });
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
      var pruned = await pruneSnapshots(ss);
      noty('Снимок сохранён (' + Math.round(s.length / 1024) + ' КБ)' + (pruned ? '. Удалено старых: ' + pruned : ''));
    } catch (e) { noty('Снимок: ' + msg(e)); log('Снимок: ошибка ' + msg(e)); }
  }

  /* ---------- Список, удаление и автоочистка снимков ---------- */
  function snapKeep() { return Number(localStorage.getItem('gsync_snap_keep') || 0) || 0; } // 0 — хранить все

  function parseSnaps(rows) {
    var snaps = {};
    rows.forEach(function (r) {
      var id = r[0]; if (!id) return;
      var s = snaps[id] = snaps[id] || { id: id, chunks: {}, total: Number(r[2]) || 0, t: Number(r[4]) || 0, device: r[5] || '', size: 0 };
      var c = String(r[3] || '');
      s.chunks[Number(r[1])] = c;
      s.size += c.length;
    });
    return Object.keys(snaps).map(function (k) {
      var x = snaps[k]; x.ok = Object.keys(x.chunks).length === x.total; return x;
    }).sort(function (a, b) { return b.t - a.t; });
  }

  async function loadSnaps() {
    var ss = await ensureSpreadsheet();
    if (ss.titles.indexOf('snapshots') < 0) return { ss: ss, list: [] };
    return { ss: ss, list: parseSnaps((await batchGet(ss.id, ['snapshots!A2:F']))[0]) };
  }

  // Удаляет снимки по id. Лист перечитывается под блокировкой: снимок, сохранённый другим устройством в этот момент, не пропадёт
  async function deleteSnaps(ss, ids) {
    if (!(await takeLock(ss.id))) throw new Error('таблицей сейчас занято другое устройство — попробуйте через минуту');
    try {
      var rows = (await batchGet(ss.id, ['snapshots!A2:F']))[0];
      var keep = rows.filter(function (r) { return r[0] && !ids[r[0]]; }).map(function (r) { return pad(r, SNAP_HEADER.length); });
      await rewriteSheet(ss.id, 'snapshots', keep, 'F', rows.length);
    } finally { await releaseLock(ss.id); }
  }

  async function pruneSnapshots(ss) {
    var n = snapKeep();
    if (!n) return 0;
    var list = parseSnaps((await batchGet(ss.id, ['snapshots!A2:F']))[0]);
    if (list.length <= n) return 0;
    var ids = {};
    list.slice(n).forEach(function (x) { ids[x.id] = true; });
    await deleteSnaps(ss, ids);
    log('Автоочистка снимков: удалено ' + Object.keys(ids).length + ', осталось ' + n);
    return Object.keys(ids).length;
  }

  async function manageSnapshots() {
    if (!isLoggedIn()) return noty('Сначала войдите в аккаунт Google');
    var data;
    try { data = await loadSnaps(); } catch (e) { return noty('Снимки: ' + msg(e)); }
    if (!data.list.length) return noty('Снимков пока нет');
    var marked = {};

    function render(focus) {
      var n = Object.keys(marked).length;
      var items = [{
        title: 'Удалить отмеченные (' + n + ')',
        subtitle: n ? 'Отмеченные снимки будут удалены из таблицы без возможности восстановления' : 'Отметьте снимки ниже',
        del: true
      }];
      data.list.forEach(function (x, i) {
        items.push({
          title: (marked[x.id] ? '☑ ' : '☐ ') + fmtDate(x.t) + ' — ' + x.device,
          subtitle: Math.round(x.size / 1024) + ' КБ' + (x.ok ? '' : ' · повреждён') + (i === 0 ? ' · последний' : ''),
          snap: x, selected: x.id === focus
        });
      });
      Lampa.Select.show({
        title: 'Снимки: ' + data.list.length,
        items: items,
        onSelect: function (it) {
          if (it.del) {
            if (!n) return render();
            return Lampa.Select.show({
              title: 'Удалить снимков: ' + n + '?',
              items: [{ title: 'Да, удалить', yes: true }, { title: 'Отмена' }],
              onSelect: async function (c) {
                if (!c.yes) return render();
                backToSettings();
                try {
                  await deleteSnaps(data.ss, marked);
                  log('Удалено снимков: ' + n);
                  noty('Удалено снимков: ' + n);
                } catch (e) { noty('Снимки: ' + msg(e)); }
              },
              onBack: function () { render(); }
            });
          }
          if (marked[it.snap.id]) delete marked[it.snap.id]; else marked[it.snap.id] = true;
          render(it.snap.id);
        },
        onBack: backToSettings
      });
    }
    render();
  }

  async function restoreSnapshot() {
    if (!isLoggedIn()) return noty('Сначала войдите в аккаунт Google');
    var list;
    try { list = (await loadSnaps()).list; } catch (e) { return noty('Снимки: ' + msg(e)); }
    if (!list.length) return noty('Снимков пока нет');

    Lampa.Select.show({
      title: 'Восстановить снимок',
      items: list.map(function (s) {
        return { title: fmtDate(s.t) + ' — ' + s.device, subtitle: s.ok ? Math.round(s.size / 1024) + ' КБ' : 'повреждён', snap: s, ghost: !s.ok };
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

  /* ============================================================
   * Перезапись таблицы данными этого устройства
   * mirror — остальные устройства становятся как это (лишнее у них удаляется)
   * merge  — остальные добавляют своё, при конфликте побеждает это устройство
   * ============================================================ */
  async function resetTable(mode) {
    if (!isLoggedIn()) return noty('Сначала войдите в аккаунт Google');
    if (busy) { try { await busy; } catch (e) {} }
    var ss, locked = false, done = false;
    try {
      ss = await ensureSpreadsheet();
      var svc = await readSvc(ss.id), key = syncKey(), yl = yielded();
      var keyBlocks = !!svc.key_check && (!key || keyCheck(key) !== svc.key_check);
      // только группы, которые это устройство само заполнит заново
      var groups = GROUPS.filter(function (g) {
        return groupEnabled(g.id) && !yl[g.id] && !(keyBlocks && g.signed);
      });
      if (!groups.length) return noty('Нет групп для перезаписи');
      if (!(await takeLock(ss.id))) return noty('Таблицей сейчас занято другое устройство — попробуйте через минуту');
      locked = true;
      var T = now();
      // сначала горизонт (для «эталона»), потом очистка: параллельная синхронизация других устройств не вернёт старое
      if (mode === 'mirror') for (var i = 0; i < groups.length; i++) await writeSvc(ss.id, 'purged_' + groups[i].id, T);
      for (var j = 0; j < groups.length; j++) {
        if (ss.titles.indexOf(groups[j].sheet) >= 0) await clearRange(ss.id, groups[j].sheet + '!A2:Z');
      }
      // Локально всё текущее состояние уходит в таблицу как свежая правка
      var touches = lsGet('gsync_touch', {}) || {};
      groups.forEach(function (g) {
        localStorage.removeItem('gsync_shadow_' + g.id);
        lsSet('gsync_inited_' + g.id, true);
        g.read().forEach(function (p) { delete touches[g.keyOf(p[0])]; });
      });
      lsSet('gsync_touch', touches);
      var skipped = GROUPS.filter(function (g) { return groupEnabled(g.id) && groups.indexOf(g) < 0; }).map(function (g) { return g.title; });
      log('Таблица перезаписана с этого устройства (' + (mode === 'mirror' ? 'эталон' : 'слияние') + ')' + (skipped.length ? '; не тронуты: ' + skipped.join(', ') : ''));
      done = true;
    } catch (e) { noty('Перезапись: ' + msg(e)); }
    finally { if (locked) await releaseLock(ss.id); }
    if (done) await syncAll({ manual: true });
  }

  function resetMenu() {
    if (!isLoggedIn()) return noty('Сначала войдите в аккаунт Google');
    Lampa.Select.show({
      title: 'Перезаписать таблицу данными этого устройства',
      items: [
        { title: 'Эталон', subtitle: 'Остальные устройства станут как это: лишние закладки, таймкоды и настройки на них удалятся', mode: 'mirror' },
        { title: 'Слияние', subtitle: 'При конфликтах побеждает это устройство, но остальные вернут в таблицу то, чего здесь нет', mode: 'merge' },
        { title: 'Отмена' }
      ],
      onSelect: function (it) {
        if (!it.mode) return backToSettings();
        Lampa.Select.show({
          title: 'Очистить таблицу и записать данные этого устройства (' + it.title.toLowerCase() + ')?',
          items: [{ title: 'Да, перезаписать', yes: true }, { title: 'Отмена' }],
          onSelect: function (c) { backToSettings(); if (c.yes) resetTable(it.mode); },
          onBack: backToSettings
        });
      },
      onBack: backToSettings
    });
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
   * Ключ синхронизации: создание, ввод, просмотр
   * ============================================================ */
  async function tableKeyCheck() {
    var ss = await ensureSpreadsheet();
    return { id: ss.id, check: (await readSvc(ss.id)).key_check || '' };
  }

  function saveKey(phrase, key) {
    localStorage.setItem('gsync_key', Crypto.hex(key));
    localStorage.setItem('gsync_key_phrase', phrase);
    keyNoted = false; badSigNoted = false;
  }

  function askText(title, done) {
    try {
      if (Lampa.Input && Lampa.Input.edit) return Lampa.Input.edit({ title: title, value: '', free: true, nosave: true }, function (v) { done(v); });
    } catch (e) {}
    done(window.prompt ? window.prompt(title) : '');
  }

  function showKey(phrase, intro) {
    var html = $(
      '<div style="text-align:center;padding:1em 0">' +
        (intro ? '<div style="margin-bottom:.6em">' + esc(intro) + '</div>' : '') +
        '<div style="font-size:2.2em;font-weight:700;letter-spacing:.06em;white-space:nowrap;margin:.3em 0">' + esc(fmtKey(phrase)) + '</div>' +
        '<div style="opacity:.7;margin-top:.8em">Введите этот ключ на остальных устройствах: Lampa GSync → Безопасность → Ключ синхронизации.<br>' +
        'Храните его как пароль. Без ключа подделать плагин в таблице нельзя.</div>' +
      '</div>'
    );
    Lampa.Modal.open({ title: 'Ключ синхронизации', html: html, size: 'medium', onBack: function () { Lampa.Modal.close(); backToSettings(); } });
  }

  async function createKey() {
    if (!isLoggedIn()) return noty('Сначала войдите в аккаунт Google');
    try {
      var tk = await tableKeyCheck();
      var go = async function () {
        var phrase = genKey();
        noty('Создание ключа…');
        await sleep(50);
        var key = deriveKey(phrase);
        await writeSvc(tk.id, 'key_check', keyCheck(key));
        saveKey(phrase, key);
        log('Создан новый ключ синхронизации');
        showKey(phrase, 'Ключ создан. Запишите его:');
        syncAll({ silent: true }); // переподписать свои плагины
      };
      if (!tk.check) return go();
      Lampa.Select.show({
        title: 'В таблице уже есть ключ',
        items: [
          { title: 'Ввести существующий ключ', enter: true },
          { title: 'Создать новый', subtitle: 'Старый перестанет действовать — на всех устройствах придётся ввести новый' }
        ],
        onSelect: function (it) { if (it.enter) enterKey(); else go(); },
        onBack: backToSettings
      });
    } catch (e) { noty('Ключ: ' + msg(e)); }
  }

  function enterKey() {
    if (!isLoggedIn()) return noty('Сначала войдите в аккаунт Google');
    askText('Ключ синхронизации', async function (raw) {
      var phrase = normKey(raw);
      if (!phrase) return backToSettings();
      if (phrase.length < KEY_MIN) { noty('Ключ слишком короткий: нужно не меньше ' + KEY_MIN + ' символов'); return backToSettings(); }
      try {
        noty('Проверка ключа…');
        await sleep(50);
        var key = deriveKey(phrase), kc = keyCheck(key), tk = await tableKeyCheck();
        var accept = async function (overwrite) {
          if (!tk.check || overwrite) await writeSvc(tk.id, 'key_check', kc);
          saveKey(phrase, key);
          log('Ключ синхронизации ' + (overwrite ? 'введён с перезаписью проверки' : 'введён'));
          noty('Ключ принят');
          backToSettings();
          syncAll({ manual: true });
        };
        if (!tk.check || tk.check === kc) return accept(false);
        Lampa.Select.show({
          title: 'Ключ не совпадает с таблицей',
          items: [
            { title: 'Ввести заново', again: true },
            { title: 'Использовать этот ключ', subtitle: 'Перезапишет проверку в таблице. Устройствам со старым ключом придётся ввести этот' }
          ],
          onSelect: function (it) { if (it.again) enterKey(); else accept(true); },
          onBack: backToSettings
        });
      } catch (e) { noty('Ключ: ' + msg(e)); backToSettings(); }
    });
  }

  function keyMenu() {
    var has = !!localStorage.getItem('gsync_key');
    var items = has
      ? [{ title: 'Показать ключ', a: 'show' }, { title: 'Ввести другой ключ', a: 'enter' },
         { title: 'Удалить ключ с этого устройства', subtitle: 'Плагины здесь перестанут синхронизироваться, пока ключ не введён снова', a: 'del' }]
      : [{ title: 'Создать ключ', subtitle: 'На первом устройстве', a: 'create' },
         { title: 'Ввести ключ', subtitle: 'На остальных устройствах', a: 'enter' }];
    Lampa.Select.show({
      title: 'Ключ синхронизации',
      items: items,
      onSelect: function (it) {
        if (it.a === 'show') return showKey(localStorage.getItem('gsync_key_phrase') || '');
        if (it.a === 'create') return createKey();
        if (it.a === 'enter') return enterKey();
        if (it.a === 'del') {
          localStorage.removeItem('gsync_key'); localStorage.removeItem('gsync_key_phrase');
          log('Ключ синхронизации удалён с устройства');
          noty('Ключ удалён с этого устройства');
          backToSettings();
        }
      },
      onBack: backToSettings
    });
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

  /* ---------- Элементы синхронизации: группы и «Уступать CUB» ---------- */
  function setGroup(id, on) {
    localStorage.setItem('gsync_g_' + id, String(!!on));
    if (!on) { localStorage.removeItem('gsync_shadow_' + id); localStorage.removeItem('gsync_inited_' + id); }
    markCfgChanged();
  }

  function openItems(focus) {
    var items = GROUPS.map(function (g) {
      var on = groupEnabled(g.id), who = on && yielded()[g.id];
      return {
        title: (on ? '☑ ' : '☐ ') + g.title,
        subtitle: g.descr + (who ? ' · сейчас уступлено: ' + who : ''),
        group: g.id, selected: g.id === focus
      };
    });
    Lampa.Select.show({
      title: 'Элементы синхронизации (общее для всех устройств)',
      items: items,
      onSelect: function (it) {
        setGroup(it.group, !groupEnabled(it.group));
        openItems(it.group);
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
      title: 'Исключения (список общий для всех устройств)',
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
      title: s.info.title + ' (✗ — значение не покидает устройство)',
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
    function select(name, label, values, def, fn, descr) {
      Lampa.SettingsApi.addParam({
        component: C, param: { name: name, type: 'select', values: values, default: def }, field: { name: label, description: descr || '' },
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
    button('gsync_items', 'Элементы синхронизации', '', function () { openItems(); }, function (item) {
      var on = GROUPS.filter(function (g) { return groupEnabled(g.id); }).length;
      var yt = yieldedText(yielded());
      item.find('.settings-param__descr').text('Включено ' + on + ' из ' + GROUPS.length + ' · общее для всех устройств' + (yt ? ' · уступлено: ' + yt : ''));
    });
    trigger('gsync_cub_yield', 'Уступать другим синхронизациям (для этого устройства)',
      'Если на устройстве работает синхронизация CUB или ByLampa (сервер Lampac), GSync пропускает те же данные — иначе системы перетирают друг друга', true,
      null, function (item) {
        var yt = yieldedText(yielded());
        if (yt) item.find('.settings-param__descr').text('Сейчас уступлено: ' + yt);
      });

    title('mode', 'Режим (для этого устройства)');
    select('gsync_mode', 'Когда синхронизировать',
      { auto: 'При запуске и изменениях', start: 'Только при запуске', manual: 'Вручную' }, 'auto',
      function () { restartTimers(); });
    select('gsync_dir', 'Направление',
      { both: 'В обе стороны', push: 'Только отправлять', pull: 'Только получать' }, 'both');
    trigger('gsync_progress_pause', 'Прогресс — только на паузе и выходе', 'Не отправлять таймкоды во время просмотра', true);
    trigger('gsync_reload', 'Перезапуск после получения изменений', 'При запуске, если пришли настройки. Закладки, прогресс и плагины перезапускают всегда', true);

    title('actions', 'Действия');
    button('gsync_now', 'Синхронизировать сейчас', '', function () {
      if (!isLoggedIn()) return noty('Сначала войдите в аккаунт Google');
      syncAll({ manual: true });
    });
    button('gsync_snap_save', 'Сохранить снимок', 'Полная копия состояния Lampa', saveSnapshot);
    button('gsync_snap_restore', 'Восстановить из снимка', '', restoreSnapshot);
    button('gsync_snap_manage', 'Удалить снимки', 'Выбрать снимки для удаления', manageSnapshots);
    select('gsync_snap_keep', 'Хранить снимков',
      { '0': 'Все', '1': 'Только последний', '3': 'Последние 3', '5': 'Последние 5', '10': 'Последние 10' }, '0',
      markCfgChanged, 'Старые сверх лимита удаляются при сохранении нового · общее для всех устройств');
    button('gsync_compact', 'Сжать таблицу', 'Убрать устаревшие версии строк', compactAll);
    button('gsync_reset', 'Перезаписать таблицу с этого устройства', 'Очистить таблицу и залить данные этого устройства', resetMenu);

    title('security', 'Безопасность');
    button('gsync_key', 'Ключ синхронизации', '', keyMenu, function (item) {
      var has = !!localStorage.getItem('gsync_key'), t;
      if (!has) t = keyStatus === 'need'
        ? '⚠ В таблице включена защита — введите ключ, иначе плагины здесь не синхронизируются'
        : 'Не задан — плагины с других устройств не проверяются. Защита включается для всех устройств сразу, ключ вводится на каждом';
      else t = keyStatus === 'mismatch'
        ? '⚠ Не совпадает с ключом в таблице — плагины здесь не синхронизируются'
        : 'Задан — принимаются только подписанные этим ключом плагины. Защита действует на все устройства, ключ хранится на каждом';
      item.find('.settings-param__descr').text(t);
    });

    title('advanced', 'Расширенные');
    Lampa.SettingsApi.addParam({
      component: C, param: { name: 'gsync_device', type: 'input', values: '', placeholder: 'Например: tv-living', default: '' },
      field: { name: 'Имя устройства', description: 'Для этого устройства. Пишется в колонку device' }
    });
    button('gsync_exclusions', 'Исключения', 'Какие настройки не покидают устройство. Список общий для всех устройств', function () { openExclusions(); });
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
    if (isLoggedIn() && mode() !== 'manual') setTimeout(function () { syncAll({ startup: true, silent: true }); }, 3000); // Lampac-плагины синхронизации успевают объявиться
  }

  if (window.appready) start();
  else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') start(); });
})();
