/*!
 * GSync — синхронизация Lampa / ByLampa через Google Таблицу пользователя
 * Авторизация: OAuth 2.0 Device Flow (google.com/device), scope drive.file
 * Каждый пользователь — своя таблица на своём Google Диске.
 * Версия 0.1.0
 */
(function () {
  'use strict';
  if (window.__gsync_loaded) return;
  window.__gsync_loaded = true;

  /* ============================================================
   * Конфигурация
   * ============================================================ */
  var CFG = {
    CLIENT_ID: 'PASTE_CLIENT_ID.apps.googleusercontent.com',
    CLIENT_SECRET: 'PASTE_CLIENT_SECRET',
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
      id: 'plugins', sheet: 'plugins', order: 'asc', cached: true, title: 'Список плагинов', descr: 'Установленные плагины',
      claim: function (k) { return k === 'plugins'; }
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
    if (!a || !a.refresh_token) throw new Error('не выполнен вход');
    if (a.access_token && Date.now() < a.expires_at - 60000) return a.access_token;
    var r = await formPost(URL_TOKEN, {
      client_id: CFG.CLIENT_ID, client_secret: CFG.CLIENT_SECRET,
      refresh_token: a.refresh_token, grant_type: 'refresh_token'
    });
    if (r.status === 200 && r.json.access_token) { saveAuth(r.json); return r.json.access_token; }
    if (r.json.error === 'invalid_grant') { localStorage.removeItem('gsync_auth'); throw new Error('доступ отозван — войдите заново'); }
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
        saveAuth(p.json);
        Lampa.Modal.close(); backToSettings();
        noty('Вход выполнен: ' + (auth().email || 'Google'));
        log('Вход: ' + (auth().email || ''));
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
    var text = await res.text(), json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) {}
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

  async function rewriteSheet(id, sheet, rows, cols) {
    await api('POST', valuesUrl(id, sheet + '!A2:' + cols) + ':clear', {});
    if (rows.length) await api('PUT', valuesUrl(id, sheet + '!A2') + '?valueInputOption=RAW', { values: rows });
  }

  var META_HEADER = ['key', 'value'];
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

  async function ensureSpreadsheet() {
    var id = lsGet('gsync_sheet_id', '');
    if (id) {
      try { return { id: id, titles: await sheetTitles(id) }; }
      catch (e) {
        if (e.status !== 404 && e.status !== 403) throw e;
        localStorage.removeItem('gsync_sheet_id');
        resetSyncState();
        log('Таблица не найдена — поиск/создание заново');
      }
    }
    var q = encodeURIComponent("appProperties has { key='" + CFG.APP_PROP + "' and value='1' } and trashed=false");
    var list = await api('GET', DRIVE + '?q=' + q + '&spaces=drive&orderBy=createdTime&fields=files(id,name)');
    if (list.files && list.files.length) {
      id = list.files[0].id;
      lsSet('gsync_sheet_id', id);
      log('Найдена таблица «' + list.files[0].name + '»');
      return { id: id, titles: await sheetTitles(id) };
    }
    var created = await api('POST', SHEETS, { properties: { title: CFG.FILE_NAME }, sheets: [sheetSpec('_meta')] });
    id = created.spreadsheetId;
    var props = {}; props[CFG.APP_PROP] = '1';
    await api('PATCH', DRIVE + '/' + id + '?fields=id', { appProperties: props });
    await api('PUT', valuesUrl(id, '_meta!A1') + '?valueInputOption=RAW', { values: [META_HEADER] });
    lsSet('gsync_sheet_id', id);
    log('Создана таблица «' + CFG.FILE_NAME + '»');
    return { id: id, titles: ['_meta'] };
  }

  async function ensureSheets(ss, needed) {
    var missing = needed.filter(function (t) { return ss.titles.indexOf(t) < 0; });
    if (!missing.length) return;
    await api('POST', SHEETS + '/' + ss.id + ':batchUpdate', {
      requests: missing.map(function (t) { return { addSheet: sheetSpec(t) }; })
    });
    await api('POST', SHEETS + '/' + ss.id + '/values:batchUpdate', {
      valueInputOption: 'RAW',
      data: missing.map(function (t) { return { range: t + '!A1', values: [headerFor(t)] }; })
    });
    ss.titles = ss.titles.concat(missing);
  }

  /* ============================================================
   * Общая конфигурация (лист _meta)
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
  function markCfgChanged() { lsSet('gsync_cfg_t', Date.now()); }

  async function writeMeta(id, m) {
    var rows = Object.keys(m).map(function (k) { return [k, String(m[k])]; });
    await rewriteSheet(id, '_meta', rows, 'B');
  }

  /* ============================================================
   * Синхронизация группы
   * ============================================================ */
  function isDel(x) { return x === 1 || x === true || x === '1' || x === 'TRUE'; }

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
    var dir = direction(), now = Date.now(), dev = deviceName();
    var shadowKey = 'gsync_shadow_' + g.id;
    var first = !lsGet('gsync_inited_' + g.id, false);
    var shadow = lsGet(shadowKey, {}) || {};
    var applyRemote = dir !== 'push' && !(g.cached && !ctx.startup);
    var remote = reduceRows(g, rows);
    var local = g.read(), n = local.length;
    var state = {}, present = {};

    // 1. Локальные изменения относительно «тени» (последнего синхронизированного состояния)
    local.forEach(function (pair, idx) {
      var id = pair[0], e = pair[1];
      if (e.v === null || e.v === undefined) return;
      var i = e.i !== undefined ? e.i : idx;
      var h = hash(e.v), s = shadow[id], t;
      present[id] = true;
      if (!s || s.d) t = g.order === 'asc' ? now - (n - idx) : now - i;
      else if (s.h !== h) t = now;
      else if (g.order === 'desc' && i === 0 && s.i !== 0) t = now; // поднят наверх списка
      else t = s.t;
      state[id] = { v: e.v, h: h, t: t, d: false, i: i, cols: e.cols || [], dirty: !s || !!s.d || t !== s.t };
    });
    Object.keys(shadow).forEach(function (id) {
      if (present[id]) return;
      var s = shadow[id];
      if (s.d) {
        if (now - s.t < CFG.TOMBSTONE_TTL_MS) state[id] = { v: null, h: '', t: s.t, d: true, cols: [], dirty: false };
        return;
      }
      if (g.kind === 'kv' && localStorage.getItem(id) !== null) return; // ключ стал локальным — у других не удаляем
      state[id] = { v: null, h: '', t: now, d: true, cols: [], dirty: true };
    });

    // 2. Мерж с таблицей (побеждает больший updated_at; при первой синхронизации — таблица)
    var received = 0, deferred = 0, removed = [];
    Object.keys(remote).forEach(function (id) {
      if (g.kind === 'kv' && isLocalOnly(id)) return;
      var r = remote[id], l = state[id];
      var remoteWins = !l ? true : (first && !r.d) ? true : r.t > l.t;
      if (!remoteWins) {
        if (l && !l.d && !l.dirty && l.t > r.t) l.dirty = true; // в таблице устаревшая версия
        return;
      }
      if (r.d && (!l || l.d)) { state[id] = { v: null, h: '', t: r.t, d: true, cols: [], dirty: false }; return; }
      if (l && !l.d && !r.d && l.h === hash(r.v)) { l.t = r.t; l.dirty = false; return; }
      if (!applyRemote) { if (dir !== 'push') deferred++; return; }
      if (r.d) removed.push(id);
      state[id] = { v: r.v, h: r.d ? '' : hash(r.v), t: r.t, d: r.d, i: l ? l.i : undefined, cols: r.cols, dirty: false };
      received++;
    });
    Object.keys(state).forEach(function (id) {
      var l = state[id];
      if (!remote[id] && !l.d && !l.dirty) l.dirty = true; // в таблице нет — дозаписать
    });

    // 3. Применить полученное локально
    if (received) {
      var entries = Object.keys(state)
        .filter(function (id) { return !state[id].d; })
        .map(function (id) { return { id: id, v: state[id].v, t: state[id].t }; });
      if (g.order === 'desc') entries.sort(function (a, b) { return b.t - a.t; });
      else if (g.order === 'asc') entries.sort(function (a, b) { return a.t - b.t; });
      g.write(entries, removed);
    }

    // 4. Строки для отправки
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
    if (skipped) log(g.title + ': пропущено ' + skipped + ' слишком больших значений');

    // 5. Новая тень
    var ns = {}, live = 0;
    Object.keys(state).forEach(function (id) {
      var l = state[id];
      ns[id] = { h: l.h, t: l.t, d: l.d, i: l.i };
      if (!l.d) live++;
    });
    lsSet(shadowKey, ns);
    lsSet('gsync_inited_' + g.id, true);

    return { rows: out, received: received, deferred: deferred, live: live };
  }

  async function compactGroup(id, g) {
    var rows = (await batchGet(id, [g.sheet + '!A2:Z']))[0];
    var red = reduceRows(g, rows), H = g.header.length, now = Date.now();
    var keep = Object.keys(red).map(function (k) { return red[k].raw; }).filter(function (r) {
      return !(isDel(r[H - 2]) && now - Number(r[H - 3]) > CFG.TOMBSTONE_TTL_MS);
    });
    await rewriteSheet(id, g.sheet, keep, 'Z');
    return { before: rows.length, after: keep.length };
  }

  /* ============================================================
   * Полный цикл синхронизации
   * ============================================================ */
  var busy = null, again = false;

  function syncAll(opts) {
    opts = opts || {};
    if (busy) { again = true; return busy; }
    busy = doSync(opts).catch(function (e) {
      log('Ошибка: ' + msg(e));
      if (!opts.silent) noty('Синхронизация: ' + msg(e));
    }).then(function () {
      busy = null;
      if (again) { again = false; syncAll({ silent: true }); }
    });
    return busy;
  }

  async function doSync(opts) {
    if (!isLoggedIn()) throw new Error('не выполнен вход');
    var ss = await ensureSpreadsheet();

    // Конфигурация
    var metaRows = (await batchGet(ss.id, ['_meta!A2:B']))[0], meta = {};
    metaRows.forEach(function (r) { if (r[0]) meta[r[0]] = r[1]; });
    if (Number(meta.schema_version || 0) > CFG.SCHEMA) throw new Error('таблица от более новой версии плагина — обновите плагин');
    var remoteCfgT = Number(meta.cfg_t || 0), localCfgT = Number(lsGet('gsync_cfg_t', 0)) || 0;
    if (remoteCfgT > localCfgT && meta.cfg) {
      applySharedCfg(safeParse(meta.cfg));
      lsSet('gsync_cfg_t', remoteCfgT);
    } else if (localCfgT > remoteCfgT || !meta.schema_version) {
      var t = localCfgT || Date.now();
      await writeMeta(ss.id, { schema_version: CFG.SCHEMA, cfg: JSON.stringify(sharedCfg()), cfg_t: t, updated_by: deviceName() });
      lsSet('gsync_cfg_t', t);
    }

    var groups = GROUPS.filter(function (g) { return groupEnabled(g.id); });
    if (!groups.length) { log('Нет включённых групп'); return; }
    await ensureSheets(ss, groups.map(function (g) { return g.sheet; }));
    var data = await batchGet(ss.id, groups.map(function (g) { return g.sheet + '!A2:Z'; }));

    var total = { pushed: 0, received: 0, deferred: 0 }, needReload = false, results = [];
    groups.forEach(function (g, i) {
      var r = syncGroup(g, data[i], opts);
      results.push({ g: g, r: r, rowCount: data[i].length + r.rows.length });
      total.pushed += r.rows.length; total.received += r.received; total.deferred += r.deferred;
      if (r.received && (g.cached || g.kind === 'kv')) needReload = true;
    });

    for (var i = 0; i < results.length; i++) {
      if (results[i].r.rows.length) await appendRows(ss.id, results[i].g.sheet, results[i].r.rows);
    }
    for (var j = 0; j < results.length; j++) {
      var x = results[j];
      if (x.rowCount > Math.max(CFG.COMPACT_MIN_ROWS, x.r.live * 2)) await compactGroup(ss.id, x.g);
    }

    lsSet('gsync_last', Date.now());
    log('Синхронизация: отправлено ' + total.pushed + ', получено ' + total.received + (total.deferred ? ', отложено ' + total.deferred : ''));

    var reloaded = false;
    try { reloaded = sessionStorage.getItem('gsync_reloaded') === '1'; } catch (e) {}
    if (opts.startup && needReload && boolSetting('gsync_reload', true) && !reloaded) {
      try { sessionStorage.setItem('gsync_reloaded', '1'); } catch (e) {}
      noty('Получены изменения с других устройств — перезапуск…');
      setTimeout(function () { location.reload(); }, 1500);
    } else if (total.received || total.deferred) {
      noty('Синхронизация: получено ' + total.received +
        (total.deferred ? ', закладки/плагины применятся при следующем запуске' : '') +
        (needReload ? '. Часть настроек применится после перезапуска' : ''));
    } else if (opts.manual) {
      noty('Синхронизировано: отправлено ' + total.pushed);
    }
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
        if (!same && isDefaultDenied(k)) return; // настройки чужого устройства не переносим
        localStorage.setItem(k, obj.keys[k]);
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
    try {
      var ss = await ensureSpreadsheet(), before = 0, after = 0;
      for (var i = 0; i < GROUPS.length; i++) {
        var g = GROUPS[i];
        if (ss.titles.indexOf(g.sheet) < 0) continue;
        var r = await compactGroup(ss.id, g);
        before += r.before; after += r.after;
      }
      log('Сжатие: ' + before + ' → ' + after + ' строк');
      noty('Таблица сжата: ' + before + ' → ' + after + ' строк');
    } catch (e) { noty('Сжатие: ' + msg(e)); }
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

  var GROUP_TITLES = { settings_ui: 'Интерфейс', settings_sources: 'Источники', plugin_settings: 'Плагины' };

  function openExclusions(focusKey) {
    var keys = allKeys().filter(function (k) { return !isHardDenied(k) && !claimedByCollection(k); }).sort();
    if (!keys.length) return noty('Нет ключей для настройки');
    Lampa.Select.show({
      title: 'Исключения (✗ — только на этом устройстве)',
      items: keys.map(function (k) {
        var loc = isLocalOnly(k);
        return {
          title: (loc ? '✗ ' : '✓ ') + k,
          subtitle: (loc ? 'локально' : 'синхронизируется') + ' · ' + (GROUP_TITLES[kvCategory(k)] || ''),
          key: k, selected: k === focusKey
        };
      }),
      onSelect: function (it) {
        var o = overrides(), wantLocal = !isLocalOnly(it.key);
        if (wantLocal === isDefaultDenied(it.key)) delete o[it.key];
        else o[it.key] = wantLocal ? 'deny' : 'allow';
        lsSet('gsync_overrides', o);
        markCfgChanged();
        openExclusions(it.key);
      },
      onBack: backToSettings
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
    Lampa.SettingsApi.addComponent({ component: C, name: 'Синхронизация', icon: ICON });

    function title(name, text) {
      Lampa.SettingsApi.addParam({ component: C, param: { name: 'gsync_title_' + name, type: 'title' }, field: { name: text } });
    }
    function button(name, label, descr, fn, render) {
      Lampa.SettingsApi.addParam({
        component: C, param: { name: name, type: 'button' }, field: { name: label, description: descr || ' ' },
        onChange: fn, onRender: render
      });
    }
    function trigger(name, label, descr, def, fn) {
      Lampa.SettingsApi.addParam({
        component: C, param: { name: name, type: 'trigger', default: def }, field: { name: label, description: descr || '' },
        onChange: function () { setTimeout(fn || function () {}, 0); }
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
      });
    });

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
        if (!e || !e.name || /^gsync_/.test(e.name)) return;
        if (!isLoggedIn() || mode() !== 'auto') return;
        if (/^file_view/.test(e.name) && boolSetting('gsync_progress_pause', true)) return;
        if (relevantKey(e.name)) schedule(CFG.DEBOUNCE_MS);
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
