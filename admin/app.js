(function () {
  'use strict';

  // ── i18n shorthand ─────────────────────────────────────────────

  var t = window.i18n ? window.i18n.t : function (k) { return k; };

  // ── Utilities ─────────────────────────────────────────────────

  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return (ctx || document).querySelectorAll(sel); };
  var $id = function (id) { return document.getElementById(id); };

  function safeId(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '-');
  }

  function esc(s) {
    if (s == null) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function formatBytes(bytes) {
    if (!bytes) return '\u2014';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0; var v = bytes;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(i > 0 ? 1 : 0) + ' ' + u[i];
  }

  function formatUptime(sec) {
    if (sec == null) return '\u2014';
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
    if (h > 0) return h + 'h ' + m + 'm ' + s + 's';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }

  function formatTime(ts) {
    if (!ts) return '\u2014';
    return new Date(ts).toLocaleTimeString();
  }

  function badgeClass(status) {
    if (status >= 200 && status < 300) return 'badge-success';
    if (status >= 400 && status < 500) return 'badge-warning';
    if (status >= 500) return 'badge-error';
    return 'badge-info';
  }

  function roleLabel(role) {
    return role === 'user' ? t('playground.userLabel') : t('playground.assistantLabel');
  }

  var EMBEDDING_MODEL_PATTERNS = [
    /embed/i,
    /nomic/i,
    /bge/i,
    /(?:^|[-_:.])e5(?:$|[-_:.])/i,
    /gte/i,
    /all[-_]?minilm/i,
    /instructor/i,
    /snowflake[-_]?arctic[-_]?embed/i,
    /mxbai[-_]?embed/i,
    /paraphrase/i,
  ];

  function isEmbeddingModel(modelName) {
    if (!modelName) return false;
    return EMBEDDING_MODEL_PATTERNS.some(function (pattern) { return pattern.test(modelName); });
  }

  function isChatModel(modelName) {
    return !!modelName && !isEmbeddingModel(modelName);
  }

  function filterEmbeddingModels(modelNames) {
    return (modelNames || []).filter(isEmbeddingModel);
  }

  function filterChatModels(modelNames) {
    return (modelNames || []).filter(isChatModel);
  }

  // ── State ─────────────────────────────────────────────────────

  var state = {
    apiKey: '',
    authenticated: false,
    loginError: '',
    loginLoading: false,
    tab: 'dashboard',
    serverName: 'Holler Server',
  };

  var activeIntervals = [];
  function clearIntervals() {
    activeIntervals.forEach(function (id) { clearInterval(id); });
    activeIntervals = [];
  }

  var chatMessages = [];
  var chatStreaming = false;

  var configOriginal = {};
  var configDirty = {};
  var enhancedSecurityEnabled = false;
  var bearerTokens = [];

  // ── API ───────────────────────────────────────────────────────

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'X-API-Key': state.apiKey };
    if (opts.headers) {
      Object.keys(opts.headers).forEach(function (k) { headers[k] = opts.headers[k]; });
    }
    opts.headers = headers;
    return fetch('/admin/api' + path, opts).then(function (res) {
      if (res.status === 401) {
        state.authenticated = false;
        state.apiKey = '';
        sessionStorage.removeItem('admin_api_key');
        render();
        throw new Error('Session expired');
      }
      return res;
    });
  }

  function apiJSON(path, opts) {
    return api(path, opts).then(function (res) { return res.json(); });
  }

  function ollamaFetch(path, opts) {
    opts = opts || {};
    var headers = { 'X-API-Key': state.apiKey };
    if (opts.headers) {
      Object.keys(opts.headers).forEach(function (k) { headers[k] = opts.headers[k]; });
    }
    opts.headers = headers;
    return fetch(path, opts);
  }

  // ── Auth ──────────────────────────────────────────────────────

  function login(key) {
    state.loginLoading = true;
    state.loginError = '';
    updateLoginUI();
    fetch('/admin/api/status', { headers: { 'X-API-Key': key } })
      .then(function (res) {
        if (res.ok) {
          state.apiKey = key;
          state.authenticated = true;
          sessionStorage.setItem('admin_api_key', key);
          render();
        } else {
          state.loginError = t('login.invalidKey');
          state.loginLoading = false;
          updateLoginUI();
        }
      })
      .catch(function () {
        state.loginError = t('login.connectionError');
        state.loginLoading = false;
        updateLoginUI();
      });
  }

  function logout() {
    clearIntervals();
    state.apiKey = '';
    state.authenticated = false;
    sessionStorage.removeItem('admin_api_key');
    render();
  }

  function tryHashLogin() {
    var hash = window.location.hash || '';
    if (hash.indexOf('#key=') === 0) {
      var hashKey = decodeURIComponent(hash.slice(5));
      history.replaceState(null, '', window.location.pathname + window.location.search);
      if (hashKey) { login(hashKey); return true; }
    }
    return false;
  }

  function getTabFromHash() {
    var hash = window.location.hash || '';
    if (!hash || hash.indexOf('#key=') === 0) return null;
    var tabName = hash.slice(1);
    return TAB_KEYS.indexOf(tabName) !== -1 ? tabName : null;
  }

  function tryRestore() {
    if (tryHashLogin()) return;
    var tabFromHash = getTabFromHash();
    if (tabFromHash) state.tab = tabFromHash;
    var saved = sessionStorage.getItem('admin_api_key');
    if (saved) { login(saved); } else { render(); }
  }

  window.addEventListener('hashchange', function () {
    if (tryHashLogin()) return;
    var tabFromHash = getTabFromHash();
    if (tabFromHash && state.authenticated && state.tab !== tabFromHash) {
      switchTab(tabFromHash);
    }
  });

  // ── Language Selector ─────────────────────────────────────────

  var LANG_FLAGS = {
    en: '<svg class="lang-flag" viewBox="0 0 30 20" width="18" height="12"><rect fill="#B22234" width="30" height="20"/><rect fill="#fff" y="1.54" width="30" height="1.54"/><rect fill="#fff" y="4.62" width="30" height="1.54"/><rect fill="#fff" y="7.69" width="30" height="1.54"/><rect fill="#fff" y="10.77" width="30" height="1.54"/><rect fill="#fff" y="13.85" width="30" height="1.54"/><rect fill="#fff" y="16.92" width="30" height="1.54"/><rect fill="#3C3B6E" width="12" height="10.77"/><g fill="#fff" transform="translate(1.2,1)"><circle cx="1.5" cy="1.2" r=".5"/><circle cx="3.5" cy="1.2" r=".5"/><circle cx="5.5" cy="1.2" r=".5"/><circle cx="7.5" cy="1.2" r=".5"/><circle cx="9.5" cy="1.2" r=".5"/><circle cx="2.5" cy="2.8" r=".5"/><circle cx="4.5" cy="2.8" r=".5"/><circle cx="6.5" cy="2.8" r=".5"/><circle cx="8.5" cy="2.8" r=".5"/><circle cx="1.5" cy="4.4" r=".5"/><circle cx="3.5" cy="4.4" r=".5"/><circle cx="5.5" cy="4.4" r=".5"/><circle cx="7.5" cy="4.4" r=".5"/><circle cx="9.5" cy="4.4" r=".5"/><circle cx="2.5" cy="6" r=".5"/><circle cx="4.5" cy="6" r=".5"/><circle cx="6.5" cy="6" r=".5"/><circle cx="8.5" cy="6" r=".5"/><circle cx="1.5" cy="7.6" r=".5"/><circle cx="3.5" cy="7.6" r=".5"/><circle cx="5.5" cy="7.6" r=".5"/><circle cx="7.5" cy="7.6" r=".5"/><circle cx="9.5" cy="7.6" r=".5"/></g></svg>',
    es: '<svg class="lang-flag" viewBox="0 0 30 20" width="18" height="12"><rect fill="#AA151B" width="30" height="20"/><rect fill="#F1BF00" y="5" width="30" height="10"/></svg>',
    hillbilly: '<span class="lang-flag-emoji">🤠</span>',
  };

  function langFlagFor(code) {
    return LANG_FLAGS[code] || '';
  }

  function langSelectorHTML() {
    var available = window.i18n ? window.i18n.getAvailable() : [];
    var current = window.i18n ? window.i18n.getLang() : '';
    var currentMeta = available.find(function (l) { return l.code === current; }) || {};

    var options = available.map(function (l) {
      return '<div class="lang-option' + (l.code === current ? ' active' : '') + '" data-lang="' + esc(l.code) + '">' +
        langFlagFor(l.code) + ' ' + esc(l.name) +
      '</div>';
    }).join('');

    return '<div class="lang-dropdown" id="lang-dropdown">' +
      '<button type="button" class="lang-toggle" id="lang-toggle" title="' + esc(t('language.selectorLabel')) + '">' +
        langFlagFor(current) +
        '<span>' + esc(currentMeta.name || '') + '</span>' +
        '<span class="lang-caret">&#9662;</span>' +
      '</button>' +
      '<div class="lang-menu" id="lang-menu">' + options + '</div>' +
    '</div>';
  }

  function attachLangEvents() {
    var toggle = $('#lang-toggle');
    var menu = $('#lang-menu');
    if (!toggle || !menu || !window.i18n) return;

    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.classList.toggle('open');
    });

    menu.addEventListener('click', function (e) {
      var opt = e.target.closest('[data-lang]');
      if (opt) {
        menu.classList.remove('open');
        window.i18n.setLang(opt.dataset.lang);
      }
    });

    document.addEventListener('click', function () {
      menu.classList.remove('open');
    });
  }

  // ── Main Render ───────────────────────────────────────────────

  function render() {
    var app = $('#app');
    clearIntervals();
    if (!state.authenticated) {
      app.innerHTML = loginHTML();
      attachLoginEvents();
      attachLangEvents();
    } else {
      app.innerHTML = shellHTML();
      attachShellEvents();
      attachLangEvents();
      renderTab();
    }
  }

  // ── Login View ────────────────────────────────────────────────

  function loginHTML() {
    return '<div class="login-container">' +
      '<div class="login-lang-float">' + langSelectorHTML() + '</div>' +
      '<div class="login-card">' +
        '<div class="login-logo"><img src="/admin/assets/logo.png" alt="JimboMesh Holler Server"></div>' +
        '<h1>' + esc(state.serverName) + '</h1>' +
        '<p>' + esc(t('login.prompt')) + '</p>' +
        '<div id="login-error" class="login-error"' +
          (state.loginError ? '' : ' style="display:none"') + '>' +
          esc(state.loginError) +
        '</div>' +
        '<form id="login-form">' +
          '<div class="form-group">' +
            '<label for="api-key">' + esc(t('login.apiKeyLabel')) + '</label>' +
            '<input id="api-key" type="password" placeholder="' + esc(t('login.apiKeyPlaceholder')) + '" autocomplete="off" autofocus>' +
          '</div>' +
          '<button type="submit" class="btn btn-primary btn-block" id="login-btn">' +
            (state.loginLoading ? '<span class="spinner"></span> ' + esc(t('status.loading')) : esc(t('login.signIn'))) +
          '</button>' +
        '</form>' +
      '</div>' +
      '<footer class="app-footer">' +
        '<a href="https://ingresstechnology.ai/" target="_blank" rel="noopener">' + t('footer.createdWith') + ' ' +
          '<img src="/admin/assets/ingresslogo_inline.png" alt="Ingress Technology" class="footer-logo">' +
        '</a>' +
      '</footer>' +
    '</div>';
  }

  function attachLoginEvents() {
    var form = $('#login-form');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var key = $('#api-key').value.trim();
        if (key) login(key);
      });
    }
  }

  function updateLoginUI() {
    var err = $('#login-error');
    var btn = $('#login-btn');
    if (err) {
      err.textContent = state.loginError;
      err.style.display = state.loginError ? '' : 'none';
    }
    if (btn) {
      btn.disabled = state.loginLoading;
      btn.innerHTML = state.loginLoading
        ? '<span class="spinner"></span> ' + esc(t('status.loading'))
        : esc(t('login.signIn'));
    }
  }

  // ── App Shell ─────────────────────────────────────────────────

  var TAB_KEYS = ['dashboard', 'models', 'playground', 'statistics', 'config', 'system', 'activity', 'documents', 'feedback'];
  var TAB_LANG_KEYS = {
    dashboard: 'nav.dashboard',
    models: 'nav.models',
    playground: 'nav.playground',
    statistics: 'nav.statistics',
    config: 'nav.configuration',
    system: 'nav.system',
    activity: 'nav.activity',
    documents: 'nav.documents',
    feedback: 'nav.feedback',
  };

  function shellHTML() {
    var tabBtns = TAB_KEYS.map(function (key) {
      return '<button class="tab-btn' + (state.tab === key ? ' active' : '') +
        '" data-tab="' + key + '">' + esc(t(TAB_LANG_KEYS[key])) + '</button>';
    }).join('');

    return '<header class="app-header">' +
        '<div class="brand"><a href="https://jimbomesh.ai/Holler" target="_blank" rel="noopener noreferrer"><img src="/admin/assets/logo.png" class="brand-icon" alt=""></a>' + esc(state.serverName) + ' <span>' + esc(t('header.admin')) + '</span></div>' +
        '<div class="header-actions">' +
          '<button class="btn btn-sm btn-save" id="header-save-btn" disabled style="display:none">' + esc(t('configuration.save')) + '</button>' +
          langSelectorHTML() +
          '<button class="btn btn-sm" id="logout-btn">' + esc(t('nav.signOut')) + '</button>' +
        '</div>' +
      '</header>' +
      '<nav class="tab-bar" id="tab-bar">' + tabBtns + '</nav>' +
      '<div class="tab-content" id="tab-content"></div>' +
      '<footer class="app-footer">' +
        '<a href="https://ingresstechnology.ai/" target="_blank" rel="noopener">' + t('footer.createdWith') + ' ' +
          '<img src="/admin/assets/ingresslogo_inline.png" alt="Ingress Technology" class="footer-logo">' +
        '</a>' +
      '</footer>';
  }

  function attachShellEvents() {
    $('#logout-btn').addEventListener('click', logout);
    $('#header-save-btn').addEventListener('click', saveConfig);
    $('#tab-bar').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-tab]');
      if (btn) switchTab(btn.dataset.tab);
    });
  }

  function switchTab(tab) {
    if (state.tab === tab) return;
    clearIntervals();
    abortActiveStream();
    state.tab = tab;
    if (window.location.hash !== '#' + tab) {
      window.location.hash = tab;
    }
    $$('.tab-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    renderTab();
    updateHeaderSaveButton();
  }

  function updateHeaderSaveButton() {
    var btn = $('#header-save-btn');
    if (!btn) return;
    if (state.tab !== 'config') {
      btn.style.display = 'none';
      return;
    }
    btn.style.display = '';
    var dirtyCount = Object.keys(configDirty).length;
    btn.disabled = dirtyCount === 0;
    btn.textContent = dirtyCount > 0
      ? t('configuration.saveDirty', { count: dirtyCount })
      : t('configuration.save');
  }

  function renderTab() {
    var ct = $('#tab-content');
    if (!ct) return;
    switch (state.tab) {
      case 'dashboard': initDashboard(ct); break;
      case 'models':    initModels(ct); break;
      case 'playground': initPlayground(ct); break;
      case 'statistics': initStatistics(ct); break;
      case 'config':    initConfig(ct); break;
      case 'system':    initSystem(ct); break;
      case 'activity':  initActivity(ct); break;
      case 'documents': initDocuments(ct); break;
      case 'feedback':  initFeedback(ct); break;
    }
  }

  // ── Dashboard Tab ─────────────────────────────────────────────

  function initDashboard(ct) {
    ct.innerHTML =
      '<div class="stats-grid">' +
        statCard('d-health', t('dashboard.serverHealth'), '<span class="status-dot yellow"></span>' + esc(t('status.loading'))) +
        statCard('d-latency', t('dashboard.ollamaLatency'), '\u2014') +
        statCard('d-models', t('dashboard.modelsInstalled'), '\u2014') +
        statCard('d-running', t('dashboard.runningModels'), '\u2014') +
        statCard('d-uptime', t('dashboard.uptime'), '\u2014') +
        statCard('d-requests', t('dashboard.totalRequests'), '\u2014') +
      '</div>' +
      '<div class="stats-grid" id="d-persistent-stats">' +
        statCard('d-today', t('dashboard.today'), '\u2014') +
        statCard('d-embeds', t('dashboard.embedRequests'), '\u2014') +
        statCard('d-chats', t('dashboard.chatRequests'), '\u2014') +
        statCard('d-errors', t('dashboard.errors'), '\u2014') +
        statCard('d-avg-latency', t('dashboard.avgDuration'), '\u2014') +
        statCard('d-db-size', t('dashboard.dbSize'), '\u2014') +
      '</div>' +
      '<div id="d-error"></div>' +
      '<p class="text-muted text-sm">' + esc(t('dashboard.autoRefresh')) + '</p>';

    refreshDashboard();
    activeIntervals.push(setInterval(refreshDashboard, 10000));
  }

  function statCard(id, label, value) {
    return '<div class="stat-card">' +
      '<div class="stat-label">' + esc(label) + '</div>' +
      '<div class="stat-value" id="' + id + '">' + value + '</div>' +
    '</div>';
  }

  function refreshDashboard() {
    apiJSON('/status').then(function (s) {
      var h = $('#d-health');
      if (h) h.innerHTML = '<span class="status-dot ' + (s.healthy ? 'green' : 'red') +
        '"></span>' + (s.healthy ? esc(t('dashboard.healthy')) : esc(t('dashboard.unhealthy')));

      var l = $('#d-latency');
      if (l) {
        l.textContent = s.ollama_latency_ms >= 0 ? s.ollama_latency_ms + ' ms' : 'N/A';
        l.className = 'stat-value ' +
          (s.ollama_latency_ms < 0 ? 'error' : s.ollama_latency_ms < 100 ? 'success' :
           s.ollama_latency_ms < 500 ? 'warning' : 'error');
      }

      setText('#d-models', s.model_count);
      setText('#d-running', s.running_models);
      setText('#d-uptime', formatUptime(s.uptime_seconds));
      setText('#d-requests', s.total_requests != null ? s.total_requests : s.recent_requests);
      if (s.db_size_bytes != null) setText('#d-db-size', formatBytes(s.db_size_bytes));

      var errEl = $('#d-error');
      if (errEl) {
        errEl.innerHTML = s.error
          ? '<div class="card"><div class="login-error">' + esc(t('dashboard.ollamaError', { message: s.error })) + '</div></div>'
          : '';
      }
    }).catch(function () {});

    apiJSON('/stats').then(function (data) {
      if (!data || !data.summary) return;
      var allTime = data.summary.all_time || {};
      var today = data.summary.today || {};

      setText('#d-today', today.total_requests != null ? today.total_requests : '\u2014');
      setText('#d-embeds', allTime.embed_requests != null ? allTime.embed_requests : '\u2014');
      setText('#d-chats', allTime.chat_requests != null ? allTime.chat_requests : '\u2014');
      setText('#d-errors', allTime.error_count != null ? allTime.error_count : '\u2014');
      setText('#d-avg-latency', allTime.avg_duration_ms != null ? allTime.avg_duration_ms + ' ms' : '\u2014');
    }).catch(function () {});
  }

  function setText(sel, val) {
    var el = $(sel);
    if (el) el.textContent = val != null ? val : '\u2014';
  }

  // ── System Tab ────────────────────────────────────────────────

  function usageClass(percent) {
    if (percent == null) return 'green';
    if (percent >= 85) return 'red';
    if (percent >= 60) return 'yellow';
    return 'green';
  }

  function tempClass(tempC) {
    if (tempC == null) return 'green';
    if (tempC >= 80) return 'red';
    if (tempC >= 60) return 'yellow';
    return 'green';
  }

  function fmtGb(v) {
    if (v == null) return '\u2014';
    return Number(v).toFixed(1) + ' GB';
  }

  function fmtMbAsGb(v) {
    if (v == null) return '\u2014';
    return (Number(v) / 1024).toFixed(1) + ' GB';
  }

  function checkIcon(status) {
    if (status === 'pass') return '\u2705';
    if (status === 'warn') return '\u26A0\uFE0F';
    return '\u274C';
  }

  function exposureBadge(exposure) {
    if (exposure === 'local-only') return '<span class="badge badge-success">' + esc(t('system.exposureLocal')) + ' \uD83D\uDD12</span>';
    if (exposure === 'public') return '<span class="badge badge-error">' + esc(t('system.exposurePublic')) + ' \u26A0\uFE0F</span>';
    return '<span class="badge badge-warning">' + esc(t('system.exposureLan')) + ' \u26A0\uFE0F</span>';
  }

  function scoreClass(score) {
    if (score >= 8) return 'green';
    if (score >= 6) return 'yellow';
    return 'red';
  }

  function systemRatingLabel(rating) {
    if (rating === 'Excellent') return t('system.ratingExcellent');
    if (rating === 'Good') return t('system.ratingGood');
    if (rating === 'Fair') return t('system.ratingFair');
    if (rating === 'Poor') return t('system.ratingPoor');
    return t('system.ratingCritical');
  }

  function systemCheckNameLabel(name) {
    var keyByName = {
      'API Authentication': 'system.checkNames.apiAuthentication',
      'Admin Portal Binding': 'system.checkNames.adminPortalBinding',
      'Ollama Binding': 'system.checkNames.ollamaBinding',
      'HTTPS': 'system.checkNames.https',
      'Non-Root User': 'system.checkNames.nonRootUser',
      'Docker Image Pinned': 'system.checkNames.dockerImagePinned',
      'Security Headers': 'system.checkNames.securityHeaders',
      'Public Ports': 'system.checkNames.publicPorts',
      'Qdrant Auth': 'system.checkNames.qdrantAuth',
      'File Upload Restriction': 'system.checkNames.fileUploadRestriction',
      'Body Size Limit': 'system.checkNames.bodySizeLimit',
    };
    return keyByName[name] ? t(keyByName[name]) : name;
  }

  function initSystem(ct) {
    ct.innerHTML = '<div class="card"><div class="empty-state"><span class="spinner"></span> ' + esc(t('status.loading')) + '</div></div>';
    refreshSystem();
    activeIntervals.push(setInterval(refreshSystem, 30000));
  }

  function refreshSystem() {
    apiJSON('/system').then(function (data) {
      renderSystemData(data);
    }).catch(function (err) {
      var ct = $('#tab-content');
      if (!ct || state.tab !== 'system') return;
      ct.innerHTML = '<div class="card"><div class="login-error">' + esc(t('status.errorDetail', { message: err.message })) + '</div></div>';
    });
  }

  function renderSystemData(data) {
    var ct = $('#tab-content');
    if (!ct || state.tab !== 'system' || !data) return;

    var envLabel = data.network && data.network.isDocker ? t('system.environmentDocker') : t('system.environmentNative');
    var dockerName = data.network && data.network.hostname ? data.network.hostname : '\u2014';
    var gpu = data.hardware ? data.hardware.gpu : null;
    var memPct = data.hardware ? data.hardware.memoryUsagePercent : null;
    var cpuPct = data.hardware ? data.hardware.cpuUsagePercent : null;
    var gpuPct = gpu ? gpu.vramUsagePercent : null;
    var gpuUtil = gpu ? gpu.utilizationPercent : null;
    var sec = data.security || { score: 0, rating: 'Critical', checks: [] };
    var secCls = scoreClass(sec.score);

    var portsRows = (data.ports || []).map(function (p) {
      return '<tr>' +
        '<td class="mono">' + esc(p.port) + '</td>' +
        '<td>' + esc(p.service) + '</td>' +
        '<td class="mono">' + esc(p.binding) + '</td>' +
        '<td>' + exposureBadge(p.exposure) + '</td>' +
        '<td><span class="badge badge-success">\uD83D\uDFE2 ' + esc(t('system.statusOpen')) + '</span></td>' +
      '</tr>';
    }).join('');

    var secRows = (sec.checks || []).map(function (c) {
      return '<div class="system-check-row">' +
        '<span>' + checkIcon(c.status) + ' ' + esc(systemCheckNameLabel(c.name)) + '</span>' +
        '<span class="text-muted text-sm">' + esc(c.detail || '') + '</span>' +
      '</div>';
    }).join('');

    var dockerCard = '';
    if (data.docker) {
      var volumesRows = (data.docker.volumes || []).map(function (v) {
        return '<tr>' +
          '<td class="mono">' + esc(v.name) + '</td>' +
          '<td class="mono">' + esc(v.mountpoint) + '</td>' +
          '<td class="mono">' + esc(v.sizeGb != null ? v.sizeGb.toFixed(1) + ' GB' : '\u2014') + '</td>' +
        '</tr>';
      }).join('');
      dockerCard =
        '<div class="card">' +
          '<div class="card-header"><h2>\uD83D\uDCE6 ' + esc(t('system.dockerVolumesTitle')) + '</h2></div>' +
          '<div class="table-wrapper"><table>' +
            '<thead><tr><th>' + esc(t('system.tableVolume')) + '</th><th>' + esc(t('system.tableMount')) + '</th><th>' + esc(t('system.tableSize')) + '</th></tr></thead>' +
            '<tbody>' + (volumesRows || '<tr><td colspan="3" class="text-muted">' + esc(t('system.noMountedVolumes')) + '</td></tr>') + '</tbody>' +
          '</table></div>' +
          '<div class="system-meta-grid">' +
            '<div><span class="text-muted">' + esc(t('system.labelImage')) + ':</span> <span class="mono">' + esc(data.docker.imageName || '\u2014') + '</span></div>' +
            '<div><span class="text-muted">' + esc(t('system.labelContainerId')) + ':</span> <span class="mono">' + esc(data.docker.containerId || '\u2014') + '</span></div>' +
            '<div><span class="text-muted">' + esc(t('system.labelCreated')) + ':</span> <span class="mono">' + esc(data.docker.created || '\u2014') + '</span></div>' +
            '<div><span class="text-muted">' + esc(t('system.labelComposeProject')) + ':</span> <span class="mono">' + esc(data.docker.composeProject || '\u2014') + '</span></div>' +
          '</div>' +
        '</div>';
    }

    ct.innerHTML =
      '<div class="card">' +
        '<div class="card-header"><h2>\uD83D\uDDA5\uFE0F ' + esc(t('system.machineIdentityTitle')) + '</h2></div>' +
        '<div class="system-meta-grid">' +
          '<div><span class="text-muted">' + esc(t('system.labelHostname')) + ':</span> <span class="mono">' + esc(data.hostname || '\u2014') + '</span></div>' +
          '<div><span class="text-muted">' + esc(t('system.labelPlatform')) + ':</span> ' + esc((data.platformLabel || data.platform || '\u2014') + ' (' + (data.arch || '\u2014') + ')') + '</div>' +
          '<div><span class="text-muted">' + esc(t('system.labelLocalIp')) + ':</span> <span class="mono">' + esc((data.network && data.network.localIp) || '\u2014') + '</span></div>' +
          '<div><span class="text-muted">' + esc(t('system.labelDockerIp')) + ':</span> <span class="mono">' + esc((data.network && data.network.dockerIp) || '\u2014') + '</span></div>' +
          '<div><span class="text-muted">' + esc(t('system.labelContainer')) + ':</span> <span class="mono">' + esc(dockerName) + '</span></div>' +
          '<div><span class="text-muted">' + esc(t('system.labelUptime')) + ':</span> ' + esc(formatUptime(data.uptime || 0)) + '</div>' +
          '<div><span class="text-muted">' + esc(t('system.labelHollerVersion')) + ':</span> <span class="mono">' + esc(data.hollerVersion || '\u2014') + '</span></div>' +
          '<div><span class="text-muted">' + esc(t('system.labelEnvironment')) + ':</span> ' + esc(envLabel) + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="system-two-col">' +
        '<div class="card">' +
          '<div class="card-header"><h2>\u26A1 ' + esc(t('system.hardwareTitle')) + '</h2></div>' +
          '<div class="system-section">' +
            '<div class="system-line"><strong>' + esc(t('system.labelCpu')) + ':</strong> ' + esc((data.hardware && data.hardware.cpu) || '\u2014') + '</div>' +
            '<div class="text-muted text-sm">' + esc((data.hardware && data.hardware.cpuCores) || '\u2014') + ' ' + esc(t('system.cores')) + ' / ' + esc((data.hardware && data.hardware.cpuThreads) || '\u2014') + ' ' + esc(t('system.threads')) + '</div>' +
            '<div class="text-muted text-sm">' + esc(t('system.usage')) + ': ' + esc(cpuPct != null ? cpuPct + '%' : '\u2014') + '</div>' +
            '<div class="stat-bar"><div class="stat-bar-fill ' + usageClass(cpuPct) + '" style="width:' + (cpuPct || 0) + '%"></div></div>' +
          '</div>' +
          '<div class="system-section">' +
            '<div class="system-line"><strong>' + esc(t('system.labelMemory')) + ':</strong> ' + esc(fmtGb(data.hardware && data.hardware.memoryUsedGb)) + ' / ' + esc(fmtGb(data.hardware && data.hardware.memoryTotalGb)) + '</div>' +
            '<div class="text-muted text-sm">' + esc(t('system.usage')) + ': ' + esc(memPct != null ? memPct + '%' : '\u2014') + '</div>' +
            '<div class="stat-bar"><div class="stat-bar-fill ' + usageClass(memPct) + '" style="width:' + (memPct || 0) + '%"></div></div>' +
          '</div>' +
          '<div class="system-section">' +
            '<div class="system-line"><strong>' + esc(t('system.labelGpu')) + ':</strong> ' + esc(gpu ? gpu.name : t('system.notDetected')) + '</div>' +
            '<div class="text-muted text-sm">' + (gpu && gpu.unifiedMemory
              ? esc(t('system.unifiedMemory'))
              : esc(t('system.labelVram')) + ': ' + esc(fmtMbAsGb(gpu && gpu.vramUsedMb)) + ' / ' + esc(fmtMbAsGb(gpu && gpu.vramTotalMb)) + (gpuPct != null ? ' (' + gpuPct + '%)' : '')) + '</div>' +
            (gpu && gpuUtil != null
              ? '<div class="text-muted text-sm">' + esc(t('system.utilization')) + ': ' + esc(gpuUtil + '%') + '</div><div class="stat-bar"><div class="stat-bar-fill ' + usageClass(gpuUtil) + '" style="width:' + gpuUtil + '%"></div></div>'
              : '') +
            (gpu && gpu.temperatureC != null
              ? '<div class="text-muted text-sm">' + esc(t('system.temperature')) + ': <span class="system-temp ' + tempClass(gpu.temperatureC) + '">' + esc(gpu.temperatureC + '\u00B0C') + '</span></div>'
              : '') +
          '</div>' +
        '</div>' +

        '<div class="card">' +
          '<div class="card-header"><h2>\uD83D\uDD12 ' + esc(t('system.securityHealthTitle')) + ' <span class="system-score ' + secCls + '">' + esc(sec.score + '/10 ' + systemRatingLabel(sec.rating)) + '</span></h2></div>' +
          '<div class="system-checks">' + secRows + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="card-header"><h2>\uD83C\uDF10 ' + esc(t('system.portsServicesTitle')) + '</h2></div>' +
        '<div class="table-wrapper"><table>' +
          '<thead><tr><th>' + esc(t('system.tablePort')) + '</th><th>' + esc(t('system.tableService')) + '</th><th>' + esc(t('system.tableBinding')) + '</th><th>' + esc(t('system.tableExposure')) + '</th><th>' + esc(t('system.tableStatus')) + '</th></tr></thead>' +
          '<tbody>' + (portsRows || '<tr><td colspan="5" class="text-muted">' + esc(t('system.noHostPorts')) + '</td></tr>') + '</tbody>' +
        '</table></div>' +
      '</div>' +
      dockerCard;
  }

  // ── Toast Notifications ──────────────────────────────────────

  function ensureToastContainer() {
    var c = $('#toast-container');
    if (!c) {
      c = document.createElement('div');
      c.id = 'toast-container';
      c.className = 'toast-container';
      document.body.appendChild(c);
    }
    return c;
  }

  function showToast(message, type) {
    var container = ensureToastContainer();
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + (type || 'info');
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function () {
      toast.classList.add('toast-out');
      setTimeout(function () { toast.remove(); }, 200);
    }, 4000);
  }

  // ── Models / Marketplace Tab ────────────────────────────────

  var mpMode = 'installed';
  var modelsData = { models: [], running: [] };
  var gpuInfo = null;
  var ollamaCatalog = [];
  var ollamaFilterTask = '';
  var ollamaSearch = '';
  var hfResults = [];
  var hfImported = {};
  var hfSearch = '';
  var hfTask = '';
  var hfSort = 'downloads';
  var activePulls = {};  // track pull/import progress by model name

  function initModels(ct) {
    ct.innerHTML =
      '<div class="sub-tabs" id="mp-tabs">' +
        '<button class="sub-tab' + (mpMode === 'installed' ? ' active' : '') + '" data-mp="installed">' + esc(t('marketplace.installed')) + '</button>' +
        '<button class="sub-tab' + (mpMode === 'ollama' ? ' active' : '') + '" data-mp="ollama">' + esc(t('marketplace.ollamaLibrary')) + '</button>' +
        '<button class="sub-tab' + (mpMode === 'huggingface' ? ' active' : '') + '" data-mp="huggingface">' + esc(t('marketplace.huggingFace')) + '</button>' +
      '</div>' +
      '<div id="mp-vram"></div>' +
      '<div id="mp-content"></div>' +
      '<div id="model-detail"></div>' +
      '<div id="delete-dialog"></div>';

    $('#mp-tabs').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-mp]');
      if (!btn) return;
      mpMode = btn.dataset.mp;
      $$('#mp-tabs .sub-tab').forEach(function (b) {
        b.classList.toggle('active', b.dataset.mp === mpMode);
      });
      renderMpMode();
    });

    // Load GPU info (refresh each time — reflects running models)
    apiJSON('/gpu-info').then(function (data) {
      gpuInfo = data;
      renderVramBar();
    }).catch(function () {
      if (gpuInfo) renderVramBar();
    });

    renderMpMode();
  }

  function renderVramBar() {
    var el = $('#mp-vram');
    if (!el || !gpuInfo) return;
    var label, pct, cls, badge;
    if (gpuInfo.gpu && gpuInfo.gpu.type === 'metal') {
      var g = gpuInfo.gpu;
      var og = gpuInfo.ollama_gpu;
      var s = gpuInfo.system;
      var usedMem = s.total_mb - s.free_mb;
      pct = s.total_mb > 0 ? Math.round(usedMem / s.total_mb * 100) : 0;
      cls = pct < 60 ? 'green' : pct < 85 ? 'yellow' : 'red';
      badge = esc(t('marketplace.metalDetected'));
      if (og && og.running_models > 0) {
        label = t('marketplace.vramMetal', {
          offload: String(og.gpu_offload_pct),
          models: String(og.running_models),
          total: formatMb(s.total_mb),
        });
      } else {
        label = t('marketplace.vramMetalIdle', { total: formatMb(s.total_mb) });
      }
    } else if (gpuInfo.gpu && gpuInfo.gpu.type === 'nvidia') {
      var ng = gpuInfo.gpu;
      var used = ng.vram_used_mb;
      var total = ng.vram_total_mb;
      pct = total > 0 ? Math.round(used / total * 100) : 0;
      cls = pct < 60 ? 'green' : pct < 85 ? 'yellow' : 'red';
      badge = esc(t('marketplace.gpuDetected'));
      label = t('marketplace.vramGpu', {
        name: esc(ng.name),
        used: formatMb(used),
        total: formatMb(total),
      });
    } else {
      var sys = gpuInfo.system;
      var usedSys = sys.total_mb - sys.free_mb;
      pct = sys.total_mb > 0 ? Math.round(usedSys / sys.total_mb * 100) : 0;
      cls = 'yellow';
      badge = esc(t('marketplace.cpuOnly'));
      label = t('marketplace.vramCpuOnly', { total: formatMb(sys.total_mb) });
    }
    el.innerHTML =
      '<div class="vram-bar-wrap">' +
        '<div class="vram-bar-label">' +
          '<span>' + badge + '</span>' +
          '<span>' + esc(label) + '</span>' +
        '</div>' +
        '<div class="vram-bar"><div class="vram-bar-fill ' + cls + '" style="width:' + pct + '%"></div></div>' +
      '</div>';
  }

  function formatMb(mb) {
    if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
    return mb + ' MB';
  }

  function getAvailableVramGb() {
    if (gpuInfo && gpuInfo.gpu) return gpuInfo.gpu.vram_free_mb / 1024;
    if (gpuInfo && gpuInfo.system) return gpuInfo.system.free_mb / 1024;
    return 0;
  }

  function fitBadge(sizeGb) {
    var avail = getAvailableVramGb();
    if (avail <= 0) return '';
    if (sizeGb <= avail * 0.8) return '<span class="fit-badge fit-badge-green">' + esc(t('marketplace.willFit')) + '</span>';
    if (sizeGb <= avail) return '<span class="fit-badge fit-badge-yellow">' + esc(t('marketplace.willFitTight')) + '</span>';
    return '<span class="fit-badge fit-badge-red">' + esc(t('marketplace.wontFit')) + '</span>';
  }

  function renderMpMode() {
    var ct = $('#mp-content');
    if (!ct) return;
    switch (mpMode) {
      case 'installed':    renderInstalled(ct); break;
      case 'ollama':       renderOllamaLibrary(ct); break;
      case 'huggingface':  renderHuggingFace(ct); break;
    }
  }

  // ── Installed Sub-Tab ──────────────────────────────────────

  function renderInstalled(ct) {
    ct.innerHTML =
      '<div class="card">' +
        '<div class="card-header"><h2>' + esc(t('models.pullModel')) + '</h2></div>' +
        '<div class="inline-row">' +
          '<div class="form-group">' +
            '<input type="text" id="pull-input" placeholder="' + esc(t('models.pullPlaceholder')) + '">' +
          '</div>' +
          '<button class="btn btn-primary" id="pull-btn">' + esc(t('models.pull')) + '</button>' +
        '</div>' +
        '<div id="pull-progress" style="display:none" class="mt-1">' +
          '<div class="progress-bar"><div class="progress-bar-fill" id="pull-bar" style="width:0%"></div></div>' +
          '<div class="progress-text" id="pull-status"></div>' +
        '</div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-header">' +
          '<h2>' + esc(t('models.installedModels')) + '</h2>' +
          '<button class="btn btn-sm" id="refresh-models">' + esc(t('models.refresh')) + '</button>' +
        '</div>' +
        '<div id="models-body"><div class="empty-state"><span class="spinner"></span> ' + esc(t('status.loading')) + '</div></div>' +
      '</div>' +
      '<div id="model-detail"></div>' +
      '<div id="delete-dialog"></div>';

    $('#pull-btn').addEventListener('click', pullModel);
    $('#pull-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') pullModel();
    });
    $('#refresh-models').addEventListener('click', refreshModels);

    ct.addEventListener('click', function (e) {
      var showBtn = e.target.closest('[data-show]');
      if (showBtn) { showModelDetail(showBtn.dataset.show); return; }
      var delBtn = e.target.closest('[data-delete]');
      if (delBtn) { confirmDeleteModel(delBtn.dataset.delete); return; }
      var updBtn = e.target.closest('[data-update]');
      if (updBtn) { pullModelByName(updBtn.dataset.update); }
    });

    refreshModels();
  }

  function refreshModels() {
    Promise.all([apiJSON('/models'), apiJSON('/models/running')])
      .then(function (results) {
        modelsData.models = results[0].models || [];
        modelsData.running = results[1].models || [];
        renderModelTable();
      })
      .catch(function () {});
  }

  function renderModelTable() {
    var el = $('#models-body');
    if (!el) return;
    var models = modelsData.models;
    var running = modelsData.running;
    if (models.length === 0) {
      el.innerHTML = '<div class="empty-state">' + esc(t('models.emptyState')) + '</div>';
      return;
    }
    var isRunning = function (name) {
      return running.some(function (m) { return m.name === name; });
    };
    var rows = models.map(function (m) {
      var statusBadge = isRunning(m.name)
        ? '<span class="badge badge-success">' + esc(t('models.running')) + '</span>'
        : '<span class="badge badge-info">' + esc(t('models.loaded')) + '</span>';
      var modified = m.modified_at ? formatTime(m.modified_at) : '\u2014';
      return '<tr>' +
        '<td class="mono">' + esc(m.name) + '</td>' +
        '<td class="mono">' + formatBytes(m.size) + '</td>' +
        '<td>' + esc(m.details && m.details.family ? m.details.family : '\u2014') + '</td>' +
        '<td class="mono">' + esc(m.details && m.details.quantization_level ? m.details.quantization_level : '\u2014') + '</td>' +
        '<td>' + modified + '</td>' +
        '<td>' + statusBadge + '</td>' +
        '<td>' +
          '<button class="btn btn-sm" data-show="' + esc(m.name) + '">' + esc(t('models.details')) + '</button> ' +
          '<button class="btn btn-sm btn-primary" data-update="' + esc(m.name) + '">' + esc(t('marketplace.update')) + '</button> ' +
          '<button class="btn btn-sm btn-danger" data-delete="' + esc(m.name) + '">' + esc(t('models.delete')) + '</button>' +
        '</td>' +
      '</tr>';
    }).join('');

    el.innerHTML = '<div class="table-wrapper"><table>' +
      '<thead><tr>' +
        '<th>' + esc(t('models.name')) + '</th>' +
        '<th>' + esc(t('models.size')) + '</th>' +
        '<th>' + esc(t('models.family')) + '</th>' +
        '<th>' + esc(t('models.quantization')) + '</th>' +
        '<th>' + esc(t('marketplace.lastModified')) + '</th>' +
        '<th>' + esc(t('models.statusCol')) + '</th>' +
        '<th>' + esc(t('models.actions')) + '</th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table></div>';
  }

  function pullModel() {
    var input = $('#pull-input');
    var btn = $('#pull-btn');
    if (!input || !input.value.trim()) return;
    if (btn && btn.disabled) return;
    pullModelByName(input.value.trim());
  }

  function pullModelByName(name) {
    if (activePulls[name]) return;

    var progress = $('#pull-progress');
    var bar = $('#pull-bar');
    var status = $('#pull-status');
    var input = $('#pull-input');
    var btn = $('#pull-btn');

    if (progress) progress.style.display = '';
    if (bar) bar.style.width = '0%';
    if (status) status.textContent = t('status.loading');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> ' + esc(t('models.pulling')); }
    if (input) input.disabled = true;

    streamPull(name, function (data) {
      if (data.status && status) {
        var pct = (data.total && data.completed)
          ? ' (' + Math.round(data.completed / data.total * 100) + '%)'
          : '';
        status.textContent = data.status + pct;
      }
      if (data.total && data.completed && bar) {
        bar.style.width = Math.round(data.completed / data.total * 100) + '%';
      }
      if (data.error && status) {
        status.textContent = t('status.errorDetail', { message: data.error });
      }
    }, function (err) {
      delete activePulls[name];
      if (input) { input.value = ''; input.disabled = false; }
      if (btn) { btn.disabled = false; btn.innerHTML = esc(t('models.pull')); }
      if (err === '__cancelled__') {
        showToast(t('marketplace.stopped'), 'info');
      } else if (err) {
        showToast(t('marketplace.pullError') + ': ' + err, 'error');
      } else {
        showToast(t('marketplace.pullSuccess', { name: name }), 'success');
      }
      refreshModels();
      setTimeout(function () { if (progress) progress.style.display = 'none'; }, 3000);
    });
  }

  function streamPull(name, onData, onDone) {
    var controller = new AbortController();
    activePulls[name] = controller;

    api('/models/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name }),
      signal: controller.signal,
    }).then(function (res) {
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var lastError = null;

      function pump() {
        return reader.read().then(function (result) {
          if (result.done) { onDone(lastError); return; }
          buffer += decoder.decode(result.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop();
          lines.forEach(function (line) {
            if (!line.startsWith('data: ')) return;
            try {
              var data = JSON.parse(line.slice(6));
              if (data.error) lastError = data.error;
              onData(data);
            } catch (e) { /* skip */ }
          });
          return pump();
        });
      }
      return pump();
    }).catch(function (err) {
      if (err.name === 'AbortError') {
        onDone('__cancelled__');
      } else {
        onDone(err.message);
      }
    });

    return controller;
  }

  function showModelDetail(name) {
    var el = $('#model-detail');
    if (!el) return;
    el.innerHTML =
      '<div class="card">' +
        '<div class="card-header">' +
          '<h3>' + esc(t('models.detailsTitle', { name: name })) + '</h3>' +
          '<button class="btn btn-sm" id="close-detail">' + esc(t('models.close')) + '</button>' +
        '</div>' +
        '<div class="empty-state"><span class="spinner"></span> ' + esc(t('status.loading')) + '</div>' +
      '</div>';
    $('#close-detail').addEventListener('click', function () { el.innerHTML = ''; });

    apiJSON('/models/show', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name }),
    }).then(function (data) {
      var content = '';
      if (data.modelfile) {
        content += '<p class="text-muted text-sm mb-1">' + esc(t('models.modelfile')) + '</p>' +
          '<div class="detail-panel">' + esc(data.modelfile) + '</div>';
      }
      if (data.parameters) {
        content += '<div class="mt-2"><p class="text-muted text-sm mb-1">' + esc(t('models.parameters')) + '</p>' +
          '<div class="detail-panel">' + esc(data.parameters) + '</div></div>';
      }
      if (data.template) {
        content += '<div class="mt-2"><p class="text-muted text-sm mb-1">' + esc(t('models.template')) + '</p>' +
          '<div class="detail-panel">' + esc(data.template) + '</div></div>';
      }
      if (data.details) {
        content += '<div class="mt-2"><p class="text-muted text-sm mb-1">' + esc(t('models.modelInfo')) + '</p>' +
          '<div class="detail-panel">' + esc(JSON.stringify(data.details, null, 2)) + '</div></div>';
      }
      el.innerHTML =
        '<div class="card">' +
          '<div class="card-header">' +
            '<h3>' + esc(t('models.detailsTitle', { name: name })) + '</h3>' +
            '<button class="btn btn-sm" id="close-detail">' + esc(t('models.close')) + '</button>' +
          '</div>' + content +
        '</div>';
      $('#close-detail').addEventListener('click', function () { el.innerHTML = ''; });
    }).catch(function () {
      el.innerHTML = '';
    });
  }

  function confirmDeleteModel(name) {
    var el = $('#delete-dialog');
    if (!el) return;
    el.innerHTML =
      '<div class="confirm-overlay" id="delete-overlay">' +
        '<div class="confirm-dialog">' +
          '<h3>' + esc(t('models.deleteTitle')) + '</h3>' +
          '<p>' + t('models.deleteConfirm', { name: esc(name) }) + '</p>' +
          '<div class="confirm-actions">' +
            '<button class="btn" id="cancel-delete">' + esc(t('models.cancel')) + '</button>' +
            '<button class="btn btn-danger" id="confirm-delete">' + esc(t('models.delete')) + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    var close = function () { el.innerHTML = ''; };
    $('#cancel-delete').addEventListener('click', close);
    $('#delete-overlay').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) close();
    });
    $('#confirm-delete').addEventListener('click', function () {
      var cbtn = $('#confirm-delete');
      if (cbtn) { cbtn.disabled = true; cbtn.innerHTML = '<span class="spinner"></span> ' + esc(t('models.deleting')); }
      api('/models/' + encodeURIComponent(name), { method: 'DELETE' })
        .then(function () {
          close();
          showToast(t('marketplace.deleteSuccess', { name: name }), 'success');
          refreshModels();
        })
        .catch(function () {
          close();
          showToast(t('marketplace.deleteError'), 'error');
        });
    });
  }

  // ── Ollama Library Sub-Tab ─────────────────────────────────

  function renderOllamaLibrary(ct) {
    ct.innerHTML =
      '<div class="marketplace-header">' +
        '<input type="text" class="search-input" id="ollama-search" placeholder="' + esc(t('marketplace.search')) + '" value="' + esc(ollamaSearch) + '">' +
        '<select class="filter-select" id="ollama-task-filter">' +
          '<option value=""' + (ollamaFilterTask === '' ? ' selected' : '') + '>' + esc(t('marketplace.taskAll')) + '</option>' +
          '<option value="chat"' + (ollamaFilterTask === 'chat' ? ' selected' : '') + '>' + esc(t('marketplace.taskChat')) + '</option>' +
          '<option value="embedding"' + (ollamaFilterTask === 'embedding' ? ' selected' : '') + '>' + esc(t('marketplace.taskEmbed')) + '</option>' +
          '<option value="code"' + (ollamaFilterTask === 'code' ? ' selected' : '') + '>' + esc(t('marketplace.taskCode')) + '</option>' +
          '<option value="vision"' + (ollamaFilterTask === 'vision' ? ' selected' : '') + '>' + esc(t('marketplace.taskVision')) + '</option>' +
        '</select>' +
      '</div>' +
      '<div id="ollama-grid"><div class="mp-empty"><span class="spinner"></span> ' + esc(t('marketplace.loading')) + '</div></div>' +
      '<p class="text-muted text-sm" style="margin-top:0.75rem">' + esc(t('marketplace.catalogNote')) + '</p>';

    var searchInput = $('#ollama-search');
    var taskFilter = $('#ollama-task-filter');
    var searchTimer = null;

    searchInput.addEventListener('input', function () {
      ollamaSearch = searchInput.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderOllamaGrid, 250);
    });
    taskFilter.addEventListener('change', function () {
      ollamaFilterTask = taskFilter.value;
      renderOllamaGrid();
    });

    loadOllamaCatalog();
  }

  function loadOllamaCatalog() {
    apiJSON('/marketplace/ollama').then(function (data) {
      ollamaCatalog = data.models || [];
      renderOllamaGrid();
    }).catch(function () {
      var el = $('#ollama-grid');
      if (el) el.innerHTML = '<div class="mp-empty">' + esc(t('marketplace.noResults')) + '</div>';
    });
  }

  function renderOllamaGrid() {
    var el = $('#ollama-grid');
    if (!el) return;

    var filtered = ollamaCatalog.filter(function (m) {
      if (ollamaFilterTask && m.tasks.indexOf(ollamaFilterTask) === -1) return false;
      if (ollamaSearch) {
        var q = ollamaSearch.toLowerCase();
        return m.name.toLowerCase().indexOf(q) !== -1 || m.description.toLowerCase().indexOf(q) !== -1;
      }
      return true;
    });

    if (filtered.length === 0) {
      el.innerHTML = '<div class="mp-empty">' + esc(t('marketplace.noResults')) + '</div>';
      return;
    }

    var cards = filtered.map(function (m) {
      var isInstalled = m.installed_tags && m.installed_tags.length > 0;
      var badges = '';
      if (isInstalled) badges += '<span class="badge-installed">' + esc(t('marketplace.installedBadge')) + '</span> ';

      var taskTags = m.tasks.map(function (tk) {
        return '<span class="model-tag">' + esc(tk) + '</span>';
      }).join('');

      var variantBtns = m.variants.map(function (v) {
        var fullName = v.tag === 'latest' ? m.name : m.name + ':' + v.tag;
        var installed = m.installed_tags && m.installed_tags.indexOf(v.tag) !== -1;
        var fit = fitBadge(v.vram_gb);
        if (installed) {
          return '<div class="variant-row">' +
            '<span class="variant-btn installed">' + esc(v.params) + ' (' + v.size_gb + ' GB)</span>' +
            '<button class="btn btn-sm btn-danger" data-remove-name="' + esc(fullName) + '">' + esc(t('marketplace.remove')) + '</button>' +
          '</div>';
        }
        return '<div class="variant-row">' +
          '<button class="variant-btn" data-pull-name="' + esc(fullName) + '">' +
            esc(v.params) + ' (' + v.size_gb + ' GB) ' + fit +
          '</button>' +
        '</div>';
      }).join('');

      var bestBadge = '';
      if (gpuInfo) {
        var avail = getAvailableVramGb();
        var bestVariant = null;
        for (var i = m.variants.length - 1; i >= 0; i--) {
          if (m.variants[i].vram_gb <= avail * 0.8) { bestVariant = m.variants[i]; break; }
        }
        if (bestVariant) badges += '<span class="badge-best">' + esc(t('marketplace.bestForHardware')) + '</span> ';
      }

      return '<div class="model-card model-card-expand" data-card="' + esc(m.name) + '">' +
        '<div class="model-card-header">' +
          '<div class="model-card-name">' + esc(m.name) + '</div>' +
          '<div>' + badges + '</div>' +
        '</div>' +
        '<div class="model-card-body">' + esc(m.description) + '</div>' +
        '<div class="model-card-meta">' + taskTags + '</div>' +
        '<div class="model-card-footer">' +
          '<div class="model-card-stats">' +
            '<span class="model-card-stat">' + esc(m.license || '') + '</span>' +
          '</div>' +
          '<span class="text-muted text-sm">' + m.variants.length + ' ' + esc(t('marketplace.variants')) + '</span>' +
        '</div>' +
        '<div class="model-card-expand-body">' +
          '<p class="text-muted text-sm mb-1">' + esc(t('marketplace.selectVariant')) + '</p>' +
          '<div class="variant-list">' + variantBtns + '</div>' +
          '<div id="card-progress-' + safeId(m.name) + '"></div>' +
        '</div>' +
      '</div>';
    }).join('');

    el.innerHTML = '<div class="model-grid">' + cards + '</div>';

    el.onclick = function (e) {
      var pullBtn = e.target.closest('[data-pull-name]');
      if (pullBtn) {
        e.stopPropagation();
        ollamaPullFromCard(pullBtn.dataset.pullName, pullBtn);
        return;
      }
      var stopBtn = e.target.closest('[data-stop-pull]');
      if (stopBtn) {
        e.stopPropagation();
        ollamaStopPull(stopBtn.dataset.stopPull);
        return;
      }
      var removeBtn = e.target.closest('[data-remove-name]');
      if (removeBtn) {
        e.stopPropagation();
        ollamaRemoveVariant(removeBtn.dataset.removeName, removeBtn);
        return;
      }
      var card = e.target.closest('[data-card]');
      if (card) card.classList.toggle('expanded');
    };
  }

  function ollamaPullFromCard(name, btn) {
    if (activePulls[name]) return;
    var origText = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = t('marketplace.installing');

    // Find progress container from the card (use safeId to handle dots in names)
    var safe = safeId(name.split(':')[0]);
    var progressEl = $id('card-progress-' + safe);
    if (progressEl) {
      progressEl.innerHTML =
        '<div class="card-progress">' +
          '<div class="progress-bar"><div class="progress-bar-fill" id="cpbar-' + safe + '" style="width:0%"></div></div>' +
          '<div class="card-progress-row">' +
            '<span class="card-progress-text" id="cpstatus-' + safe + '"></span>' +
            '<button class="btn btn-sm btn-danger" data-stop-pull="' + esc(name) + '">' + esc(t('marketplace.stop')) + '</button>' +
          '</div>' +
        '</div>';
    }

    streamPull(name, function (data) {
      var bar = $id('cpbar-' + safe);
      var status = $id('cpstatus-' + safe);
      if (data.status && status) {
        var pct = (data.total && data.completed) ? ' (' + Math.round(data.completed / data.total * 100) + '%)' : '';
        status.textContent = data.status + pct;
      }
      if (data.total && data.completed && bar) {
        bar.style.width = Math.round(data.completed / data.total * 100) + '%';
      }
    }, function (err) {
      delete activePulls[name];
      if (err === '__cancelled__') {
        showToast(t('marketplace.stopped'), 'info');
        btn.disabled = false;
        btn.innerHTML = origText;
      } else if (err) {
        showToast(t('marketplace.pullError') + ': ' + err, 'error');
        btn.disabled = false;
        btn.innerHTML = origText;
      } else {
        showToast(t('marketplace.pullSuccess', { name: name }), 'success');
        // Refresh to update installed_tags and show remove buttons
        loadOllamaCatalog();
      }
      if (progressEl) setTimeout(function () { progressEl.innerHTML = ''; }, 3000);
    });
  }

  function ollamaStopPull(name) {
    var controller = activePulls[name];
    if (controller && controller.abort) {
      controller.abort();
    }
  }

  function ollamaRemoveVariant(name, btn) {
    var origText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> ' + esc(t('marketplace.removing'));

    api('/models/' + encodeURIComponent(name), { method: 'DELETE' })
      .then(function (res) {
        if (res.ok) {
          showToast(t('marketplace.removeSuccess', { name: name }), 'success');
          loadOllamaCatalog();
        } else {
          showToast(t('marketplace.removeError'), 'error');
          btn.disabled = false;
          btn.innerHTML = origText;
        }
      })
      .catch(function () {
        showToast(t('marketplace.removeError'), 'error');
        btn.disabled = false;
        btn.innerHTML = origText;
      });
  }

  // ── Hugging Face Sub-Tab ───────────────────────────────────

  function renderHuggingFace(ct) {
    ct.innerHTML =
      '<div class="marketplace-header">' +
        '<input type="text" class="search-input" id="hf-search" placeholder="' + esc(t('marketplace.searchHf')) + '" value="' + esc(hfSearch) + '">' +
        '<select class="filter-select" id="hf-task-filter">' +
          '<option value=""' + (hfTask === '' ? ' selected' : '') + '>' + esc(t('marketplace.taskAll')) + '</option>' +
          '<option value="text-generation"' + (hfTask === 'text-generation' ? ' selected' : '') + '>' + esc(t('marketplace.taskTextGen')) + '</option>' +
          '<option value="feature-extraction"' + (hfTask === 'feature-extraction' ? ' selected' : '') + '>' + esc(t('marketplace.taskFeatureExtract')) + '</option>' +
          '<option value="text2text-generation"' + (hfTask === 'text2text-generation' ? ' selected' : '') + '>' + esc(t('marketplace.taskText2Text')) + '</option>' +
        '</select>' +
        '<select class="filter-select" id="hf-sort">' +
          '<option value="downloads"' + (hfSort === 'downloads' ? ' selected' : '') + '>' + esc(t('marketplace.sortDownloads')) + '</option>' +
          '<option value="likes"' + (hfSort === 'likes' ? ' selected' : '') + '>' + esc(t('marketplace.sortLikes')) + '</option>' +
          '<option value="lastModified"' + (hfSort === 'lastModified' ? ' selected' : '') + '>' + esc(t('marketplace.sortRecent')) + '</option>' +
        '</select>' +
        '<button class="btn btn-primary btn-sm" id="hf-search-btn">' + esc(t('marketplace.search').replace('...', '')) + '</button>' +
      '</div>' +
      '<p class="text-muted text-sm" style="margin-bottom:0.75rem">' + esc(t('marketplace.hfNote')) + '</p>' +
      '<div id="hf-grid"><div class="mp-empty">' + esc(t('marketplace.noResults')) + '</div></div>' +
      '<div id="hf-import-dialog"></div>';

    $('#hf-search-btn').addEventListener('click', loadHfModels);
    $('#hf-search').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') loadHfModels();
    });
    $('#hf-task-filter').addEventListener('change', function () {
      hfTask = this.value;
    });
    $('#hf-sort').addEventListener('change', function () {
      hfSort = this.value;
    });

    // Auto-search if we have results or this is first visit
    if (hfResults.length > 0) {
      renderHfGrid();
    } else {
      loadHfModels();
    }
  }

  function loadHfModels() {
    var searchInput = $('#hf-search');
    if (searchInput) hfSearch = searchInput.value;

    var gridEl = $('#hf-grid');
    if (gridEl) gridEl.innerHTML = '<div class="mp-empty"><span class="spinner"></span> ' + esc(t('marketplace.loading')) + '</div>';

    var params = '?sort=' + encodeURIComponent(hfSort) + '&limit=24';
    if (hfSearch) params += '&search=' + encodeURIComponent(hfSearch);
    if (hfTask) params += '&task=' + encodeURIComponent(hfTask);

    apiJSON('/marketplace/huggingface' + params).then(function (data) {
      hfResults = data.models || [];
      hfImported = data.imported || {};
      renderHfGrid();
    }).catch(function (err) {
      if (gridEl) gridEl.innerHTML = '<div class="mp-empty" style="color:var(--danger)">' + esc(t('marketplace.hfError') || 'Failed to load models from HuggingFace') + (err.message ? ': ' + esc(err.message) : '') + '</div>';
    });
  }

  function renderHfGrid() {
    var el = $('#hf-grid');
    if (!el) return;

    if (hfResults.length === 0) {
      el.innerHTML = '<div class="mp-empty">' + esc(t('marketplace.noResults')) + '</div>';
      return;
    }

    var cards = hfResults.map(function (m) {
      var repoId = m.modelId || m.id;
      var downloads = m.downloads != null ? formatNumber(m.downloads) : '0';
      var likes = m.likes != null ? m.likes : 0;
      var pipeline = m.pipeline_tag || '';
      var license = (m.tags || []).find(function (t) { return t.startsWith('license:'); });
      license = license ? license.split(':')[1] : '';
      var lastMod = m.lastModified ? new Date(m.lastModified).toLocaleDateString() : '';
      var repoImports = hfImported[repoId];
      var isInstalled = repoImports && repoImports.length > 0;

      return '<div class="model-card model-card-expand" data-hf-card="' + esc(repoId) + '">' +
        '<div class="model-card-header">' +
          '<div class="model-card-name">' + esc(repoId) + '</div>' +
          (isInstalled ? '<span class="badge-installed">' + esc(t('marketplace.installedBadge')) + '</span>' : '') +
        '</div>' +
        '<div class="model-card-meta">' +
          (pipeline ? '<span class="model-tag model-tag-accent">' + esc(pipeline) + '</span>' : '') +
          (license ? '<span class="model-tag">' + esc(license) + '</span>' : '') +
        '</div>' +
        '<div class="model-card-footer">' +
          '<div class="model-card-stats">' +
            '<span class="model-card-stat">' + downloads + ' ' + esc(t('marketplace.downloads')) + '</span>' +
            '<span class="model-card-stat">' + likes + ' ' + esc(t('marketplace.likes')) + '</span>' +
          '</div>' +
          (lastMod ? '<span class="text-muted text-sm">' + lastMod + '</span>' : '') +
        '</div>' +
        '<div class="model-card-expand-body">' +
          '<div id="hf-files-' + (m.modelId || m.id).replace(/\//g, '--') + '">' +
            '<span class="spinner"></span> ' + esc(t('marketplace.loadingFiles')) +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    el.innerHTML = '<div class="model-grid">' + cards + '</div>';

    el.onclick = function (e) {
      var importBtn = e.target.closest('[data-hf-import]');
      if (importBtn) {
        e.stopPropagation();
        showHfImportDialog(importBtn.dataset.hfImport, importBtn.dataset.hfRepo);
        return;
      }
      var card = e.target.closest('[data-hf-card]');
      if (card) {
        var wasExpanded = card.classList.contains('expanded');
        card.classList.toggle('expanded');
        if (!wasExpanded) {
          loadHfFiles(card.dataset.hfCard);
        }
      }
    };
  }

  function loadHfFiles(repoId) {
    var safeRepoId = repoId.replace(/\//g, '--');
    var el = $id('hf-files-' + safeRepoId);
    if (!el) return;

    apiJSON('/marketplace/huggingface/files?repo=' + encodeURIComponent(repoId)).then(function (data) {
      var files = data.files || [];
      if (files.length === 0) {
        el.innerHTML = '<span class="text-muted">' + esc(t('marketplace.noFiles')) + '</span>';
        return;
      }

      var rows = files.map(function (f) {
        var sizeGb = f.size ? (f.size / (1024 * 1024 * 1024)).toFixed(2) : '?';
        var fit = f.size ? fitBadge(f.size / (1024 * 1024 * 1024)) : '';
        var actionCol;
        if (f.installed_as) {
          actionCol = '<span class="badge-installed">' + esc(t('marketplace.installedBadge')) + '</span>' +
            '<span class="text-muted text-sm" style="margin-left:0.5rem">' + esc(f.installed_as) + '</span>';
        } else {
          actionCol = '<button class="btn btn-sm btn-primary" data-hf-import="' + esc(f.filename) + '" data-hf-repo="' + esc(repoId) + '">' +
              esc(t('marketplace.import')) +
            '</button>';
        }
        return '<tr>' +
          '<td class="mono" style="font-size:0.8125rem;word-break:break-all">' + esc(f.filename) + '</td>' +
          '<td class="mono">' + sizeGb + ' GB</td>' +
          '<td>' + fit + '</td>' +
          '<td>' + actionCol + '</td>' +
        '</tr>';
      }).join('');

      el.innerHTML =
        '<p class="text-muted text-sm mb-1">' + esc(t('marketplace.files')) + '</p>' +
        '<div class="table-wrapper"><table>' +
          '<thead><tr><th>File</th><th>' + esc(t('models.size')) + '</th><th>Fit</th><th></th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table></div>';
    }).catch(function (err) {
      el.innerHTML = '<span class="text-muted" style="color:var(--danger)">' + esc(t('marketplace.hfError') || 'Failed to load files') + (err.message ? ': ' + esc(err.message) : '') + '</span>';
    });
  }

  function showHfImportDialog(filename, repoId) {
    var el = $('#hf-import-dialog');
    if (!el) return;

    var suggestedName = filename.replace(/\.gguf$/i, '').replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();

    el.innerHTML =
      '<div class="confirm-overlay" id="hf-import-overlay">' +
        '<div class="confirm-dialog">' +
          '<h3>' + esc(t('marketplace.import')) + ': ' + esc(filename) + '</h3>' +
          '<p class="text-muted text-sm">' + esc(repoId) + '</p>' +
          '<div class="form-group" style="margin:1rem 0">' +
            '<label>' + esc(t('marketplace.modelName')) + '</label>' +
            '<input type="text" id="hf-model-name" value="' + esc(suggestedName) + '" placeholder="' + esc(t('marketplace.modelNamePlaceholder')) + '">' +
          '</div>' +
          '<div id="hf-import-progress" style="display:none">' +
            '<div class="progress-bar"><div class="progress-bar-fill" id="hf-import-bar" style="width:0%"></div></div>' +
            '<div class="progress-text" id="hf-import-status"></div>' +
          '</div>' +
          '<div class="confirm-actions">' +
            '<button class="btn" id="hf-import-cancel">' + esc(t('marketplace.cancel')) + '</button>' +
            '<button class="btn btn-primary" id="hf-import-confirm">' + esc(t('marketplace.importConfirm')) + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    var close = function () { el.innerHTML = ''; };
    $('#hf-import-cancel').addEventListener('click', close);
    $('#hf-import-overlay').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) close();
    });

    $('#hf-import-confirm').addEventListener('click', function () {
      var modelName = ($('#hf-model-name') || {}).value;
      if (!modelName || !modelName.trim()) return;
      modelName = modelName.trim();

      var confirmBtn = $('#hf-import-confirm');
      var cancelBtn = $('#hf-import-cancel');
      if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = t('marketplace.importing'); }
      if (cancelBtn) cancelBtn.disabled = true;

      var progressDiv = $('#hf-import-progress');
      var bar = $('#hf-import-bar');
      var statusEl = $('#hf-import-status');
      if (progressDiv) progressDiv.style.display = '';

      var importFailed = false;

      api('/models/import-hf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo_id: repoId, filename: filename, model_name: modelName }),
      }).then(function (res) {
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';

        function pump() {
          return reader.read().then(function (result) {
            if (result.done) {
              if (!importFailed) {
                showToast(t('marketplace.importSuccess', { name: modelName }), 'success');
                refreshModels();
                loadHfModels();
              }
              close();
              return;
            }
            buffer += decoder.decode(result.value, { stream: true });
            var lines = buffer.split('\n');
            buffer = lines.pop();
            lines.forEach(function (line) {
              if (!line.startsWith('data: ') || importFailed) return;
              try {
                var data = JSON.parse(line.slice(6));
                if (data.error) {
                  importFailed = true;
                  if (statusEl) statusEl.textContent = data.error;
                  if (bar) { bar.style.width = '100%'; bar.classList.add('error'); }
                  showToast(t('marketplace.importError') + ': ' + data.error, 'error');
                  if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = t('marketplace.importConfirm'); }
                  if (cancelBtn) cancelBtn.disabled = false;
                  return;
                }
                if (data.status && statusEl) statusEl.textContent = data.status;
                if (data.total && data.completed && bar) {
                  bar.style.width = Math.round(data.completed / data.total * 100) + '%';
                }
                if (data.done && !importFailed) {
                  showToast(t('marketplace.importSuccess', { name: modelName }), 'success');
                  close();
                  refreshModels();
                  loadHfModels();
                }
              } catch (e) { /* skip */ }
            });
            return pump();
          });
        }
        return pump();
      }).catch(function (err) {
        showToast(t('marketplace.importError') + ': ' + err.message, 'error');
        close();
      });
    });
  }

  function formatNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  // ── Playground Tab ────────────────────────────────────────────

  var pgModels = [];
  var pgMode = 'embed';
  var activeStreamController = null;
  var loadingHintTimer = null;
  var selectedEmbedModel = '';
  var selectedChatModel = '';
  var selectedGenerateModel = '';

  function abortActiveStream() {
    if (activeStreamController) {
      activeStreamController.abort();
      activeStreamController = null;
    }
    if (loadingHintTimer) {
      clearTimeout(loadingHintTimer);
      loadingHintTimer = null;
    }
    chatStreaming = false;
  }

  var chatPresets = [
    { labelKey: 'quickPrompts.sayHello', text: 'Say hello.' },
    { labelKey: 'quickPrompts.small', text: 'You are a helpful assistant. Answer concisely.\n\nWhat are the three laws of thermodynamics? Explain each in one sentence.' },
    { labelKey: 'quickPrompts.medium', text: 'You are a senior software architect. Analyze the following and provide your response as valid JSON.\n\nA startup is building a real-time multiplayer game with these constraints:\n- 10,000 concurrent users\n- Sub-50ms latency requirement\n- State must survive server restarts\n- Budget: $2,000/month cloud spend\n\nProvide your response as JSON with these keys:\n- "architecture": a description of the recommended stack\n- "components": array of {name, purpose, technology}\n- "tradeoffs": array of {decision, pro, con}\n- "estimated_monthly_cost": breakdown object\n- "risks": array of top 3 risks\n\nBe thorough. This is a real design review.' },
    { labelKey: 'quickPrompts.large', text: 'You are an expert computer scientist, mathematician, and technical writer. Complete ALL of the following tasks in a single response. Do not skip any.\n\nTASK 1 \u2014 ALGORITHM DESIGN:\nDesign a novel distributed consensus algorithm for a mesh network where nodes have unreliable connectivity (30% packet loss, variable latency 50-5000ms). Describe it formally with pseudocode, prove its convergence properties, and compare it to Raft and PBFT across 5 dimensions.\n\nTASK 2 \u2014 CODE GENERATION:\nWrite a complete, working Python implementation of a B+ tree with the following operations: insert, delete, search, range_query, bulk_load, serialize_to_disk, deserialize_from_disk. Include comprehensive error handling, type hints, and docstrings. Then write 15 unit tests for it using pytest.\n\nTASK 3 \u2014 MATHEMATICAL PROOF:\nProve that the halting problem is undecidable using a diagonalization argument. Then explain how this relates to Goedels incompleteness theorems and Rices theorem. Use formal notation where appropriate.\n\nTASK 4 \u2014 CREATIVE SYNTHESIS:\nWrite a 500-word short story where the protagonist is an AI running on a mesh network of moonshine stills in Appalachia. The story must incorporate at least 3 real computer science concepts accurately while being genuinely entertaining.\n\nTASK 5 \u2014 SELF-ANALYSIS:\nEstimate how many tokens this entire response contains. Analyze which of the above tasks was hardest for you and why. Rate your confidence in each answer on a scale of 1-10 with justification.\n\nBegin. Do not ask clarifying questions. Complete everything.' },
  ];

  function initPlayground(ct) {
    ct.innerHTML =
      '<div class="sub-tabs" id="pg-tabs">' +
        '<button class="sub-tab' + (pgMode === 'embed' ? ' active' : '') + '" data-pg="embed">' + esc(t('playground.embeddings')) + '</button>' +
        '<button class="sub-tab' + (pgMode === 'chat' ? ' active' : '') + '" data-pg="chat">' + esc(t('playground.chat')) + '</button>' +
        '<button class="sub-tab' + (pgMode === 'generate' ? ' active' : '') + '" data-pg="generate">' + esc(t('playground.generate')) + '</button>' +
      '</div>' +
      '<div id="pg-content"></div>';

    $('#pg-tabs').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-pg]');
      if (!btn) return;
      abortActiveStream();
      pgMode = btn.dataset.pg;
      $$('#pg-tabs .sub-tab').forEach(function (b) {
        b.classList.toggle('active', b.dataset.pg === pgMode);
      });
      renderPgMode();
    });

    apiJSON('/models').then(function (data) {
      pgModels = (data.models || []).map(function (m) { return m.name; });
      renderPgMode();
    }).catch(function () { renderPgMode(); });
  }

  function renderPgMode() {
    var ct = $('#pg-content');
    if (!ct) return;
    switch (pgMode) {
      case 'embed':    renderEmbed(ct); break;
      case 'chat':     renderChat(ct); break;
      case 'generate': renderGenerate(ct); break;
    }
  }

  function modelOptions(models, selected) {
    return (models || []).map(function (m) {
      var sel = (m === selected) ? ' selected' : '';
      return '<option value="' + esc(m) + '"' + sel + '>' + esc(m) + '</option>';
    }).join('');
  }

  // ── Playground: Embed ─────────────────────────────────────────

  function renderEmbed(ct) {
    var embeddingModels = filterEmbeddingModels(pgModels);
    if (!selectedEmbedModel || embeddingModels.indexOf(selectedEmbedModel) === -1) {
      selectedEmbedModel = embeddingModels[0] || '';
    }

    if (embeddingModels.length === 0) {
      ct.innerHTML =
        '<div class="card">' +
          '<div class="empty-state">' +
            '<p>' + esc(t('playground.noEmbeddingModels')) + '</p>' +
            '<p class="text-muted">' + esc(t('playground.noEmbeddingModelsHint')) + '</p>' +
            '<code>ollama pull nomic-embed-text</code>' +
          '</div>' +
        '</div>';
      return;
    }

    ct.innerHTML =
      '<div class="card">' +
        '<div class="card-header"><h2>' + esc(t('embed.title')) + '</h2></div>' +
        '<div class="form-group">' +
          '<label for="embed-model">' + esc(t('playground.modelSelector')) + '</label>' +
          '<select id="embed-model">' + modelOptions(embeddingModels, selectedEmbedModel) + '</select>' +
        '</div>' +
        '<div class="form-group">' +
          '<label>' + esc(t('embed.inputLabel')) + '</label>' +
          '<textarea id="embed-input" rows="3" placeholder="' + esc(t('embed.inputPlaceholder')) + '">' + esc(t('embed.defaultText')) + '</textarea>' +
        '</div>' +
        '<button class="btn btn-primary" id="embed-btn">' + esc(t('embed.generateBtn')) + '</button>' +
        '<div id="embed-result"></div>' +
      '</div>';

    $('#embed-model').addEventListener('change', function () {
      selectedEmbedModel = this.value;
    });
    $('#embed-btn').addEventListener('click', runEmbed);
  }

  function runEmbed() {
    var input = $('#embed-input');
    var embedModelSelect = $('#embed-model');
    var btn = $('#embed-btn');
    var result = $('#embed-result');
    if (!input || !input.value.trim()) return;
    if (!embedModelSelect || !embedModelSelect.value) {
      showToast(t('playground.noEmbeddingModels'), 'error');
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> ' + esc(t('embed.generating'));

    var embedModel = embedModelSelect.value;
    selectedEmbedModel = embedModel;
    var start = performance.now();

    activeStreamController = new AbortController();

    ollamaFetch('/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: embedModel, input: input.value }),
      signal: activeStreamController.signal,
    }).then(function (res) { return res.json(); })
      .then(function (data) {
        activeStreamController = null;
        var elapsed = Math.round(performance.now() - start);
        var embeddings = data.embeddings || data.embedding;
        var vector = Array.isArray(embeddings)
          ? (Array.isArray(embeddings[0]) ? embeddings[0] : embeddings)
          : [];
        var preview = vector.slice(0, 10).map(function (v) { return v.toFixed(6); }).join(', ') + '\u2026';

        result.innerHTML =
          '<div class="mt-2">' +
            '<div class="stats-grid">' +
              statCard('', t('embed.dimensions'), vector.length) +
              statCard('', t('embed.latency'), elapsed + ' ms') +
              '<div class="stat-card"><div class="stat-label">' + esc(t('embed.model')) + '</div>' +
                '<div class="stat-value" style="font-size:0.875rem">' + esc(data.model || '\u2014') + '</div></div>' +
            '</div>' +
            '<p class="text-muted text-sm mb-1">' + esc(t('embed.vectorPreview')) + '</p>' +
            '<div class="playground-output">' + esc(preview) + '</div>' +
          '</div>';
        btn.disabled = false;
        btn.innerHTML = esc(t('embed.generateBtn'));
      })
      .catch(function (err) {
        activeStreamController = null;
        if (err.name === 'AbortError') return;
        result.innerHTML = '<div class="mt-2 login-error">' + esc(t('status.errorDetail', { message: err.message })) + '</div>';
        btn.disabled = false;
        btn.innerHTML = esc(t('embed.generateBtn'));
      });
  }

  // ── Playground: Chat ──────────────────────────────────────────

  function renderChat(ct) {
    var chatModels = filterChatModels(pgModels);
    if (!selectedChatModel || chatModels.indexOf(selectedChatModel) === -1) {
      selectedChatModel = chatModels[0] || '';
    }

    var msgsHTML = '';
    if (chatModels.length === 0) {
      msgsHTML =
        '<div class="empty-state">' +
          '<p>' + esc(t('playground.noChatModels')) + '</p>' +
          '<p class="text-muted">' + esc(t('playground.noChatModelsHint')) + '</p>' +
          '<code>ollama pull llama3.2:1b</code>' +
        '</div>';
    } else if (chatMessages.length === 0) {
      msgsHTML = '<div class="empty-state">' + esc(t('playground.emptyState')) + '</div>';
    } else {
      msgsHTML = chatMessages.map(function (m) {
        return '<div class="chat-message ' + m.role + '">' +
          '<div class="role">' + esc(roleLabel(m.role)) + '</div>' +
          '<div class="msg-content">' + esc(m.content || '\u2026') + '</div>' +
        '</div>';
      }).join('');
    }

    var presetBtns = chatPresets.map(function (p, i) {
      return '<button class="btn btn-sm chat-preset-btn" data-preset="' + i + '">' + esc(t(p.labelKey)) + '</button>';
    }).join('');

    ct.innerHTML =
      '<div class="card chat-card">' +
        '<div class="card-header">' +
          '<h2>' + esc(t('playground.title')) + '</h2>' +
          '<div style="display:flex;gap:0.5rem;align-items:center">' +
            '<label class="text-muted text-sm" for="chat-model" style="white-space:nowrap">' + esc(t('playground.modelSelector')) + '</label>' +
            '<select id="chat-model" style="width:auto;min-width:200px"' + (chatModels.length === 0 ? ' disabled' : '') + '>' + modelOptions(chatModels, selectedChatModel) + '</select>' +
            '<button class="btn btn-sm" id="chat-clear">' + esc(t('playground.clear')) + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="chat-messages" id="chat-messages">' + msgsHTML + '</div>' +
        '<div class="chat-presets">' + presetBtns + '</div>' +
        '<div class="chat-input-row">' +
          '<input type="text" id="chat-input" placeholder="' + esc(t('playground.inputPlaceholder')) + '"' +
            (chatStreaming || chatModels.length === 0 ? ' disabled' : '') + '>' +
          '<button class="btn btn-primary" id="chat-send"' +
            (chatStreaming || chatModels.length === 0 ? ' disabled' : '') + '>' +
            (chatStreaming ? '<span class="spinner"></span> \u2026' : esc(t('playground.send'))) +
          '</button>' +
        '</div>' +
      '</div>';

    $('#chat-model').addEventListener('change', function () {
      selectedChatModel = this.value;
    });
    $('#chat-send').addEventListener('click', sendChat);
    $('#chat-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') sendChat();
    });
    $('#chat-clear').addEventListener('click', function () {
      chatMessages = [];
      renderChat(ct);
    });

    $$('.chat-preset-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.dataset.preset, 10);
        var input = $('#chat-input');
        if (input && chatPresets[idx]) {
          input.value = chatPresets[idx].text;
          input.focus();
        }
      });
    });

    var msgsEl = $('#chat-messages');
    if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function sendChat() {
    var input = $('#chat-input');
    var sendBtn = $('#chat-send');
    var msgsEl = $('#chat-messages');
    if (!input || !input.value.trim() || chatStreaming) return;
    if (!selectedChatModel) {
      showToast(t('playground.noChatModels'), 'error');
      return;
    }

    var msg = input.value.trim();
    input.value = '';
    chatStreaming = true;

    chatMessages.push({ role: 'user', content: msg });
    chatMessages.push({ role: 'assistant', content: '' });

    if (msgsEl) {
      msgsEl.innerHTML = chatMessages.map(function (m) {
        return '<div class="chat-message ' + m.role + '">' +
          '<div class="role">' + esc(roleLabel(m.role)) + '</div>' +
          '<div class="msg-content">' + esc(m.content || '\u2026') + '</div>' +
        '</div>';
      }).join('');
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }

    if (sendBtn) { sendBtn.disabled = true; sendBtn.innerHTML = '<span class="spinner"></span> \u2026'; }
    if (input) input.disabled = true;

    var model = $('#chat-model');
    var apiMsgs = chatMessages
      .filter(function (m) { return m.content; })
      .slice(0, -1)
      .concat([{ role: 'user', content: msg }]);

    activeStreamController = new AbortController();
    var gotFirstToken = false;

    loadingHintTimer = setTimeout(function () {
      loadingHintTimer = null;
      if (gotFirstToken) return;
      var allMsgs = $$('#chat-messages .msg-content');
      var lastEl = allMsgs[allMsgs.length - 1];
      if (lastEl) {
        lastEl.innerHTML = '<span class="spinner"></span> ' + esc(t('playground.modelLoading'));
      }
    }, 3000);

    ollamaFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: (model && model.value) || selectedChatModel || '',
        messages: apiMsgs,
      }),
      signal: activeStreamController.signal,
    }).then(function (res) {
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var lastMsg = chatMessages[chatMessages.length - 1];

      function pump() {
        return reader.read().then(function (result) {
          if (result.done) { activeStreamController = null; endChat(input, sendBtn); return; }
          if (!gotFirstToken) {
            gotFirstToken = true;
            if (loadingHintTimer) { clearTimeout(loadingHintTimer); loadingHintTimer = null; }
          }
          buffer += decoder.decode(result.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop();
          lines.forEach(function (line) {
            if (!line.trim()) return;
            try {
              var data = JSON.parse(line);
              if (data.message && data.message.content) {
                lastMsg.content += data.message.content;
                var allMsgs = $$('#chat-messages .msg-content');
                var lastEl = allMsgs[allMsgs.length - 1];
                if (lastEl) lastEl.textContent = lastMsg.content;
                if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
              }
            } catch (e) { /* skip */ }
          });
          return pump();
        });
      }
      return pump();
    }).catch(function (err) {
      activeStreamController = null;
      if (loadingHintTimer) { clearTimeout(loadingHintTimer); loadingHintTimer = null; }
      if (err.name === 'AbortError') return;
      chatMessages[chatMessages.length - 1].content = t('status.errorDetail', { message: err.message });
      var allMsgs = $$('#chat-messages .msg-content');
      var lastEl = allMsgs[allMsgs.length - 1];
      if (lastEl) lastEl.textContent = chatMessages[chatMessages.length - 1].content;
      endChat(input, sendBtn);
    });
  }

  function endChat(input, sendBtn) {
    chatStreaming = false;
    if (sendBtn) { sendBtn.disabled = false; sendBtn.innerHTML = esc(t('playground.send')); }
    if (input) { input.disabled = false; input.focus(); }
  }

  // ── Playground: Generate ──────────────────────────────────────

  function renderGenerate(ct) {
    if (!selectedGenerateModel || pgModels.indexOf(selectedGenerateModel) === -1) {
      selectedGenerateModel = pgModels[0] || '';
    }

    ct.innerHTML =
      '<div class="card">' +
        '<div class="card-header">' +
          '<h2>' + esc(t('generateTab.title')) + '</h2>' +
          '<select id="gen-model" style="width:auto;min-width:200px">' + modelOptions(pgModels, selectedGenerateModel) + '</select>' +
        '</div>' +
        '<div class="form-group">' +
          '<label>' + esc(t('generateTab.promptLabel')) + '</label>' +
          '<textarea id="gen-prompt" rows="3" placeholder="' + esc(t('generateTab.promptPlaceholder')) + '"></textarea>' +
        '</div>' +
        '<button class="btn btn-primary" id="gen-btn">' + esc(t('generateTab.generateBtn')) + '</button>' +
        '<div id="gen-output"></div>' +
      '</div>';

    $('#gen-model').addEventListener('change', function () {
      selectedGenerateModel = this.value;
    });
    $('#gen-btn').addEventListener('click', runGenerate);
  }

  function runGenerate() {
    var prompt = $('#gen-prompt');
    var model = $('#gen-model');
    var btn = $('#gen-btn');
    var output = $('#gen-output');
    if (!prompt || !prompt.value.trim()) return;
    if (btn && btn.disabled) return;

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> ' + esc(t('generateTab.generating'));
    output.innerHTML =
      '<div class="mt-2">' +
        '<p class="text-muted text-sm mb-1">' + esc(t('generateTab.outputLabel')) + '</p>' +
        '<div class="playground-output" id="gen-text"></div>' +
      '</div>';

    var textEl = $('#gen-text');
    var full = '';

    activeStreamController = new AbortController();
    var gotFirstToken = false;

    loadingHintTimer = setTimeout(function () {
      loadingHintTimer = null;
      if (gotFirstToken) return;
      if (textEl) textEl.innerHTML = '<span class="spinner"></span> ' + esc(t('playground.modelLoading'));
    }, 3000);

    ollamaFetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: (model && model.value) || selectedGenerateModel || pgModels[0] || '',
        prompt: prompt.value,
      }),
      signal: activeStreamController.signal,
    }).then(function (res) {
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      function pump() {
        return reader.read().then(function (result) {
          if (result.done) {
            activeStreamController = null;
            btn.disabled = false;
            btn.innerHTML = esc(t('generateTab.generateBtn'));
            return;
          }
          if (!gotFirstToken) {
            gotFirstToken = true;
            if (loadingHintTimer) { clearTimeout(loadingHintTimer); loadingHintTimer = null; }
          }
          buffer += decoder.decode(result.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop();
          lines.forEach(function (line) {
            if (!line.trim()) return;
            try {
              var data = JSON.parse(line);
              if (data.response) {
                full += data.response;
                if (textEl) textEl.textContent = full;
              }
            } catch (e) { /* skip */ }
          });
          return pump();
        });
      }
      return pump();
    }).catch(function (err) {
      activeStreamController = null;
      if (loadingHintTimer) { clearTimeout(loadingHintTimer); loadingHintTimer = null; }
      if (err.name === 'AbortError') return;
      if (textEl) textEl.textContent = t('status.errorDetail', { message: err.message });
      btn.disabled = false;
      btn.innerHTML = esc(t('generateTab.generateBtn'));
    });
  }

  // ── Configuration Tab ─────────────────────────────────────────

  var SETTING_GROUPS = [
    { titleKey: 'configGroups.branding', keys: {
      server_name: 'configLabels.serverName',
    }},
    { titleKey: 'configGroups.server', keys: {
      gateway_port: 'configLabels.gatewayPort',
      ollama_internal_port: 'configLabels.ollamaInternalPort',
      rate_limit_per_min: 'configLabels.rateLimitPerMin',
      rate_limit_burst: 'configLabels.rateLimitBurst',
      admin_enabled: 'configLabels.adminEnabled',
      shutdown_timeout_ms: 'configLabels.shutdownTimeoutMs',
    }},
    { titleKey: 'configGroups.requestLimits', keys: {
      max_request_body_bytes: 'configLabels.maxRequestBodyBytes',
      max_batch_size: 'configLabels.maxBatchSize',
      ollama_timeout_ms: 'configLabels.ollamaTimeoutMs',
      max_concurrent_requests: 'configLabels.maxConcurrentRequests',
      max_queue_size: 'configLabels.maxQueueSize',
    }},
    { titleKey: 'configGroups.ollama', keys: {
      ollama_models: 'configLabels.ollamaModels',
      default_embed_model: 'configLabels.defaultEmbedModel',
      embed_dimensions: 'configLabels.embedDimensions',
      ollama_num_parallel: 'configLabels.ollamaNumParallel',
      ollama_max_loaded_models: 'configLabels.ollamaMaxLoadedModels',
      ollama_keep_alive: 'configLabels.ollamaKeepAlive',
    }},
    { titleKey: 'configGroups.health', keys: {
      health_port: 'configLabels.healthPort',
      health_warmup: 'configLabels.healthWarmup',
    }},
    { titleKey: 'configGroups.data', keys: {
      log_retention_days: 'configLabels.logRetentionDays',
    }},
  ];

  var DANGEROUS_KEYS = [
    'gateway_port', 'ollama_internal_port', 'admin_enabled',
    'rate_limit_per_min', 'max_concurrent_requests', 'max_queue_size',
    'shutdown_timeout_ms',
  ];

  function initConfig(ct) {
    ct.innerHTML = '<div class="empty-state"><span class="spinner"></span> ' + esc(t('status.loading')) + '</div>';

    Promise.all([apiJSON('/config'), apiJSON('/settings').catch(function () { return { settings: [] }; })])
      .then(function (results) {
        var c = results[0];
        var settingsData = results[1].settings || [];
        var settingsMap = {};
        settingsData.forEach(function (s) { settingsMap[s.key] = s.value; });

        configOriginal = {};
        SETTING_GROUPS.forEach(function (group) {
          Object.keys(group.keys).forEach(function (key) {
            configOriginal[key] = settingsMap[key] != null ? settingsMap[key] : '';
          });
        });

        Object.keys(configDirty).forEach(function (key) {
          if (configDirty[key] === configOriginal[key]) delete configDirty[key];
        });

        var groupsHTML = SETTING_GROUPS.map(function (group) {
          var rows = Object.keys(group.keys).map(function (key) {
            var labelKey = group.keys[key];
            var isDirty = configDirty[key] != null;
            var val = isDirty ? configDirty[key] : configOriginal[key];
            var dangerHint = DANGEROUS_KEYS.indexOf(key) !== -1 ? ' title="Changing this may affect server availability"' : '';
            return '<div class="config-item" data-setting-key="' + esc(key) + '">' +
              '<span class="key"' + dangerHint + '>' + esc(t(labelKey)) +
                (DANGEROUS_KEYS.indexOf(key) !== -1 ? ' <span class="danger-icon">\u26A0</span>' : '') +
              '</span>' +
              '<span class="value">' +
                '<input type="text" class="setting-input' + (isDirty ? ' dirty' : '') + '" value="' + esc(val) + '">' +
              '</span>' +
            '</div>';
          }).join('');
          return '<div class="card config-group config-card">' +
            '<div class="card-header">' +
              '<h3>' + esc(t(group.titleKey)) + '</h3>' +
            '</div>' +
            '<div class="card-body">' +
              rows +
            '</div>' +
          '</div>';
        }).join('');

        var securityHTML =
          '<div class="card config-group">' +
            '<h3>' + esc(t('configGroups.security')) + '</h3>' +
            '<div class="config-item">' +
              '<span class="key">' + esc(t('security.apiKeyConfigured')) + '</span>' +
              '<span class="value">' + (c.security.api_key_set
                ? '<span class="badge badge-success">' + esc(t('security.yes')) + '</span>'
                : '<span class="badge badge-error">' + esc(t('security.no')) + '</span>') +
              '</span>' +
            '</div>' +
            '<div class="apikey-manage" id="apikey-section">' +
              '<div class="config-item">' +
                '<span class="key">' + esc(t('apiKey.currentKey')) + '</span>' +
                '<span class="value apikey-value-row">' +
                  '<code class="apikey-masked" id="apikey-masked">' + esc(t('status.loading')) + '</code>' +
                  '<button class="btn btn-sm" id="apikey-copy" title="' + esc(t('apiKey.copyTooltip')) + '">' + esc(t('apiKey.copy')) + '</button>' +
                '</span>' +
              '</div>' +
              '<div class="config-item">' +
                '<span class="key">' + esc(t('apiKey.regenerateLabel')) + ' <span class="danger-icon">\u26A0</span></span>' +
                '<span class="value">' +
                  '<button class="btn btn-sm btn-danger" id="apikey-regen">' + esc(t('apiKey.regenerate')) + '</button>' +
                '</span>' +
              '</div>' +
              '<div id="apikey-status" class="text-sm mt-1"></div>' +
            '</div>' +
            '<div class="config-item">' +
              '<span class="key">' + esc(t('security.adminKeyConfigured')) + '</span>' +
              '<span class="value">' + (c.security.admin_api_key_set
                ? '<span class="badge badge-success">' + esc(t('security.yes')) + '</span>'
                : '<span class="badge badge-info">' + esc(t('security.usingApiKey')) + '</span>') +
              '</span>' +
            '</div>' +
            '<div class="config-item">' +
              '<span class="key">' + esc(t('security.qdrantKeyConfigured')) + '</span>' +
              '<span class="value">' + (c.security.qdrant_api_key_set
                ? '<span class="badge badge-success">' + esc(t('security.yes')) + '</span>'
                : '<span class="badge badge-error">' + esc(t('security.no')) + '</span>') +
              '</span>' +
            '</div>' +
            (c.security.qdrant_api_key_set
              ? '<div class="apikey-manage" id="qdrantkey-section">' +
                  '<div class="config-item">' +
                    '<span class="key">' + esc(t('qdrantKey.currentKey')) + '</span>' +
                    '<span class="value apikey-value-row">' +
                      '<code class="apikey-masked" id="qdrantkey-masked">' + esc(t('status.loading')) + '</code>' +
                    '</span>' +
                  '</div>' +
                '</div>'
              : '') +
          '</div>';

        // Enhanced Security section (Tier 2 Bearer Tokens)
        var enhancedSecHTML =
          '<div class="card config-group" id="enhanced-security-card">' +
            '<div class="enhanced-security-header">' +
              '<h3>' + esc(t('enhancedSecurity.title')) + '</h3>' +
              '<label class="toggle-switch">' +
                '<input type="checkbox" id="enhanced-security-toggle"' + (enhancedSecurityEnabled ? ' checked' : '') + '>' +
                '<span class="toggle-track"><span class="toggle-thumb"></span></span>' +
                '<span class="toggle-label">' + esc(t('enhancedSecurity.toggle')) + '</span>' +
              '</label>' +
            '</div>' +
            '<p class="enhanced-security-description">' + esc(t('enhancedSecurity.description')) + '</p>' +
            '<div id="bearer-tokens-section"' + (enhancedSecurityEnabled ? '' : ' style="display:none"') + '></div>' +
          '</div>';

        // SaaS Connection section (Tier 3 Auth0 JWT) — rendered below
        var saasHTML = '<div id="saas-connection-card"></div>';

        // Mesh Connection section — rendered below
        var meshHTML = '<div id="mesh-connection-card"></div>';
        var pricingHTML = '<div id="model-pricing-card"></div>';

        var utilitiesHTML = '<div class="card config-group">' +
          '<h3>' + esc(t('admin.utilities')) + '</h3>' +
          '<div class="mesh-actions">' +
            '<button class="btn btn-sm btn-warning" id="restart-holler-btn">' + esc(t('admin.restartHoller')) + '</button>' +
            '<button class="btn btn-sm" id="restart-ollama-btn">' + esc(t('admin.restartOllama')) + '</button>' +
          '</div>' +
        '</div>';

        ct.innerHTML =
          '<div class="config-grid">' +
            groupsHTML +
          '</div>' +
          '<div class="config-sections">' +
            securityHTML +
            enhancedSecHTML +
            saasHTML +
            meshHTML +
            pricingHTML +
            utilitiesHTML +
          '</div>' +
          '<div id="setting-status" class="text-sm mt-1"></div>' +
          '<p class="text-muted text-sm mt-2">' + esc(t('configuration.restartNote')) + '</p>';

        loadApiKeyMasked();

        $$('.setting-input').forEach(function (input) {
          var row = input.closest('[data-setting-key]');
          if (!row) return;
          var key = row.dataset.settingKey;
          input.addEventListener('input', function () {
            if (input.value === configOriginal[key]) {
              delete configDirty[key];
              input.classList.remove('dirty');
            } else {
              configDirty[key] = input.value;
              input.classList.add('dirty');
            }
            updateHeaderSaveButton();
          });
        });

        var copyBtn = $('#apikey-copy');
        if (copyBtn) copyBtn.addEventListener('click', copyApiKey);

        if ($('#qdrantkey-masked')) {
          loadQdrantKeyMasked();
        }

        var regenBtn = $('#apikey-regen');
        if (regenBtn) regenBtn.addEventListener('click', confirmRegenerateApiKey);

        // Enhanced Security toggle
        var secToggle = $('#enhanced-security-toggle');
        if (secToggle) {
          secToggle.addEventListener('change', function () {
            var enabled = secToggle.checked;
            api('/settings', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key: 'enhanced_security_enabled', value: String(enabled) }),
            }).then(function () {
              enhancedSecurityEnabled = enabled;
              var tokensSec = $('#bearer-tokens-section');
              if (tokensSec) tokensSec.style.display = enabled ? '' : 'none';
              if (enabled) loadBearerTokens();
            });
          });
        }

        // Load auth status (triggers loadBearerTokens when enabled)
        loadAuthStatus();

        // Load mesh connection status
        loadMeshStatus();
        loadModelPricingEditor();

        // Restart buttons
        var restartHollerBtn = $('#restart-holler-btn');
        if (restartHollerBtn) {
          restartHollerBtn.addEventListener('click', function () {
            if (!confirm(t('admin.restartConfirm') || 'Restart the Holler server? It will be briefly unavailable.')) return;
            restartHollerBtn.disabled = true;
            restartHollerBtn.textContent = t('admin.restarting') || 'Restarting...';
            api('/restart', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ target: 'holler' }),
            }).catch(function () {});
            setTimeout(function () { location.reload(); }, 5000);
          });
        }

        var restartOllamaBtn = $('#restart-ollama-btn');
        if (restartOllamaBtn) {
          restartOllamaBtn.addEventListener('click', function () {
            if (!confirm(t('admin.restartOllamaConfirm') || 'Restart Ollama? Models will briefly be unavailable.')) return;
            restartOllamaBtn.disabled = true;
            restartOllamaBtn.textContent = t('admin.restarting') || 'Restarting...';
            api('/restart', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ target: 'ollama' }),
            }).catch(function () {});
            setTimeout(function () {
              restartOllamaBtn.disabled = false;
              restartOllamaBtn.textContent = t('admin.restartOllama');
            }, 10000);
          });
        }

        updateHeaderSaveButton();
      }).catch(function () {
        ct.innerHTML = '<div class="empty-state">' + esc(t('configuration.loadError')) + '</div>';
      });
  }

  function loadModelPricingEditor() {
    var card = $('#model-pricing-card');
    if (!card) return;
    Promise.all([
      apiJSON('/models').catch(function () { return { models: [] }; }),
      apiJSON('/stats/pricing').catch(function () { return { pricing: [] }; }),
    ]).then(function (result) {
      var models = (result[0].models || []).map(function (m) { return m.name; });
      var pricing = result[1].pricing || [];
      var byModel = {};
      pricing.forEach(function (p) { byModel[p.model] = p; });

      var rows = models.map(function (name) {
        var p = byModel[name] || {};
        var inV = p.moonshine_input_per_1k != null ? p.moonshine_input_per_1k : '';
        var outV = p.moonshine_output_per_1k != null ? p.moonshine_output_per_1k : '';
        return '<tr>' +
          '<td class="mono">' + esc(name) + '</td>' +
          '<td><input type="number" step="0.01" class="setting-input" data-price-in="' + esc(name) + '" value="' + esc(inV) + '"></td>' +
          '<td><input type="number" step="0.01" class="setting-input" data-price-out="' + esc(name) + '" value="' + esc(outV) + '"></td>' +
          '<td><button class="btn btn-sm btn-save" data-price-save="' + esc(name) + '">Save</button></td>' +
        '</tr>';
      }).join('');

      card.innerHTML =
        '<div class="card config-group">' +
          '<h3>Moonshine Pricing (per model)</h3>' +
          '<div class="table-wrapper"><table>' +
            '<thead><tr><th>Model</th><th>Input (\uD83E\uDD43 / 1K)</th><th>Output (\uD83E\uDD43 / 1K)</th><th>Action</th></tr></thead>' +
            '<tbody>' + (rows || '<tr><td colspan="4" class="text-muted">No models available</td></tr>') + '</tbody>' +
          '</table></div>' +
        '</div>';

      card.querySelectorAll('[data-price-save]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var model = btn.dataset.priceSave;
          var inEl = card.querySelector('[data-price-in="' + model.replace(/"/g, '\\"') + '"]');
          var outEl = card.querySelector('[data-price-out="' + model.replace(/"/g, '\\"') + '"]');
          var inV2 = parseFloat((inEl && inEl.value) || '0');
          var outRaw = outEl ? outEl.value : '';
          var outV2 = outRaw === '' ? null : parseFloat(outRaw);
          if (!Number.isFinite(inV2) || (outV2 != null && !Number.isFinite(outV2))) return;
          api('/stats/pricing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: model,
              input_per_1k: inV2,
              output_per_1k: outV2,
            }),
          }).then(function () {
            showToast('Saved pricing for ' + model, 'success');
          }).catch(function () {
            showToast('Failed to save pricing', 'error');
          });
        });
      });
    }).catch(function () {
      card.innerHTML = '';
    });
  }

  function saveConfig() {
    var changes = Object.keys(configDirty).map(function (key) {
      return { key: key, value: configDirty[key] };
    });
    if (changes.length === 0) return;

    var hasDangerous = changes.some(function (c) {
      return DANGEROUS_KEYS.indexOf(c.key) !== -1;
    });

    if (hasDangerous) {
      showDangerConfirm(function () { doSaveConfig(changes); });
    } else {
      doSaveConfig(changes);
    }
  }

  function doSaveConfig(changes) {
    var btn = $('#header-save-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> ' + esc(t('configuration.saving')); }

    api('/settings/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: changes }),
    }).then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.success) {
          changes.forEach(function (c) { configOriginal[c.key] = c.value; });
          configDirty = {};

          $$('.setting-input.dirty').forEach(function (el) { el.classList.remove('dirty'); });

          var statusEl = $('#setting-status');
          if (statusEl) {
            statusEl.textContent = t('configuration.saveSuccess');
            statusEl.style.color = '#4ade80';
            setTimeout(function () { if (statusEl) statusEl.textContent = ''; }, 4000);
          }

          var nameChange = changes.find(function (c) { return c.key === 'server_name'; });
          if (nameChange) {
            state.serverName = nameChange.value;
            var brandEl = $('.brand');
            if (brandEl) {
              brandEl.innerHTML = '<img src="/admin/assets/logo.png" class="brand-icon" alt="">' +
                esc(state.serverName) + ' <span>' + esc(t('header.admin')) + '</span>';
            }
          }
        } else {
          var statusEl2 = $('#setting-status');
          if (statusEl2) {
            statusEl2.textContent = t('configuration.saveError');
            statusEl2.style.color = '#f87171';
          }
        }
        if (btn) { btn.disabled = false; btn.textContent = t('configuration.save'); }
        updateHeaderSaveButton();
      })
      .catch(function () {
        var statusEl = $('#setting-status');
        if (statusEl) {
          statusEl.textContent = t('configuration.saveConnectionError');
          statusEl.style.color = '#f87171';
        }
        if (btn) { btn.disabled = false; btn.textContent = t('configuration.save'); }
        updateHeaderSaveButton();
      });
  }

  function showDangerConfirm(callback) {
    var confirmWord = t('configuration.dangerConfirmPlaceholder');
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-dialog danger-dialog">' +
        '<h3>' + t('configuration.dangerConfirmTitle') + '</h3>' +
        '<p>' + t('configuration.dangerConfirmMessage', { word: 'hellyeah' }) + '</p>' +
        '<div class="form-group">' +
          '<input type="text" id="danger-input" placeholder="' + esc(confirmWord) + '" autocomplete="off" spellcheck="false">' +
        '</div>' +
        '<div class="confirm-actions">' +
          '<button class="btn" id="danger-cancel">' + esc(t('configuration.cancel')) + '</button>' +
          '<button class="btn btn-danger" id="danger-confirm" disabled>' + esc(t('configuration.confirm')) + '</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    var close = function () { overlay.remove(); };
    var cancelBtn = overlay.querySelector('#danger-cancel');
    var confirmBtn = overlay.querySelector('#danger-confirm');
    var input = overlay.querySelector('#danger-input');

    function revertAll() {
      configDirty = {};
      $$('.setting-input').forEach(function (el) {
        var row = el.closest('[data-setting-key]');
        if (row) el.value = configOriginal[row.dataset.settingKey] || '';
        el.classList.remove('dirty');
      });
      updateHeaderSaveButton();
      var statusEl = $('#setting-status');
      if (statusEl) {
        statusEl.textContent = t('configuration.changesReverted');
        statusEl.style.color = '#94a3b8';
        setTimeout(function () { if (statusEl) statusEl.textContent = ''; }, 3000);
      }
      close();
    }

    cancelBtn.addEventListener('click', revertAll);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) revertAll();
    });

    input.addEventListener('input', function () {
      confirmBtn.disabled = input.value.trim().toLowerCase() !== 'hellyeah';
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !confirmBtn.disabled) {
        close();
        callback();
      }
    });

    confirmBtn.addEventListener('click', function () {
      close();
      callback();
    });

    input.focus();
  }

  // ── API Key Management ────────────────────────────────────────

  var cachedFullKey = null;

  function loadApiKeyMasked() {
    apiJSON('/apikey').then(function (data) {
      var el = $('#apikey-masked');
      if (el) el.textContent = data.masked || '****';
    }).catch(function () {
      var el = $('#apikey-masked');
      if (el) el.textContent = '****';
    });
  }

  function copyApiKey() {
    var btn = $('#apikey-copy');
    var raw = cachedFullKey || state.apiKey;
    copyToClipboard('JIMBOMESH_HOLLER_API_KEY=' + raw, btn);
  }

  function loadQdrantKeyMasked() {
    apiJSON('/qdrantkey').then(function (data) {
      var el = $('#qdrantkey-masked');
      if (el) el.textContent = data.masked || '****';
    }).catch(function () {
      var el = $('#qdrantkey-masked');
      if (el) el.textContent = '****';
    });
  }

  function copyToClipboard(text, btn) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        showCopyFeedback(btn);
      }).catch(function () {
        fallbackCopy(text);
        showCopyFeedback(btn);
      });
    } else {
      fallbackCopy(text);
      showCopyFeedback(btn);
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* noop */ }
    document.body.removeChild(ta);
  }

  function showCopyFeedback(btn) {
    if (!btn) return;
    var orig = btn.textContent;
    btn.textContent = t('apiKey.copied');
    btn.classList.add('btn-success-flash');
    setTimeout(function () {
      btn.textContent = orig;
      btn.classList.remove('btn-success-flash');
    }, 2000);
  }

  function confirmRegenerateApiKey() {
    showDangerConfirmApiKey(function () {
      var regenBtn = $('#apikey-regen');
      if (regenBtn) { regenBtn.disabled = true; regenBtn.innerHTML = '<span class="spinner"></span> ' + esc(t('apiKey.regenerating')); }

      api('/apikey/regenerate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'hellyeah' }),
      }).then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.success) {
            cachedFullKey = data.key;
            state.apiKey = data.key;
            sessionStorage.setItem('admin_api_key', data.key);

            var maskedEl = $('#apikey-masked');
            if (maskedEl) maskedEl.textContent = data.masked;

            showNewKeyDialog(data.key);
          } else {
            var statusEl = $('#apikey-status');
            if (statusEl) {
              statusEl.textContent = t('apiKey.regenError');
              statusEl.style.color = '#f87171';
            }
          }
          if (regenBtn) { regenBtn.disabled = false; regenBtn.innerHTML = esc(t('apiKey.regenerate')); }
        })
        .catch(function (err) {
          var statusEl = $('#apikey-status');
          if (statusEl) {
            statusEl.textContent = t('status.errorDetail', { message: err.message });
            statusEl.style.color = '#f87171';
          }
          if (regenBtn) { regenBtn.disabled = false; regenBtn.innerHTML = esc(t('apiKey.regenerate')); }
        });
    });
  }

  function showDangerConfirmApiKey(callback) {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-dialog danger-dialog">' +
        '<h3>' + t('apiKey.regenConfirmTitle') + '</h3>' +
        '<p>' + t('apiKey.regenConfirmMessage') + '</p>' +
        '<div class="form-group">' +
          '<input type="text" id="apikey-danger-input" placeholder="' + esc(t('configuration.dangerConfirmPlaceholder')) + '" autocomplete="off" spellcheck="false">' +
        '</div>' +
        '<div class="confirm-actions">' +
          '<button class="btn" id="apikey-danger-cancel">' + esc(t('configuration.cancel')) + '</button>' +
          '<button class="btn btn-danger" id="apikey-danger-confirm" disabled>' + esc(t('configuration.confirm')) + '</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    var close = function () { overlay.remove(); };
    var cancelBtn = overlay.querySelector('#apikey-danger-cancel');
    var confirmBtn = overlay.querySelector('#apikey-danger-confirm');
    var input = overlay.querySelector('#apikey-danger-input');

    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });

    input.addEventListener('input', function () {
      confirmBtn.disabled = input.value.trim().toLowerCase() !== 'hellyeah';
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !confirmBtn.disabled) {
        close();
        callback();
      }
    });

    confirmBtn.addEventListener('click', function () {
      close();
      callback();
    });

    input.focus();
  }

  function showNewKeyDialog(newKey) {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-dialog newkey-dialog">' +
        '<h3>' + esc(t('apiKey.newKeyTitle')) + '</h3>' +
        '<p>' + esc(t('apiKey.newKeyMessage')) + '</p>' +
        '<div class="newkey-display">' +
          '<code id="newkey-value">' + esc(newKey) + '</code>' +
          '<button class="btn btn-sm" id="newkey-copy">' + esc(t('apiKey.copy')) + '</button>' +
        '</div>' +
        '<p class="text-muted text-sm">' + esc(t('apiKey.newKeyEnvHint')) + '</p>' +
        '<div class="confirm-actions">' +
          '<button class="btn btn-primary" id="newkey-dismiss">' + esc(t('apiKey.understood')) + '</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    var dismissBtn = overlay.querySelector('#newkey-dismiss');
    var copyBtn = overlay.querySelector('#newkey-copy');

    copyBtn.addEventListener('click', function () {
      copyToClipboard('JIMBOMESH_HOLLER_API_KEY=' + newKey, copyBtn);
    });

    dismissBtn.addEventListener('click', function () { overlay.remove(); });
  }

  // ── Bearer Token Management ──────────────────────────────────

  function renderUsageSparkline(hourlyData) {
    // Build 24-point array from hourly_usage, fill missing with 0
    var now = new Date();
    var points = [];
    for (var i = 23; i >= 0; i--) {
      var d = new Date(now.getTime() - i * 3600000);
      var key = d.toISOString().slice(0, 13);
      points.push(hourlyData[key] || 0);
    }
    var max = Math.max.apply(null, points) || 1;
    var w = 80, h = 20;
    var coords = points.map(function (v, idx) {
      return (idx * (w / 23)).toFixed(1) + ',' + (h - (v / max) * h).toFixed(1);
    }).join(' ');
    return '<svg class="sparkline" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
      '<polyline fill="none" stroke="var(--accent)" stroke-width="1.5" points="' + coords + '"/>' +
    '</svg>';
  }

  function loadAuthStatus() {
    apiJSON('/auth/status').then(function (data) {
      enhancedSecurityEnabled = data.tier2.enabled;
      var toggle = $('#enhanced-security-toggle');
      if (toggle) toggle.checked = enhancedSecurityEnabled;
      var tokensSec = $('#bearer-tokens-section');
      if (tokensSec) tokensSec.style.display = enhancedSecurityEnabled ? '' : 'none';
      if (enhancedSecurityEnabled) loadBearerTokens();

      // SaaS Connection section
      var saasCard = $('#saas-connection-card');
      if (saasCard && data.tier3.configured) {
        saasCard.innerHTML =
          '<div class="card config-group">' +
            '<h3>' + esc(t('saasConnection.title')) + '</h3>' +
            '<p class="enhanced-security-description">' + esc(t('saasConnection.description')) + '</p>' +
            '<div class="config-item">' +
              '<span class="key">Status</span>' +
              '<span class="value saas-status">' +
                '<span class="saas-status-dot connected"></span>' +
                '<span class="badge badge-success">' + esc(t('saasConnection.connected')) + '</span>' +
              '</span>' +
            '</div>' +
            '<div class="config-item">' +
              '<span class="key">' + esc(t('saasConnection.domain')) + '</span>' +
              '<span class="value">' + esc(data.tier3.domain || '') + '</span>' +
            '</div>' +
            '<div class="config-item">' +
              '<span class="key">' + esc(t('saasConnection.audience')) + '</span>' +
              '<span class="value">' + esc(data.tier3.audience || '') + '</span>' +
            '</div>' +
          '</div>';
      }
    }).catch(function () { /* ignore auth status errors */ });
  }

  // ── Mesh Connection ─────────────────────────────────────────────

  var meshRefreshInterval = null;
  var _meshLastState = null;
  var _meshLastLogLen = 0;
  var _meshLastLogTail = '';

  function meshLogTailSignature(entries) {
    if (!entries || entries.length === 0) return '';
    var last = entries[entries.length - 1] || {};
    return String(last.time || '') + '|' + String(last.type || '') + '|' + String(last.message || '');
  }

  function loadMeshStatus() {
    apiJSON('/mesh/status').then(function (data) {
      renderMeshCard(data);
    }).catch(function () {
      renderMeshCard({ state: 'disconnected', connected: false, connecting: false, mode: 'off-grid', log: [] });
    });
  }

  function renderMeshLog(entries) {
    if (!entries || entries.length === 0) {
      return '<div class="mesh-log"><div class="mesh-log-empty">' + esc(t('mesh.logEmpty')) + '</div></div>';
    }
    return '<div class="mesh-log" id="mesh-log">' +
      entries.map(function (entry) {
        var d = new Date(entry.time);
        var time = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
        return '<div class="mesh-log-entry">' +
          '<span class="mesh-log-time">[' + time + ']</span>' +
          '<span class="mesh-log-' + (entry.type || 'info') + '">' + esc(entry.message) + '</span>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  function meshScrollLog() {
    var logEl = $('#mesh-log');
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  }

  function meshAppendLogEntries(entries, fromIndex) {
    var logEl = $('#mesh-log');
    if (!logEl) return;
    // Remove empty placeholder if present
    var empty = logEl.querySelector('.mesh-log-empty');
    if (empty) empty.remove();
    for (var i = fromIndex; i < entries.length; i++) {
      var entry = entries[i];
      var d = new Date(entry.time);
      var time = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
      var div = document.createElement('div');
      div.className = 'mesh-log-entry';
      div.innerHTML = '<span class="mesh-log-time">[' + time + ']</span>' +
        '<span class="mesh-log-' + (entry.type || 'info') + '">' + esc(entry.message) + '</span>';
      logEl.appendChild(div);
    }
    logEl.scrollTop = logEl.scrollHeight;
  }

  function meshGetStateBadge(meshState) {
    var dotClass = meshState || 'disconnected';
    var badgeMap = {
      disconnected: { cls: 'badge-error', key: 'mesh.statusDisconnected' },
      connecting:   { cls: 'badge-warning', key: 'mesh.statusConnecting' },
      connected:    { cls: 'badge-success', key: 'mesh.statusConnected' },
      error:        { cls: 'badge-error', key: 'mesh.statusError' },
      reconnecting: { cls: 'badge-warning', key: 'mesh.statusReconnecting' },
    };
    var badge = badgeMap[meshState] || badgeMap.disconnected;
    return '<span class="saas-status">' +
      '<span class="mesh-state-dot ' + dotClass + '"></span>' +
      '<span class="badge ' + badge.cls + '">' + esc(t(badge.key)) + '</span>' +
    '</span>';
  }

  function renderMeshCard(data) {
    var card = $('#mesh-connection-card');
    if (!card) return;

    // Resolve state from new enum or legacy booleans
    var meshState = data.state || (data.connected ? 'connected' : (data.connecting ? 'connecting' : 'disconnected'));
    var logEntries = data.log || [];

    // Clear any existing refresh interval
    if (meshRefreshInterval) { clearInterval(meshRefreshInterval); meshRefreshInterval = null; }

    // Track for incremental updates
    _meshLastState = meshState;
    _meshLastLogLen = logEntries.length;
    _meshLastLogTail = meshLogTailSignature(logEntries);

    var html = '<div class="card config-group">';

    // ── Header: Title + Status Badge ──
    html += '<h3>' + esc(t('mesh.title')) + '</h3>';
    html += '<div class="config-item">' +
      '<span class="key">Status</span>' +
      '<span class="value">' + meshGetStateBadge(meshState) + '</span>' +
    '</div>';

    // ── Portal Banner (disconnected + no saved key) ──
    if (meshState === 'disconnected') {
      html += '<div class="mesh-portal-banner">' +
        '<div>' +
          '<div class="mesh-portal-banner-title">\uD83E\uDD43 ' + esc(t('mesh.portalTitle')) + '</div>' +
          '<div class="mesh-portal-banner-text">' + esc(t('mesh.portalText')) + '</div>' +
          '<a href="https://app.jimbomesh.ai" target="_blank">' + esc(t('mesh.portalLink')) + ' \u2192</a>' +
        '</div>' +
      '</div>';
    }

    // ── Error message ──
    if (meshState === 'error' && data.errorMessage) {
      html += '<div style="color:var(--error);font-size:0.8125rem;margin:0.25rem 0">' + esc(data.errorMessage) + '</div>';
    }

    // ── Config fields (disconnected / error) ──
    if (meshState === 'disconnected' || meshState === 'error') {
      var urlVal = data.meshUrl || 'https://api.jimbomesh.ai';
      var nameVal = data.hollerName || '';
      var autoChecked = data.autoConnect ? ' checked' : '';
      var hasStoredKey = !!data.hasStoredMeshKey;

      if (!hasStoredKey || meshState === 'error') {
        html += '<div class="config-item">' +
          '<span class="key">' + esc(t('mesh.coordinatorUrl')) + '</span>' +
          '<span class="value"><input type="text" class="setting-input" id="mesh-url-input" value="' + esc(urlVal) + '"></span>' +
        '</div>';
        html += '<div class="config-item">' +
          '<span class="key">' + esc(t('mesh.apiKey')) + '</span>' +
          '<span class="value"><input type="password" class="setting-input" id="mesh-key-input" placeholder="' + esc(t('mesh.apiKeyPlaceholder')) + '">' +
          '<small class="field-hint">' + esc(t('mesh.apiKeyHint')) + '</small></span>' +
        '</div>';
        html += '<div class="config-item">' +
          '<span class="key">' + esc(t('mesh.hollerName')) + '</span>' +
          '<span class="value"><input type="text" class="setting-input" id="mesh-name-input" placeholder="' + esc(t('mesh.hollerNamePlaceholder')) + '" value="' + esc(nameVal) + '"></span>' +
        '</div>';
        html += '<div class="config-item">' +
          '<span class="key">' + esc(t('mesh.autoConnect')) + '</span>' +
          '<span class="value"><label class="mesh-toggle"><input type="checkbox" id="mesh-auto-connect"' + autoChecked + '> ' + esc(t('mesh.autoConnect')) + '</label></span>' +
        '</div>';
      } else {
        html += '<div style="color:var(--text-secondary);font-size:0.8125rem;margin:0.25rem 0">' +
          esc(t('mesh.coordinatorUrl')) + ': ' + esc(urlVal) +
        '</div>';
        html += '<div class="config-item">' +
          '<span class="key">' + esc(t('mesh.autoConnect')) + '</span>' +
          '<span class="value"><label class="mesh-toggle"><input type="checkbox" id="mesh-auto-connect"' + autoChecked + '> ' + esc(t('mesh.autoConnect')) + '</label></span>' +
        '</div>';
      }
    }

    // ── Connected info ──
    if (meshState === 'connected' || meshState === 'reconnecting') {
      var lastHb = '\u2014';
      if (data.lastHeartbeat) {
        var ago = Math.round((Date.now() - data.lastHeartbeat) / 1000);
        lastHb = ago < 60 ? t('mesh.secondsAgo', { seconds: ago }) : t('mesh.minutesAgo', { minutes: Math.round(ago / 60) });
      }

      html += '<div class="config-item">' +
        '<span class="key">' + esc(t('mesh.hollerId')) + '</span>' +
        '<span class="value"><code>' + esc(data.hollerId || '') + '</code></span>' +
      '</div>';
      html += '<div class="config-item">' +
        '<span class="key">' + esc(t('mesh.lastHeartbeat')) + '</span>' +
        '<span class="value" id="mesh-last-hb">' + esc(lastHb) + '</span>' +
      '</div>';
      html += '<div class="config-item">' +
        '<span class="key">' + esc(t('mesh.jobsProcessed')) + '</span>' +
        '<span class="value">' + (data.jobsProcessed || 0) + '</span>' +
      '</div>';
      html += '<div class="config-item">' +
        '<span class="key">' + esc(t('mesh.moonshineEarned')) + '</span>' +
        '<span class="value">' + (data.moonshineEarned || 0) + '</span>' +
      '</div>';
      html += '<div class="config-item">' +
        '<span class="key">' + esc(t('mesh.connectionMode')) + '</span>' +
        '<span class="value">' +
          (data.peerConnections && data.peerConnections.activeConnections > 0
            ? '<span class="badge badge-success">' + esc(t('mesh.modeWebrtc')) + '</span>'
            : '<span class="badge">' + esc(t('mesh.modePolling')) + '</span>') +
        '</span>' +
      '</div>';
      if (data.hasStoredMeshKey) {
        html += '<div class="config-item">' +
          '<span class="key">' + esc(t('mesh.autoConnect')) + '</span>' +
          '<span class="value"><label class="mesh-toggle"><input type="checkbox" id="mesh-auto-connect"' + (data.autoConnect ? ' checked' : '') + '> ' + esc(t('mesh.autoConnect')) + '</label></span>' +
        '</div>';
      }

      if (meshState === 'reconnecting') {
        var attemptNum = data.reconnectAttempt || 0;
        var retryText = '\u2014';
        if (data.nextReconnectAt) {
          var retrySeconds = Math.max(0, Math.ceil((data.nextReconnectAt - Date.now()) / 1000));
          retryText = retrySeconds + 's';
        }
        html += '<div class="config-item">' +
          '<span class="key">Reconnect Attempt</span>' +
          '<span class="value" id="mesh-reconnect-attempt">' + attemptNum + '</span>' +
        '</div>';
        html += '<div class="config-item">' +
          '<span class="key">Next Retry</span>' +
          '<span class="value" id="mesh-next-retry">' + retryText + '</span>' +
        '</div>';
      }

      // Peer connections table
      if (data.peerConnections && data.peerConnections.jobs && data.peerConnections.jobs.length > 0) {
        html += '<div style="margin-top:0.5rem">' +
          '<h4 style="margin:0.5rem 0;font-size:0.85rem;color:var(--text-secondary)">' +
            esc(t('mesh.peerConnections')) + ' (' + data.peerConnections.activeConnections + '/' + data.peerConnections.maxConnections + ')' +
          '</h4>' +
          '<div class="table-scroll"><table>' +
            '<thead><tr>' +
              '<th>' + esc(t('mesh.peerJob')) + '</th>' +
              '<th>' + esc(t('mesh.peerModel')) + '</th>' +
              '<th>' + esc(t('mesh.peerState')) + '</th>' +
              '<th>' + esc(t('mesh.peerDuration')) + '</th>' +
            '</tr></thead>' +
            '<tbody>' +
              data.peerConnections.jobs.map(function (p) {
                var stateClass = p.state === 'streaming' ? 'badge-success' : (p.state === 'connected' ? 'badge-success' : 'badge-warning');
                var durS = Math.round((Date.now() - p.startedAt) / 1000);
                var dur = durS < 60 ? durS + 's' : Math.round(durS / 60) + 'm';
                return '<tr>' +
                  '<td class="mono">' + esc((p.jobId || '').slice(0, 12)) + '</td>' +
                  '<td>' + esc(p.model || '') + '</td>' +
                  '<td><span class="badge ' + stateClass + '">' + esc(p.state) + '</span></td>' +
                  '<td>' + esc(dur) + '</td>' +
                '</tr>';
              }).join('') +
            '</tbody>' +
          '</table></div>' +
        '</div>';
      }
    }

    // ── Status Log ──
    html += renderMeshLog(logEntries);

    // ── Action Buttons ──
    html += '<div class="mesh-actions">';

    if (meshState === 'disconnected') {
      if (data.hasStoredMeshKey) {
        html += '<button class="btn btn-sm btn-primary" id="mesh-quick-connect-btn">' + esc(t('mesh.quickConnect') || t('mesh.connect')) + '</button>';
        html += '<button class="btn btn-sm" id="mesh-forget-key-btn">' + esc(t('mesh.forgetKey')) + '</button>';
      } else {
        html += '<button class="btn btn-sm btn-primary" id="mesh-connect-btn">' + esc(t('mesh.connect')) + '</button>';
      }
      html += '<a href="https://app.jimbomesh.ai" target="_blank" class="btn btn-sm">' + esc(t('mesh.getApiKey').split(' at ')[0] || 'Get API Key') + '</a>';
    } else if (meshState === 'connecting') {
      html += '<button class="btn btn-sm btn-danger" id="mesh-cancel-btn">' + esc(t('mesh.cancel')) + '</button>';
      html += '<a href="https://app.jimbomesh.ai" target="_blank" class="btn btn-sm">' + esc(t('mesh.getApiKey').split(' at ')[0] || 'Get API Key') + '</a>';
    } else if (meshState === 'connected') {
      html += '<button class="btn btn-sm btn-warning" id="mesh-reconnect-btn">' + esc(t('mesh.reconnect')) + '</button>';
      html += '<button class="btn btn-sm btn-danger" id="mesh-disconnect-btn">' + esc(t('mesh.disconnect')) + '</button>';
      html += '<a href="https://app.jimbomesh.ai/dashboard" target="_blank" class="btn btn-sm">' + esc(t('mesh.viewDashboard')) + '</a>';
    } else if (meshState === 'error') {
      html += '<button class="btn btn-sm btn-primary" id="mesh-retry-btn">' + esc(t('mesh.retry')) + '</button>';
      html += '<a href="https://app.jimbomesh.ai" target="_blank" class="btn btn-sm">' + esc(t('mesh.getApiKey').split(' at ')[0] || 'Get API Key') + '</a>';
      html += '<button class="btn btn-sm" id="mesh-dismiss-btn">' + esc(t('mesh.dismiss')) + '</button>';
    } else if (meshState === 'reconnecting') {
      html += '<button class="btn btn-sm btn-danger" id="mesh-disconnect-btn">' + esc(t('mesh.disconnect')) + '</button>';
    }

    html += '</div>'; // .mesh-actions
    html += '</div>'; // .card

    card.innerHTML = html;
    meshScrollLog();

    // ── Wire up event handlers ──

    var connectBtn = $('#mesh-connect-btn');
    if (connectBtn) {
      connectBtn.addEventListener('click', function () {
        var meshUrl = ($('#mesh-url-input') || {}).value || 'https://api.jimbomesh.ai';
        var meshKey = ($('#mesh-key-input') || {}).value || '';
        var hollerName = ($('#mesh-name-input') || {}).value || '';
        var autoConnect = $('#mesh-auto-connect') ? $('#mesh-auto-connect').checked : false;
        if (!meshKey) return;

        connectBtn.disabled = true;
        connectBtn.innerHTML = '<span class="spinner"></span> ' + esc(t('mesh.connecting'));

        api('/mesh/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ meshUrl: meshUrl, apiKey: meshKey, hollerName: hollerName, autoConnect: autoConnect }),
        }).then(function (res) { return res.json(); })
          .then(function (d) {
            if (d.success) loadMeshStatus();
            else { connectBtn.disabled = false; connectBtn.textContent = t('mesh.connect'); }
          })
          .catch(function () {
            connectBtn.disabled = false;
            connectBtn.textContent = t('mesh.connect');
          });
      });
    }

    var cancelBtn = $('#mesh-cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        cancelBtn.disabled = true;
        api('/mesh/cancel', { method: 'POST' }).then(function () {
          loadMeshStatus();
        }).catch(function () { cancelBtn.disabled = false; });
      });
    }

    var disconnectBtn = $('#mesh-disconnect-btn');
    if (disconnectBtn) {
      disconnectBtn.addEventListener('click', function () {
        disconnectBtn.disabled = true;
        disconnectBtn.textContent = t('mesh.disconnecting');
        api('/mesh/disconnect', { method: 'POST' }).then(function () {
          loadMeshStatus();
        }).catch(function () {
          disconnectBtn.disabled = false;
          disconnectBtn.textContent = t('mesh.disconnect');
        });
      });
    }

    var retryBtn = $('#mesh-retry-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', function () {
        var meshUrl = ($('#mesh-url-input') || {}).value || 'https://api.jimbomesh.ai';
        var meshKey = ($('#mesh-key-input') || {}).value || '';
        var hollerName = ($('#mesh-name-input') || {}).value || '';
        var autoConnect = $('#mesh-auto-connect') ? $('#mesh-auto-connect').checked : false;
        if (!meshKey) return;

        retryBtn.disabled = true;
        retryBtn.innerHTML = '<span class="spinner"></span> ' + esc(t('mesh.connecting'));

        api('/mesh/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ meshUrl: meshUrl, apiKey: meshKey, hollerName: hollerName, autoConnect: autoConnect }),
        }).then(function (res) { return res.json(); })
          .then(function (d) {
            if (d.success) loadMeshStatus();
            else { retryBtn.disabled = false; retryBtn.textContent = t('mesh.retry'); }
          })
          .catch(function () {
            retryBtn.disabled = false;
            retryBtn.textContent = t('mesh.retry');
          });
      });
    }

    var dismissBtn = $('#mesh-dismiss-btn');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', function () {
        dismissBtn.disabled = true;
        api('/mesh/disconnect', { method: 'POST' }).then(function () {
          loadMeshStatus();
        }).catch(function () { dismissBtn.disabled = false; });
      });
    }

    var quickConnectBtn = $('#mesh-quick-connect-btn');
    if (quickConnectBtn) {
      quickConnectBtn.addEventListener('click', function () {
        quickConnectBtn.disabled = true;
        quickConnectBtn.innerHTML = '<span class="spinner"></span> ' + esc(t('mesh.connecting'));
        api('/mesh/connect-stored', { method: 'POST' }).then(function (res) { return res.json(); })
          .then(function (d) {
            if (d.success) loadMeshStatus();
            else { quickConnectBtn.disabled = false; quickConnectBtn.textContent = t('mesh.quickConnect') || t('mesh.connect'); }
          })
          .catch(function () {
            quickConnectBtn.disabled = false;
            quickConnectBtn.textContent = t('mesh.quickConnect') || t('mesh.connect');
          });
      });
    }

    var forgetKeyBtn = $('#mesh-forget-key-btn');
    if (forgetKeyBtn) {
      forgetKeyBtn.addEventListener('click', function () {
        forgetKeyBtn.disabled = true;
        api('/mesh/forget-key', { method: 'POST' }).then(function () {
          loadMeshStatus();
        }).catch(function () { forgetKeyBtn.disabled = false; });
      });
    }

    var reconnectBtn = $('#mesh-reconnect-btn');
    if (reconnectBtn) {
      reconnectBtn.addEventListener('click', function () {
        reconnectBtn.disabled = true;
        reconnectBtn.innerHTML = '<span class="spinner"></span> ' + esc(t('mesh.reconnecting'));
        api('/mesh/reconnect', { method: 'POST' }).then(function (res) { return res.json(); })
          .then(function (d) {
            if (d.success) loadMeshStatus();
            else { reconnectBtn.disabled = false; reconnectBtn.textContent = t('mesh.reconnect'); }
          })
          .catch(function () {
            reconnectBtn.disabled = false;
            reconnectBtn.textContent = t('mesh.reconnect');
          });
      });
    }

    var autoConnectEl = $('#mesh-auto-connect');
    if (autoConnectEl) {
      autoConnectEl.addEventListener('change', function () {
        api('/mesh/auto-connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: autoConnectEl.checked }),
        }).catch(function (e) {
          console.error('Failed to update auto-connect:', e);
        });
      });
    }

    // ── Start polling ──
    meshRefreshInterval = setInterval(function () {
      if (state.tab !== 'config') { clearInterval(meshRefreshInterval); meshRefreshInterval = null; return; }
      apiJSON('/mesh/status').then(function (d) {
        var newState = d.state || (d.connected ? 'connected' : (d.connecting ? 'connecting' : 'disconnected'));
        var newLogLen = d.log ? d.log.length : 0;
        var newLogTail = meshLogTailSignature(d.log || []);
        var peerCount = d.peerConnections ? d.peerConnections.activeConnections : 0;

        // Full re-render if state changed or peers changed
        if (newState !== _meshLastState || peerCount > 0) {
          renderMeshCard(d);
          return;
        }

        // When a capped buffer rotates (same length, new tail), refresh full card.
        if (newLogLen < _meshLastLogLen || (newLogLen === _meshLastLogLen && newLogTail !== _meshLastLogTail)) {
          renderMeshCard(d);
          return;
        }

        // Incremental: append new log entries
        if (d.log && newLogLen > _meshLastLogLen) {
          meshAppendLogEntries(d.log, _meshLastLogLen);
          _meshLastLogLen = newLogLen;
          _meshLastLogTail = newLogTail;
        }

        // Update heartbeat timestamp
        var el = $('#mesh-last-hb');
        if (el && d.lastHeartbeat) {
          var sAgo = Math.round((Date.now() - d.lastHeartbeat) / 1000);
          el.textContent = sAgo < 60 ? t('mesh.secondsAgo', { seconds: sAgo }) : t('mesh.minutesAgo', { minutes: Math.round(sAgo / 60) });
        }
        var retryEl = $('#mesh-next-retry');
        if (retryEl) {
          if (d.nextReconnectAt) {
            var retryIn = Math.max(0, Math.ceil((d.nextReconnectAt - Date.now()) / 1000));
            retryEl.textContent = retryIn + 's';
          } else {
            retryEl.textContent = '\u2014';
          }
        }
        var attemptEl = $('#mesh-reconnect-attempt');
        if (attemptEl) {
          attemptEl.textContent = String(d.reconnectAttempt || 0);
        }
      }).catch(function () {});
    }, 5000);
    activeIntervals.push(meshRefreshInterval);
  }

  function loadBearerTokens() {
    apiJSON('/tokens').then(function (data) {
      bearerTokens = data.tokens || [];
      renderBearerTokensTable();
    }).catch(function () { /* ignore */ });
  }

  function renderBearerTokensTable() {
    var container = $('#bearer-tokens-section');
    if (!container) return;

    if (bearerTokens.length === 0) {
      container.innerHTML =
        '<p class="text-muted text-sm">' + esc(t('bearerToken.emptyState')) + '</p>' +
        '<button class="btn btn-primary btn-sm" id="create-token-btn">' + esc(t('bearerToken.createBtn')) + '</button>';
      var createBtn = container.querySelector('#create-token-btn');
      if (createBtn) createBtn.addEventListener('click', showCreateTokenDialog);
      return;
    }

    var rows = bearerTokens.map(function (tk) {
      var isExpired = tk.expires_at && new Date(tk.expires_at) < new Date();
      var statusBadge = isExpired
        ? '<span class="badge badge-error">' + esc(t('bearerToken.expired')) + '</span>'
        : '<span class="badge badge-success">' + esc(t('bearerToken.active')) + '</span>';
      var permBadges = tk.permissions.map(function (p) {
        return '<span class="badge badge-info">' + esc(p) + '</span>';
      }).join(' ');
      var sparkline = renderUsageSparkline(tk.hourly_usage || {});
      var lastUsed = tk.last_used ? new Date(tk.last_used).toLocaleString() : esc(t('bearerToken.never'));

      return '<tr>' +
        '<td>' + esc(tk.name) + '</td>' +
        '<td><code>' + esc(tk.prefix) + '...</code></td>' +
        '<td class="token-permissions-cell">' + permBadges + '</td>' +
        '<td>' + tk.rpm + '/' + tk.rph + '</td>' +
        '<td>' + new Date(tk.created_at).toLocaleDateString() + '</td>' +
        '<td>' + lastUsed + '</td>' +
        '<td>' + (tk.request_count || 0) + '</td>' +
        '<td>' + sparkline + '</td>' +
        '<td>' + statusBadge + '</td>' +
        '<td>' +
          '<button class="btn btn-sm token-edit-btn" data-id="' + esc(tk.id) + '">' + esc(t('bearerToken.edit')) + '</button> ' +
          '<button class="btn btn-sm btn-danger token-revoke-btn" data-id="' + esc(tk.id) + '" data-name="' + esc(tk.name) + '">' + esc(t('bearerToken.revoke')) + '</button>' +
        '</td>' +
      '</tr>';
    }).join('');

    container.innerHTML =
      '<div class="flex-between mb-1">' +
        '<h4>' + esc(t('bearerToken.title')) + '</h4>' +
        '<button class="btn btn-primary btn-sm" id="create-token-btn">' + esc(t('bearerToken.createBtn')) + '</button>' +
      '</div>' +
      '<div class="table-scroll"><table>' +
        '<thead><tr>' +
          '<th>' + esc(t('bearerToken.name')) + '</th>' +
          '<th>' + esc(t('bearerToken.token')) + '</th>' +
          '<th>' + esc(t('bearerToken.permissions')) + '</th>' +
          '<th>' + esc(t('bearerToken.rateLimit')) + '</th>' +
          '<th>' + esc(t('bearerToken.created')) + '</th>' +
          '<th>' + esc(t('bearerToken.lastUsed')) + '</th>' +
          '<th>' + esc(t('bearerToken.requests')) + '</th>' +
          '<th>' + esc(t('bearerToken.usage')) + '</th>' +
          '<th>' + esc(t('bearerToken.status')) + '</th>' +
          '<th>' + esc(t('bearerToken.actions')) + '</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table></div>';

    // Bind events
    var createBtn = container.querySelector('#create-token-btn');
    if (createBtn) createBtn.addEventListener('click', showCreateTokenDialog);

    container.querySelectorAll('.token-revoke-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        confirmRevokeToken(btn.dataset.id, btn.dataset.name);
      });
    });

    container.querySelectorAll('.token-edit-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        showEditTokenDialog(btn.dataset.id);
      });
    });
  }

  function showCreateTokenDialog() {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-dialog" style="max-width:480px">' +
        '<h3>' + esc(t('bearerToken.createTitle')) + '</h3>' +
        '<div class="token-form">' +
          '<div class="form-group">' +
            '<label>' + esc(t('bearerToken.tokenName')) + '</label>' +
            '<input type="text" class="setting-input" id="token-name" placeholder="' + esc(t('bearerToken.tokenNamePlaceholder')) + '">' +
          '</div>' +
          '<div class="form-group">' +
            '<label>' + esc(t('bearerToken.permissions')) + '</label>' +
            '<div class="token-permissions">' +
              '<label><input type="checkbox" value="embeddings"> ' + esc(t('bearerToken.permEmbeddings')) + '</label>' +
              '<label><input type="checkbox" value="chat"> ' + esc(t('bearerToken.permChat')) + '</label>' +
              '<label><input type="checkbox" value="documents"> ' + esc(t('bearerToken.permDocuments')) + '</label>' +
              '<label><input type="checkbox" value="full"> ' + esc(t('bearerToken.permFull')) + '</label>' +
            '</div>' +
          '</div>' +
          '<div class="rate-inputs">' +
            '<div class="form-group">' +
              '<label>' + esc(t('bearerToken.rpmLabel')) + '</label>' +
              '<input type="number" class="setting-input" id="token-rpm" value="60" min="1">' +
            '</div>' +
            '<div class="form-group">' +
              '<label>' + esc(t('bearerToken.rphLabel')) + '</label>' +
              '<input type="number" class="setting-input" id="token-rph" value="1000" min="1">' +
            '</div>' +
          '</div>' +
          '<div class="form-group">' +
            '<label>' + esc(t('bearerToken.expiryLabel')) + '</label>' +
            '<select class="setting-input" id="token-expiry">' +
              '<option value="">' + esc(t('bearerToken.expiryNever')) + '</option>' +
              '<option value="30">' + esc(t('bearerToken.expiry30d')) + '</option>' +
              '<option value="60">' + esc(t('bearerToken.expiry60d')) + '</option>' +
              '<option value="90">' + esc(t('bearerToken.expiry90d')) + '</option>' +
            '</select>' +
          '</div>' +
        '</div>' +
        '<div class="confirm-actions">' +
          '<button class="btn" id="token-cancel">' + esc(t('bearerToken.cancel')) + '</button>' +
          '<button class="btn btn-primary" id="token-create">' + esc(t('bearerToken.create')) + '</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    var cancelBtn = overlay.querySelector('#token-cancel');
    var createBtn = overlay.querySelector('#token-create');

    cancelBtn.addEventListener('click', function () { overlay.remove(); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });

    createBtn.addEventListener('click', function () {
      var name = overlay.querySelector('#token-name').value.trim();
      if (!name) return;
      var perms = [];
      overlay.querySelectorAll('.token-permissions input:checked').forEach(function (cb) {
        perms.push(cb.value);
      });
      if (perms.length === 0) perms = ['full'];
      var rpm = parseInt(overlay.querySelector('#token-rpm').value) || 60;
      var rph = parseInt(overlay.querySelector('#token-rph').value) || 1000;
      var expiryDays = overlay.querySelector('#token-expiry').value;
      var expiresAt = null;
      if (expiryDays) {
        var d = new Date();
        d.setDate(d.getDate() + parseInt(expiryDays));
        expiresAt = d.toISOString();
      }

      overlay.remove();
      api('/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, permissions: perms, rpm: rpm, rph: rph, expires_at: expiresAt }),
      }).then(function (res) { return res.json(); })
        .then(function (data) {
          showNewBearerTokenDialog(data.raw, data.name);
          loadBearerTokens();
        });
    });
  }

  function showNewBearerTokenDialog(rawToken, tokenName) {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-dialog newkey-dialog">' +
        '<h3>' + esc(t('bearerToken.newTokenTitle')) + '</h3>' +
        '<p>' + esc(t('bearerToken.newTokenMessage')) + '</p>' +
        '<div class="newkey-display">' +
          '<code id="new-token-value">' + esc(rawToken) + '</code>' +
          '<button class="btn btn-sm" id="new-token-copy">' + esc(t('bearerToken.copy')) + '</button>' +
        '</div>' +
        '<p class="text-muted text-sm">' + esc(t('bearerToken.newTokenWarning')) + '</p>' +
        '<div class="confirm-actions">' +
          '<button class="btn btn-primary" id="new-token-dismiss">' + esc(t('bearerToken.saved')) + '</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    overlay.querySelector('#new-token-copy').addEventListener('click', function () {
      copyToClipboard(rawToken, overlay.querySelector('#new-token-copy'));
    });
    overlay.querySelector('#new-token-dismiss').addEventListener('click', function () { overlay.remove(); });
  }

  function confirmRevokeToken(tokenId, tokenName) {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-dialog">' +
        '<h3>' + esc(t('bearerToken.revokeConfirmTitle')) + '</h3>' +
        '<p>' + t('bearerToken.revokeConfirmMessage', { name: esc(tokenName) }) + '</p>' +
        '<div class="confirm-actions">' +
          '<button class="btn" id="revoke-cancel">' + esc(t('bearerToken.cancel')) + '</button>' +
          '<button class="btn btn-danger" id="revoke-confirm">' + esc(t('bearerToken.revoke')) + '</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    overlay.querySelector('#revoke-cancel').addEventListener('click', function () { overlay.remove(); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#revoke-confirm').addEventListener('click', function () {
      overlay.remove();
      api('/tokens/' + tokenId, { method: 'DELETE' }).then(function () {
        showToast(t('bearerToken.revokeSuccess', { name: tokenName }), 'success');
        loadBearerTokens();
      }).catch(function () {
        showToast(t('bearerToken.revokeError'), 'error');
      });
    });
  }

  function showEditTokenDialog(tokenId) {
    var tk = bearerTokens.find(function (t2) { return t2.id === tokenId; });
    if (!tk) return;

    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-dialog" style="max-width:480px">' +
        '<h3>' + esc(t('bearerToken.editTitle')) + '</h3>' +
        '<div class="token-form">' +
          '<div class="form-group">' +
            '<label>' + esc(t('bearerToken.tokenName')) + '</label>' +
            '<input type="text" class="setting-input" id="edit-token-name" value="' + esc(tk.name) + '">' +
          '</div>' +
          '<div class="form-group">' +
            '<label>' + esc(t('bearerToken.permissions')) + '</label>' +
            '<div class="token-permissions">' +
              '<label><input type="checkbox" value="embeddings"' + (tk.permissions.indexOf('embeddings') !== -1 ? ' checked' : '') + '> ' + esc(t('bearerToken.permEmbeddings')) + '</label>' +
              '<label><input type="checkbox" value="chat"' + (tk.permissions.indexOf('chat') !== -1 ? ' checked' : '') + '> ' + esc(t('bearerToken.permChat')) + '</label>' +
              '<label><input type="checkbox" value="documents"' + (tk.permissions.indexOf('documents') !== -1 ? ' checked' : '') + '> ' + esc(t('bearerToken.permDocuments')) + '</label>' +
              '<label><input type="checkbox" value="full"' + (tk.permissions.indexOf('full') !== -1 ? ' checked' : '') + '> ' + esc(t('bearerToken.permFull')) + '</label>' +
            '</div>' +
          '</div>' +
          '<div class="rate-inputs">' +
            '<div class="form-group">' +
              '<label>' + esc(t('bearerToken.rpmLabel')) + '</label>' +
              '<input type="number" class="setting-input" id="edit-token-rpm" value="' + tk.rpm + '" min="1">' +
            '</div>' +
            '<div class="form-group">' +
              '<label>' + esc(t('bearerToken.rphLabel')) + '</label>' +
              '<input type="number" class="setting-input" id="edit-token-rph" value="' + tk.rph + '" min="1">' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="confirm-actions">' +
          '<button class="btn" id="edit-cancel">' + esc(t('bearerToken.cancel')) + '</button>' +
          '<button class="btn btn-primary" id="edit-save">' + esc(t('bearerToken.saveChanges')) + '</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    overlay.querySelector('#edit-cancel').addEventListener('click', function () { overlay.remove(); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#edit-save').addEventListener('click', function () {
      var name = overlay.querySelector('#edit-token-name').value.trim();
      var perms = [];
      overlay.querySelectorAll('.token-permissions input:checked').forEach(function (cb) {
        perms.push(cb.value);
      });
      if (perms.length === 0) perms = ['full'];
      var rpm = parseInt(overlay.querySelector('#edit-token-rpm').value) || 60;
      var rph = parseInt(overlay.querySelector('#edit-token-rph').value) || 1000;

      overlay.remove();
      api('/tokens/' + tokenId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, permissions: perms, rpm: rpm, rph: rph }),
      }).then(function (res) { return res.json(); })
        .then(function () {
          showToast(t('bearerToken.updateSuccess', { name: name }), 'success');
          loadBearerTokens();
        }).catch(function () {
          showToast(t('bearerToken.updateError'), 'error');
        });
    });
  }

  function configGroupRaw(title, items) {
    var rows = items.map(function (item) {
      return '<div class="config-item">' +
        '<span class="key">' + esc(item[0]) + '</span>' +
        '<span class="value">' + item[1] + '</span>' +
      '</div>';
    }).join('');
    return '<div class="card config-group"><h3>' + esc(title) + '</h3>' + rows + '</div>';
  }

  // ── Statistics Tab ────────────────────────────────────────────

  var statsModelHourly = {};

  function numFmt(v) {
    if (v == null || Number.isNaN(Number(v))) return '\u2014';
    return Number(v).toLocaleString();
  }

  function tokenFmt(v) {
    if (v == null || Number.isNaN(Number(v))) return '\u2014';
    var n = Number(v);
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return Math.round(n).toString();
  }

  function msFmt(v) {
    if (v == null || Number.isNaN(Number(v))) return '\u2014';
    var n = Number(v);
    if (n >= 1000) return (n / 1000).toFixed(2) + 's';
    return Math.round(n) + 'ms';
  }

  function tpsFmt(v) {
    if (v == null || Number.isNaN(Number(v))) return '\u2014';
    return Number(v).toFixed(1) + ' tok/s';
  }

  function renderStatsSparkline(data, options) {
    options = options || {};
    var width = options.width || 120;
    var height = options.height || 32;
    var strokeColor = options.strokeColor || '#14b8a6';
    var fillColor = options.fillColor || 'rgba(13, 148, 136, 0.15)';
    var strokeWidth = options.strokeWidth || 1.5;

    if (!data || data.length < 2) {
      return '<svg width="' + width + '" height="' + height + '" class="sparkline"></svg>';
    }

    var min = Math.min.apply(null, data);
    var max = Math.max.apply(null, data);
    var range = (max - min) || 1;
    var padding = 2;

    var points = data.map(function (val, i) {
      var x = padding + (i / (data.length - 1)) * (width - padding * 2);
      var y = padding + (1 - (val - min) / range) * (height - padding * 2);
      return x + ',' + y;
    }).join(' ');

    var firstX = padding;
    var lastX = width - padding;
    var fillPoints = firstX + ',' + (height - padding) + ' ' + points + ' ' + lastX + ',' + (height - padding);

    return '<svg width="' + width + '" height="' + height + '" class="sparkline">' +
      '<polygon points="' + fillPoints + '" fill="' + fillColor + '" />' +
      '<polyline points="' + points + '" fill="none" stroke="' + strokeColor + '"' +
      ' stroke-width="' + strokeWidth + '" stroke-linecap="round" stroke-linejoin="round" />' +
      '</svg>';
  }

  function buildHourlyMap(hourly) {
    var byBucket = {};
    (hourly || []).forEach(function (h) {
      byBucket[String(h.hour_bucket)] = h;
    });
    var now = Date.now();
    var points = [];
    for (var i = 23; i >= 0; i--) {
      var bucket = Math.floor((now - i * 3600000) / 3600000) * 3600000;
      points.push(byBucket[String(bucket)] || {
        hour_bucket: bucket, requests: 0, avg_tps: 0, avg_latency_ms: 0, avg_ttft_ms: 0, error_rate: 0, tool_call_errors: 0,
      });
    }
    return points;
  }

  function initStatistics(ct) {
    ct.innerHTML =
      '<div class="card">' +
        '<div class="card-header">' +
          '<h2>\uD83D\uDCCA Performance Overview</h2>' +
          '<button class="btn btn-sm btn-danger" id="stats-reset-all">Reset Stats</button>' +
        '</div>' +
        '<div class="stats-grid" id="stats-global-grid">' +
          statCard('st-total-req', 'Total Requests', '\u2014') +
          statCard('st-total-tok', 'Tokens Processed', '\u2014') +
          statCard('st-avg-tps', 'Avg Throughput', '\u2014') +
          statCard('st-avg-lat', 'Avg Latency', '\u2014') +
          statCard('st-err-rate', 'Errors', '\u2014') +
        '</div>' +
        '<div class="text-muted text-sm" id="stats-tracking-since">Tracking since: \u2014</div>' +
      '</div>' +
      '<div id="stats-model-cards"><div class="empty-state"><span class="spinner"></span> ' + esc(t('status.loading')) + '</div></div>' +
      '<div class="card">' +
        '<div class="card-header"><h2>\uD83D\uDCCB Recent Requests</h2></div>' +
        '<div id="stats-requests-wrap"><div class="empty-state"><span class="spinner"></span> ' + esc(t('status.loading')) + '</div></div>' +
      '</div>';

    var resetAllBtn = $('#stats-reset-all');
    if (resetAllBtn) {
      resetAllBtn.addEventListener('click', function () {
        showStatsResetConfirm(null);
      });
    }

    refreshStatistics();
    activeIntervals.push(setInterval(refreshStatistics, 30000));
  }

  function showStatsResetConfirm(model) {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    var msg = model
      ? 'Reset stats for ' + model + '?'
      : 'Reset all statistics? This cannot be undone.';
    overlay.innerHTML =
      '<div class="confirm-dialog danger-dialog">' +
        '<h3>Reset Statistics</h3>' +
        '<p>' + esc(msg) + '</p>' +
        '<div class="confirm-actions">' +
          '<button class="btn" id="stats-reset-cancel">Cancel</button>' +
          '<button class="btn btn-danger" id="stats-reset-confirm">Reset</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    function close() { overlay.remove(); }
    overlay.querySelector('#stats-reset-cancel').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.querySelector('#stats-reset-confirm').addEventListener('click', function () {
      api('/stats/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(model ? { model: model } : {}),
      }).then(function () {
        close();
        refreshStatistics();
      }).catch(function () {
        close();
      });
    });
  }

  function refreshStatistics() {
    Promise.all([
      apiJSON('/stats'),
      apiJSON('/stats/requests?limit=50'),
      apiJSON('/stats/pricing').catch(function () { return { pricing: [] }; }),
    ]).then(function (result) {
      var payload = result[0] || {};
      var reqPayload = result[1] || {};
      var pricingPayload = result[2] || {};
      var global = payload.global || {};
      var models = payload.models || [];
      var pricingByModel = {};
      (pricingPayload.pricing || []).forEach(function (p) {
        pricingByModel[p.model] = p;
      });

      setText('#st-total-req', numFmt(global.total_requests));
      setText('#st-total-tok', tokenFmt(global.total_tokens_processed));
      setText('#st-avg-tps', tpsFmt(global.avg_tps_global));
      setText('#st-avg-lat', msFmt(global.avg_latency_global));
      setText('#st-err-rate', global.error_rate_global != null ? Number(global.error_rate_global).toFixed(2) + '%' : '\u2014');
      setText('#stats-tracking-since', 'Tracking since: ' + (global.tracking_since ? new Date(global.tracking_since).toLocaleString() : '\u2014'));

      renderStatisticsModelCards(models, pricingByModel);
      renderStatisticsRequests(reqPayload.requests || []);
    }).catch(function () {});
  }

  function renderStatisticsModelCards(models, pricingByModel) {
    var wrap = $('#stats-model-cards');
    if (!wrap) return;
    if (!models || models.length === 0) {
      wrap.innerHTML = '<div class="card"><div class="empty-state">No model stats yet.</div></div>';
      return;
    }

    // Pull hourly series for each model in parallel.
    Promise.all(models.map(function (m) {
      return apiJSON('/stats/hourly?model=' + encodeURIComponent(m.model))
        .then(function (hourly) { return { model: m.model, hourly: hourly.hourly || [] }; })
        .catch(function () { return { model: m.model, hourly: [] }; });
    })).then(function (hourlyPerModel) {
      statsModelHourly = {};
      hourlyPerModel.forEach(function (entry) {
        statsModelHourly[entry.model] = buildHourlyMap(entry.hourly);
      });

      wrap.innerHTML = models.map(function (m) {
        var hourly = statsModelHourly[m.model] || buildHourlyMap([]);
        var throughputSpark = renderStatsSparkline(hourly.map(function (h) { return Number(h.avg_tps || 0); }), { strokeColor: '#14b8a6', fillColor: 'rgba(20,184,166,0.16)' });
        var latencySpark = renderStatsSparkline(hourly.map(function (h) { return Number(h.avg_latency_ms || 0); }), { strokeColor: '#f97316', fillColor: 'rgba(249,115,22,0.12)' });
        var ttftSpark = renderStatsSparkline(hourly.map(function (h) { return Number(h.avg_ttft_ms || 0); }), { strokeColor: '#f97316', fillColor: 'rgba(249,115,22,0.12)' });
        var errorSpark = renderStatsSparkline(hourly.map(function (h) { return Number(h.error_rate || 0); }), { strokeColor: '#ef4444', fillColor: 'rgba(239,68,68,0.12)' });

        var pricing = pricingByModel[m.model] || {};
        var inputPrice = pricing.moonshine_input_per_1k != null ? pricing.moonshine_input_per_1k : m.moonshine_input_per_1k;
        var outputPrice = pricing.moonshine_output_per_1k != null ? pricing.moonshine_output_per_1k : m.moonshine_output_per_1k;

        return '<div class="card stats-model-card">' +
          '<div class="card-header">' +
            '<h2>\uD83E\uDDE0 ' + esc(m.model) + '</h2>' +
            '<button class="btn btn-sm btn-danger" data-stats-reset-model="' + esc(m.model) + '">Reset Model Stats</button>' +
          '</div>' +
          '<div class="stats-spark-grid">' +
            renderStatsMetricCard('Throughput', tpsFmt(m.avg_tokens_per_second), throughputSpark) +
            renderStatsMetricCard('Latency', msFmt(m.avg_e2e_latency_ms), latencySpark) +
            renderStatsMetricCard('Error Rate', m.error_rate_percent != null ? Number(m.error_rate_percent).toFixed(2) + '%' : '\u2014', errorSpark) +
            renderStatsMetricCard('TTFT', msFmt(m.avg_ttft_ms), ttftSpark) +
          '</div>' +
          '<div class="text-sm mt-1">Requests: ' + numFmt(m.total_requests) + '</div>' +
          '<div class="text-sm">Total Tokens: ' + tokenFmt(m.total_tokens) + ' (In: ' + tokenFmt(m.total_input_tokens) + ' / Out: ' + tokenFmt(m.total_output_tokens) + ')</div>' +
          '<div class="text-sm">Throughput: ' + tpsFmt(m.avg_tokens_per_second) + ' avg (min: ' + tpsFmt(m.min_tokens_per_second) + ' / max: ' + tpsFmt(m.max_tokens_per_second) + ')</div>' +
          '<div class="text-sm">E2E Latency: ' + msFmt(m.avg_e2e_latency_ms) + ' avg (min: ' + msFmt(m.min_e2e_latency_ms) + ' / max: ' + msFmt(m.max_e2e_latency_ms) + ')</div>' +
          '<div class="text-sm">Generation: ' + msFmt(m.avg_generation_ms) + ' avg</div>' +
          '<div class="text-sm">Context Window: ' + numFmt(m.context_window) + ' | Max Output: ' + numFmt(m.max_output) + '</div>' +
          '<div class="text-sm">Moonshine Pricing: Input ' + (inputPrice != null ? inputPrice : '\u2014') + ' \uD83E\uDD43 /1K' +
            (outputPrice != null ? (' | Output ' + outputPrice + ' \uD83E\uDD43 /1K') : '') + '</div>' +
        '</div>';
      }).join('');

      wrap.querySelectorAll('[data-stats-reset-model]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          showStatsResetConfirm(btn.dataset.statsResetModel);
        });
      });
    });
  }

  function renderStatsMetricCard(label, value, sparklineHtml) {
    return '<div class="stat-card-sparkline">' +
      '<div class="stat-label">' + esc(label) + '</div>' +
      '<div class="stat-value">' + esc(value) + '</div>' +
      '<div class="sparkline-container">' + sparklineHtml + '</div>' +
      '<div class="stat-trend">24h trend</div>' +
    '</div>';
  }

  function renderStatisticsRequests(requests) {
    var wrap = $('#stats-requests-wrap');
    if (!wrap) return;
    if (!requests || requests.length === 0) {
      wrap.innerHTML = '<div class="empty-state">No tracked requests yet.</div>';
      return;
    }
    var rows = requests.map(function (r) {
      var status = r.status === 'complete' ? '✅ Complete' : (r.status === 'error' ? '❌ Error' : esc(r.status || '\u2014'));
      return '<tr>' +
        '<td class="mono">' + esc(formatTime(r.started_at)) + '</td>' +
        '<td class="mono">' + esc(r.model || '\u2014') + '</td>' +
        '<td class="mono">' + numFmt(r.total_tokens) + '</td>' +
        '<td class="mono">' + (Number(r.tokens_per_second) > 0 ? Number(r.tokens_per_second).toFixed(1) : '\u2014') + '</td>' +
        '<td class="mono">' + msFmt(r.e2e_latency_ms) + '</td>' +
        '<td>' + status + '</td>' +
      '</tr>';
    }).join('');

    wrap.innerHTML = '<div class="table-wrapper"><table>' +
      '<thead><tr><th>Time</th><th>Model</th><th>Tokens</th><th>TPS</th><th>Latency</th><th>Status</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table></div>';
  }

  // ── Activity Tab ──────────────────────────────────────────────

  var actPage = 0;
  var actLimit = 50;

  function initActivity(ct) {
    actPage = 0;
    ct.innerHTML =
      '<div class="card">' +
        '<div class="card-header">' +
          '<h2>' + esc(t('activity.title')) + '</h2>' +
          '<div style="display:flex;align-items:center;gap:0.5rem">' +
            '<span class="text-muted text-sm" id="act-count"></span>' +
            '<button class="btn btn-sm" id="act-refresh">' + esc(t('activity.refresh')) + '</button>' +
            '<button class="btn btn-sm btn-danger" id="act-clear">' + esc(t('activity.clearLog')) + '</button>' +
          '</div>' +
        '</div>' +
        '<div id="act-body"><div class="empty-state"><span class="spinner"></span> ' + esc(t('status.loading')) + '</div></div>' +
        '<div id="act-pagination" style="display:flex;justify-content:center;gap:0.5rem;padding:0.75rem 0"></div>' +
      '</div>' +
      '<p class="text-muted text-sm">' + esc(t('activity.autoRefresh')) + '</p>';

    var refreshBtn = $('#act-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', refreshActivity);

    var clearBtn = $('#act-clear');
    if (clearBtn) clearBtn.addEventListener('click', clearActivityLog);

    refreshActivity();
    activeIntervals.push(setInterval(refreshActivity, 5000));
  }

  function clearActivityLog() {
    // Get current count to show in confirmation
    var countEl = $('#act-count');
    var countText = countEl ? countEl.textContent : '';
    var countMatch = countText.match(/(\d+)$/);
    var count = countMatch ? countMatch[1] : '?';

    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-dialog danger-dialog">' +
        '<h3>' + esc(t('activity.clearConfirmTitle')) + '</h3>' +
        '<p>' + esc(t('activity.clearConfirmMessage', { count: count })) + '</p>' +
        '<div class="confirm-actions">' +
          '<button class="btn" id="clear-cancel">' + esc(t('configuration.cancel')) + '</button>' +
          '<button class="btn btn-danger" id="clear-confirm">' + esc(t('activity.clearLog')) + '</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    var close = function () { overlay.remove(); };

    overlay.querySelector('#clear-cancel').addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });

    overlay.querySelector('#clear-confirm').addEventListener('click', function () {
      var btn = overlay.querySelector('#clear-confirm');
      btn.disabled = true;
      btn.textContent = t('activity.clearing');

      api('/activity', { method: 'DELETE' }).then(function (res) {
        return res.json();
      }).then(function (data) {
        close();
        showToast(t('activity.clearSuccess', { count: data.deleted || 0 }), 'success');
        actPage = 0;
        refreshActivity();
      }).catch(function () {
        close();
        showToast(t('activity.clearError'), 'error');
      });
    });
  }

  function refreshActivity() {
    var offset = actPage * actLimit;
    apiJSON('/activity?limit=' + actLimit + '&offset=' + offset).then(function (data) {
      var requests = data.requests || [];
      var total = data.total || requests.length;
      var showing = offset + 1;
      var showingEnd = Math.min(offset + requests.length, total);
      setText('#act-count', total > 0
        ? t('activity.showing', { start: showing, end: showingEnd, total: total })
        : t('activity.noRequests'));

      var body = $('#act-body');
      if (!body) return;

      if (requests.length === 0 && actPage === 0) {
        body.innerHTML = '<div class="empty-state">' + esc(t('activity.emptyState')) + '</div>';
        return;
      }

      var rows = requests.map(function (r) {
        return '<tr>' +
          '<td class="mono">' + esc(formatTime(r.timestamp)) + '</td>' +
          '<td><span class="badge badge-info">' + esc(r.method) + '</span></td>' +
          '<td class="mono">' + esc(r.path) + '</td>' +
          '<td><span class="badge ' + badgeClass(r.status) + '">' + r.status + '</span></td>' +
          '<td class="mono">' + esc(r.ip) + '</td>' +
          '<td class="mono">' + (r.duration_ms != null ? r.duration_ms + ' ms' : '\u2014') + '</td>' +
        '</tr>';
      }).join('');

      body.innerHTML =
        '<div class="table-wrapper"><table>' +
          '<thead><tr>' +
            '<th>' + esc(t('activity.time')) + '</th>' +
            '<th>' + esc(t('activity.method')) + '</th>' +
            '<th>' + esc(t('activity.path')) + '</th>' +
            '<th>' + esc(t('activity.statusCol')) + '</th>' +
            '<th>' + esc(t('activity.ip')) + '</th>' +
            '<th>' + esc(t('activity.duration')) + '</th>' +
          '</tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table></div>';

      var pagEl = $('#act-pagination');
      if (pagEl) {
        var totalPages = Math.ceil(total / actLimit);
        if (totalPages <= 1) {
          pagEl.innerHTML = '';
          return;
        }
        var prevDisabled = actPage === 0 ? ' disabled' : '';
        var nextDisabled = actPage >= totalPages - 1 ? ' disabled' : '';
        pagEl.innerHTML =
          '<button class="btn btn-sm" id="act-prev"' + prevDisabled + '>' + esc(t('activity.previous')) + '</button>' +
          '<span class="text-muted text-sm" style="line-height:2">' + esc(t('activity.pageOf', { current: actPage + 1, total: totalPages })) + '</span>' +
          '<button class="btn btn-sm" id="act-next"' + nextDisabled + '>' + esc(t('activity.next')) + '</button>';
        var prevBtn = $('#act-prev');
        var nextBtn = $('#act-next');
        if (prevBtn) prevBtn.addEventListener('click', function () {
          if (actPage > 0) { actPage--; refreshActivity(); }
        });
        if (nextBtn) nextBtn.addEventListener('click', function () {
          if (actPage < totalPages - 1) { actPage++; refreshActivity(); }
        });
      }
    }).catch(function () {});
  }

  // ── Documents Tab ───────────────────────────────────────────

  var docMode = 'upload';
  var docCollection = 'documents';
  var docCollections = [];
  var docList = [];
  var askMessages = [];

  function initDocuments(ct) {
    docMode = 'upload';
    ct.innerHTML =
      '<div id="doc-warning"></div>' +
      '<div class="doc-toolbar">' +
        '<div class="sub-tabs" id="doc-tabs">' +
          '<button class="sub-tab active" data-doc="upload">' + esc(t('documents.upload')) + '</button>' +
          '<button class="sub-tab" data-doc="browse">' + esc(t('documents.browse')) + '</button>' +
          '<button class="sub-tab" data-doc="ask">' + esc(t('documents.ask')) + '</button>' +
        '</div>' +
        '<div class="collection-selector">' +
          '<label>' + esc(t('documents.collection')) + ':</label>' +
          '<select id="doc-collection-select"></select>' +
          '<button class="btn btn-sm" id="doc-create-coll" title="' + esc(t('documents.createCollection')) + '">+</button>' +
        '</div>' +
      '</div>' +
      '<div id="doc-content"></div>';

    // Sub-tab switching
    $('#doc-tabs').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-doc]');
      if (!btn) return;
      docMode = btn.dataset.doc;
      $$('#doc-tabs .sub-tab').forEach(function (b) {
        b.classList.toggle('active', b.dataset.doc === docMode);
      });
      renderDocMode();
    });

    // Collection selector
    var collSelect = $('#doc-collection-select');
    if (collSelect) {
      collSelect.addEventListener('change', function () {
        docCollection = collSelect.value;
        if (docMode === 'browse') refreshDocList();
      });
    }

    // Create collection button
    var createBtn = $('#doc-create-coll');
    if (createBtn) createBtn.addEventListener('click', showCreateCollectionDialog);

    loadDocCollections();
    checkDocPrerequisites();
    renderDocMode();
  }

  function renderDocMode() {
    var ct = $('#doc-content');
    if (!ct) return;
    switch (docMode) {
      case 'upload': renderUploadMode(ct); break;
      case 'browse': renderBrowseMode(ct); break;
      case 'ask':    renderAskMode(ct); break;
    }
  }

  function loadDocCollections() {
    apiJSON('/collections').then(function (data) {
      docCollections = (data.collections || []).map(function (c) { return c.name; });
      var select = $('#doc-collection-select');
      if (!select) return;
      // Ensure 'documents' is always an option
      if (docCollections.indexOf('documents') === -1) docCollections.unshift('documents');
      select.innerHTML = docCollections.map(function (name) {
        return '<option value="' + esc(name) + '"' + (name === docCollection ? ' selected' : '') + '>' + esc(name) + '</option>';
      }).join('');
    }).catch(function () {
      // Qdrant may not be available
      var select = $('#doc-collection-select');
      if (select) select.innerHTML = '<option value="documents">documents</option>';
    });
  }

  function checkDocPrerequisites() {
    var warningEl = $('#doc-warning');
    if (!warningEl) return;
    warningEl.innerHTML = '';

    // Check for embedding models
    apiJSON('/models').then(function (data) {
      var models = data.models || [];
      var hasEmbed = models.some(function (m) {
        return isEmbeddingModel(m.name || '');
      });
      if (!hasEmbed && warningEl) {
        warningEl.innerHTML += '<div class="doc-warning">' + esc(t('documents.noEmbedModel')) + '</div>';
      }
    }).catch(function () {});

    // Check Qdrant connectivity
    apiJSON('/collections').catch(function () {
      if (warningEl) {
        warningEl.innerHTML += '<div class="doc-warning">' + esc(t('documents.noQdrant')) + '</div>';
      }
    });
  }

  // ── Upload Sub-Tab ────────────────────────────────────────

  function renderUploadMode(ct) {
    ct.innerHTML =
      '<div class="card">' +
        '<div class="upload-zone" id="upload-zone">' +
          '<div class="upload-icon">&#128196;</div>' +
          '<p>' + esc(t('documents.dropHere')) + '</p>' +
          '<p class="text-muted text-sm">' + esc(t('documents.supportedFormats')) + '</p>' +
          '<input type="file" id="doc-file-input" accept=".pdf,.md,.txt,.csv,.docx" multiple style="display:none">' +
          '<button class="btn btn-primary" id="doc-browse-btn">' + esc(t('documents.browseFiles')) + '</button>' +
        '</div>' +
        '<div id="upload-progress"></div>' +
      '</div>';

    var zone = $('#upload-zone');
    var fileInput = $('#doc-file-input');

    zone.addEventListener('dragover', function (e) {
      e.preventDefault();
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', function () {
      zone.classList.remove('drag-over');
    });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('drag-over');
      handleDocFiles(e.dataTransfer.files);
    });

    $('#doc-browse-btn').addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      handleDocFiles(fileInput.files);
      fileInput.value = '';
    });
  }

  function handleDocFiles(files) {
    for (var i = 0; i < files.length; i++) {
      uploadDocFile(files[i]);
    }
  }

  function uploadDocFile(file) {
    var progressContainer = $('#upload-progress');
    if (!progressContainer) return;

    var itemId = 'up-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    var itemHTML =
      '<div class="upload-progress-item" id="' + itemId + '">' +
        '<div class="upload-progress-info">' +
          '<div class="upload-progress-name">' + esc(file.name) + '</div>' +
          '<div class="progress-bar"><div class="progress-bar-fill" id="' + itemId + '-bar" style="width:0%"></div></div>' +
          '<div class="upload-progress-status" id="' + itemId + '-status">' + esc(t('documents.processing')) + '</div>' +
        '</div>' +
      '</div>';
    progressContainer.insertAdjacentHTML('beforeend', itemHTML);

    var formData = new FormData();
    formData.append('file', file);

    fetch('/admin/api/documents/upload?collection=' + encodeURIComponent(docCollection), {
      method: 'POST',
      headers: { 'X-API-Key': state.apiKey },
      body: formData,
    }).then(function (res) {
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      function pump() {
        return reader.read().then(function (result) {
          if (result.done) return;
          buffer += decoder.decode(result.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop();
          lines.forEach(function (line) {
            if (!line.startsWith('data: ')) return;
            try {
              var data = JSON.parse(line.slice(6));
              updateDocProgress(itemId, data, file.name);
            } catch (e) { /* skip */ }
          });
          return pump();
        });
      }
      return pump();
    }).catch(function (err) {
      var statusEl = $id(itemId + '-status');
      if (statusEl) statusEl.textContent = 'Error: ' + err.message;
      showToast(t('documents.uploadError', { error: err.message }), 'error');
    });
  }

  function updateDocProgress(itemId, data, fileName) {
    var bar = $id(itemId + '-bar');
    var status = $id(itemId + '-status');

    if (data.error) {
      if (data.error === 'duplicate') {
        if (status) status.textContent = t('documents.duplicate');
        showToast(t('documents.duplicate'), 'info');
      } else {
        if (status) status.textContent = 'Error: ' + data.error;
        showToast(t('documents.uploadError', { error: data.error }), 'error');
      }
      return;
    }

    if (data.phase && data.status && status) {
      status.textContent = data.status;
    }

    if (data.completed && data.total && bar) {
      bar.style.width = Math.round(data.completed / data.total * 100) + '%';
    }

    if (data.done) {
      if (bar) bar.style.width = '100%';
      if (status) status.textContent = t('documents.uploadSuccess', { name: fileName });
      showToast(t('documents.uploadSuccess', { name: fileName }), 'success');
    }
  }

  // ── Browse Sub-Tab ────────────────────────────────────────

  function renderBrowseMode(ct) {
    ct.innerHTML =
      '<div class="card">' +
        '<div class="card-header">' +
          '<h2>' + esc(t('documents.documentList')) + '</h2>' +
          '<button class="btn btn-sm" id="doc-refresh">' + esc(t('models.refresh')) + '</button>' +
        '</div>' +
        '<div id="doc-table-wrap"><div class="empty-state"><span class="spinner"></span> ' + esc(t('status.loading')) + '</div></div>' +
      '</div>';

    $('#doc-refresh').addEventListener('click', refreshDocList);
    refreshDocList();
  }

  function refreshDocList() {
    apiJSON('/documents?collection=' + encodeURIComponent(docCollection)).then(function (data) {
      docList = data.documents || [];
      renderDocTable();
    }).catch(function () {
      var wrap = $('#doc-table-wrap');
      if (wrap) wrap.innerHTML = '<div class="empty-state">' + esc(t('status.error')) + '</div>';
    });
  }

  function renderDocTable() {
    var wrap = $('#doc-table-wrap');
    if (!wrap) return;

    if (docList.length === 0) {
      wrap.innerHTML = '<div class="empty-state">' + esc(t('documents.emptyState')) + '</div>';
      return;
    }

    var rows = docList.map(function (doc) {
      var statusClass = 'doc-status-' + doc.status;
      var statusText = t('documents.status' + doc.status.charAt(0).toUpperCase() + doc.status.slice(1));
      var sizeStr = doc.file_size < 1048576
        ? Math.round(doc.file_size / 1024) + ' KB'
        : (doc.file_size / 1048576).toFixed(1) + ' MB';
      var dateStr = doc.created_at ? new Date(doc.created_at + 'Z').toLocaleDateString() : '';
      return '<tr>' +
        '<td>' + esc(doc.original_name) + '</td>' +
        '<td class="mono">' + sizeStr + '</td>' +
        '<td>' + (doc.chunk_count || 0) + '</td>' +
        '<td><span class="doc-status-badge ' + statusClass + '">' + esc(statusText) + '</span></td>' +
        '<td class="mono">' + esc(dateStr) + '</td>' +
        '<td>' +
          '<button class="btn btn-sm" data-doc-chunks="' + esc(doc.id) + '">' + esc(t('documents.viewChunks')) + '</button> ' +
          '<button class="btn btn-sm" data-doc-reindex="' + esc(doc.id) + '">' + esc(t('documents.reindex')) + '</button> ' +
          '<button class="btn btn-sm btn-danger" data-doc-delete="' + esc(doc.id) + '" data-doc-name="' + esc(doc.original_name) + '">' + esc(t('documents.delete')) + '</button>' +
        '</td>' +
      '</tr>';
    }).join('');

    wrap.innerHTML =
      '<div class="table-wrapper"><table>' +
        '<thead><tr>' +
          '<th>' + esc(t('documents.name')) + '</th>' +
          '<th>' + esc(t('documents.size')) + '</th>' +
          '<th>' + esc(t('documents.chunks')) + '</th>' +
          '<th>' + esc(t('documents.statusCol')) + '</th>' +
          '<th>' + esc(t('documents.date')) + '</th>' +
          '<th>' + esc(t('documents.actions')) + '</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table></div>';

    // Action handlers via delegation
    wrap.addEventListener('click', function (e) {
      var chunksBtn = e.target.closest('[data-doc-chunks]');
      if (chunksBtn) { showChunkPreview(chunksBtn.dataset.docChunks); return; }

      var reindexBtn = e.target.closest('[data-doc-reindex]');
      if (reindexBtn) { reindexDocument(reindexBtn.dataset.docReindex, reindexBtn); return; }

      var deleteBtn = e.target.closest('[data-doc-delete]');
      if (deleteBtn) { confirmDeleteDocument(deleteBtn.dataset.docDelete, deleteBtn.dataset.docName); return; }
    });
  }

  function showChunkPreview(docId) {
    apiJSON('/documents/' + docId + '/chunks').then(function (data) {
      var chunks = data.chunks || [];
      var overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';
      overlay.innerHTML =
        '<div class="confirm-dialog" style="max-width:700px;max-height:80vh;overflow:auto">' +
          '<h3>' + esc(t('documents.chunkPreview')) + ' (' + chunks.length + ')</h3>' +
          '<div class="chunk-list">' +
            (chunks.length === 0 ? '<div class="empty-state">' + esc(t('documents.noResults')) + '</div>' :
            chunks.map(function (c, i) {
              return '<div class="chunk-item">' +
                '<div class="chunk-header">' + esc(t('documents.chunkN', { n: (c.chunk_index != null ? c.chunk_index + 1 : i + 1) })) +
                  ' <span class="text-muted">(' + (c.text || '').length + ' chars)</span></div>' +
                '<pre class="chunk-text">' + esc((c.text || '').substring(0, 500)) + (c.text && c.text.length > 500 ? '...' : '') + '</pre>' +
              '</div>';
            }).join('')) +
          '</div>' +
          '<div class="confirm-actions"><button class="btn" id="chunk-close">' + esc(t('models.close')) + '</button></div>' +
        '</div>';
      document.body.appendChild(overlay);
      overlay.querySelector('#chunk-close').addEventListener('click', function () { overlay.remove(); });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    }).catch(function (err) {
      showToast(t('status.errorDetail', { message: err.message || 'Failed to load chunks' }), 'error');
    });
  }

  function confirmDeleteDocument(docId, docName) {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-dialog danger-dialog">' +
        '<h3>' + esc(t('documents.deleteConfirmTitle')) + '</h3>' +
        '<p>' + esc(t('documents.deleteConfirmMessage', { name: docName })) + '</p>' +
        '<div class="confirm-actions">' +
          '<button class="btn" id="doc-del-cancel">' + esc(t('documents.cancel')) + '</button>' +
          '<button class="btn btn-danger" id="doc-del-confirm">' + esc(t('documents.delete')) + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var close = function () { overlay.remove(); };
    overlay.querySelector('#doc-del-cancel').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

    overlay.querySelector('#doc-del-confirm').addEventListener('click', function () {
      var btn = overlay.querySelector('#doc-del-confirm');
      btn.disabled = true;
      btn.textContent = t('status.loading');

      api('/documents/' + docId, { method: 'DELETE' }).then(function (res) {
        return res.json();
      }).then(function () {
        close();
        showToast(t('documents.deleteSuccess', { name: docName }), 'success');
        refreshDocList();
      }).catch(function () {
        close();
        showToast(t('documents.deleteError'), 'error');
      });
    });
  }

  function reindexDocument(docId, btn) {
    var origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = t('documents.reindexing');

    fetch('/admin/api/documents/' + docId + '/reindex', {
      method: 'POST',
      headers: { 'X-API-Key': state.apiKey },
    }).then(function (res) {
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      function pump() {
        return reader.read().then(function (result) {
          if (result.done) return;
          buffer += decoder.decode(result.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop();
          lines.forEach(function (line) {
            if (!line.startsWith('data: ')) return;
            try {
              var data = JSON.parse(line.slice(6));
              if (data.done) {
                showToast(t('documents.reindexSuccess', { name: '' }), 'success');
                btn.disabled = false;
                btn.textContent = origText;
                refreshDocList();
              }
              if (data.error) {
                showToast(t('documents.reindexError') + ': ' + data.error, 'error');
                btn.disabled = false;
                btn.textContent = origText;
              }
            } catch (e) { /* skip */ }
          });
          return pump();
        });
      }
      return pump();
    }).catch(function () {
      showToast(t('documents.reindexError'), 'error');
      btn.disabled = false;
      btn.textContent = origText;
    });
  }

  // ── Ask Sub-Tab ───────────────────────────────────────────

  function renderAskMode(ct) {
    askMessages = [];
    ct.innerHTML =
      '<div class="card" style="display:flex;flex-direction:column;height:calc(100vh - 240px);min-height:400px">' +
        '<div class="card-header">' +
          '<h2>' + esc(t('documents.askTitle')) + '</h2>' +
          '<select id="ask-model-select" class="filter-select" style="width:auto;min-width:150px"></select>' +
        '</div>' +
        '<div id="ask-messages" style="flex:1;overflow-y:auto;padding:1rem">' +
          '<div class="empty-state">' + esc(t('documents.askEmptyState')) + '</div>' +
        '</div>' +
        '<div style="padding:0.75rem;border-top:1px solid var(--border);display:flex;gap:0.5rem">' +
          '<textarea id="ask-input" rows="2" placeholder="' + esc(t('documents.askPlaceholder')) + '" style="flex:1;resize:none"></textarea>' +
          '<button class="btn btn-primary" id="ask-send">' + esc(t('playground.send')) + '</button>' +
        '</div>' +
      '</div>';

    // Load chat models
    apiJSON('/models').then(function (data) {
      var models = data.models || [];
      var chatModels = models.map(function (m) { return m.name || m.model || ''; }).filter(isChatModel);
      var select = $('#ask-model-select');
      var sendBtn = $('#ask-send');
      var input = $('#ask-input');
      if (!select) return;
      if (chatModels.length === 0) {
        select.innerHTML = '<option value="">' + esc(t('playground.noChatModels')) + '</option>';
        select.disabled = true;
        if (sendBtn) sendBtn.disabled = true;
        if (input) input.disabled = true;
        return;
      }
      select.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
      if (input) input.disabled = false;
      select.innerHTML = chatModels.map(function (name) {
        return '<option value="' + esc(name) + '">' + esc(name) + '</option>';
      }).join('');
    }).catch(function () {});

    $('#ask-send').addEventListener('click', sendAskQuery);
    $('#ask-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAskQuery(); }
    });
  }

  function sendAskQuery() {
    var input = $('#ask-input');
    var query = input ? input.value.trim() : '';
    if (!query) return;

    var modelSelect = $('#ask-model-select');
    var model = modelSelect ? modelSelect.value : 'llama3.1:8b';
    if (!model) {
      showToast(t('playground.noChatModels'), 'error');
      return;
    }
    input.value = '';

    var messagesEl = $('#ask-messages');
    if (!messagesEl) return;

    // Remove empty state
    var empty = messagesEl.querySelector('.empty-state');
    if (empty) empty.remove();

    // Add user message
    messagesEl.insertAdjacentHTML('beforeend',
      '<div style="margin-bottom:1rem">' +
        '<div class="text-muted text-sm" style="margin-bottom:0.25rem">' + esc(t('playground.userLabel')) + '</div>' +
        '<div>' + esc(query) + '</div>' +
      '</div>');

    // Add placeholder for assistant
    var assistantId = 'ask-resp-' + Date.now();
    messagesEl.insertAdjacentHTML('beforeend',
      '<div style="margin-bottom:1rem" id="' + assistantId + '">' +
        '<div class="text-muted text-sm" style="margin-bottom:0.25rem">' + esc(t('playground.assistantLabel')) + '</div>' +
        '<div id="' + assistantId + '-text"><span class="spinner"></span> ' + esc(t('documents.searching')) + '</div>' +
        '<div id="' + assistantId + '-sources"></div>' +
      '</div>');
    messagesEl.scrollTop = messagesEl.scrollHeight;

    // Send request
    fetch('/admin/api/documents/ask', {
      method: 'POST',
      headers: { 'X-API-Key': state.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, collection: docCollection, model: model }),
    }).then(function (res) {
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var answer = '';
      var sourcesRendered = false;

      function pump() {
        return reader.read().then(function (result) {
          if (result.done) return;
          buffer += decoder.decode(result.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop();
          lines.forEach(function (line) {
            if (!line.startsWith('data: ')) return;
            try {
              var data = JSON.parse(line.slice(6));

              // Sources phase
              if (data.phase === 'sources' && !sourcesRendered) {
                sourcesRendered = true;
                var sourcesEl = $id(assistantId + '-sources');
                if (sourcesEl && data.hits && data.hits.length > 0) {
                  sourcesEl.innerHTML = '<div class="rag-sources"><strong>' + esc(t('documents.sources')) + ':</strong> ' +
                    data.hits.map(function (h) {
                      return '<span class="rag-source-item">' + esc(h.filename) + ' #' + (h.chunk_index + 1) +
                        ' <span class="text-muted">(' + (Math.round(h.score * 100)) + '%)</span></span>';
                    }).join(' ') +
                  '</div>';
                }
              }

              // Answer streaming phase
              if (data.phase === 'answer' && data.message && data.message.content) {
                answer += data.message.content;
                var textEl = $id(assistantId + '-text');
                if (textEl) textEl.textContent = answer;
                messagesEl.scrollTop = messagesEl.scrollHeight;
              }

              // Error
              if (data.error) {
                var textEl2 = $id(assistantId + '-text');
                if (textEl2) textEl2.innerHTML = '<span style="color:var(--error)">' + esc(data.error) + '</span>';
              }
            } catch (e) { /* skip */ }
          });
          return pump();
        });
      }
      return pump();
    }).catch(function (err) {
      var textEl = $id(assistantId + '-text');
      if (textEl) textEl.innerHTML = '<span style="color:var(--error)">' + esc(err.message) + '</span>';
    });
  }

  // ── Collection Management ─────────────────────────────────

  function showCreateCollectionDialog() {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-dialog">' +
        '<h3>' + esc(t('documents.createCollection')) + '</h3>' +
        '<div class="form-group">' +
          '<label>' + esc(t('documents.collectionName')) + '</label>' +
          '<input type="text" id="new-coll-name" placeholder="my-collection" autocomplete="off">' +
        '</div>' +
        '<div class="confirm-actions">' +
          '<button class="btn" id="coll-cancel">' + esc(t('documents.cancel')) + '</button>' +
          '<button class="btn btn-primary" id="coll-create">' + esc(t('documents.createCollection')) + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var close = function () { overlay.remove(); };
    overlay.querySelector('#coll-cancel').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

    overlay.querySelector('#coll-create').addEventListener('click', function () {
      var nameInput = overlay.querySelector('#new-coll-name');
      var name = nameInput ? nameInput.value.trim() : '';
      if (!name) return;

      api('/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name }),
      }).then(function (res) { return res.json(); }).then(function () {
        close();
        showToast(t('documents.collectionCreated', { name: name }), 'success');
        docCollection = name;
        loadDocCollections();
      }).catch(function () {
        showToast(t('documents.collectionError'), 'error');
      });
    });
  }

  // ── Feedback Tab ─────────────────────────────────────────────

  function initFeedback(ct) {
    var GITHUB_REPO = 'IngressTechnology/jimbomesh-holler-server';

    ct.innerHTML =
      '<div class="card">' +
        '<div class="card-header">' +
          '<h3>📣 ' + esc(t('feedback.title')) + '</h3>' +
        '</div>' +
        '<div style="padding: 24px; display: flex; flex-direction: column; gap: 24px; max-width: 600px;">' +
          // Bug Report
          '<div>' +
            '<h4 style="margin: 0 0 4px 0; font-size: 14px; font-weight: 600; color: #e2e8f0;">Found a bug?</h4>' +
            '<button class="btn" id="btn-bug" style="width: 100%; margin: 8px 0; padding: 12px 24px; background: #FC6806; border-color: #FC6806; color: white; display: flex; align-items: center; justify-content: center; gap: 8px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: filter 0.2s;">' +
              '🐛 Report Bug' +
            '</button>' +
            '<p style="margin: 4px 0 0 0; font-size: 13px; color: #8b949e;">Opens GitHub — report with your GitHub account</p>' +
          '</div>' +
          // Feature Request
          '<div>' +
            '<h4 style="margin: 0 0 4px 0; font-size: 14px; font-weight: 600; color: #e2e8f0;">Got an idea?</h4>' +
            '<button class="btn" id="btn-feature" style="width: 100%; margin: 8px 0; padding: 12px 24px; background: #089484; border-color: #089484; color: white; display: flex; align-items: center; justify-content: center; gap: 8px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: filter 0.2s;">' +
              '💡 Request Feature' +
            '</button>' +
            '<p style="margin: 4px 0 0 0; font-size: 13px; color: #8b949e;">Opens GitHub — request with your GitHub account</p>' +
          '</div>' +
          // Divider
          '<hr style="border: none; border-top: 1px solid rgba(100, 116, 139, 0.2); margin: 8px 0;">' +
          // Star
          '<div>' +
            '<h4 style="margin: 0 0 4px 0; font-size: 14px; font-weight: 600; color: #e2e8f0;">Enjoying the Holler?</h4>' +
            '<button class="btn" id="btn-star" style="width: 100%; margin: 8px 0; padding: 12px 24px; background: transparent; border: 2px solid #089484; color: #089484; display: flex; align-items: center; justify-content: center; gap: 8px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: filter 0.2s;">' +
              '⭐ Star on GitHub ' +
              '<span id="star-count" style="display: none; background: #1a1a2e; padding: 2px 8px; border-radius: 12px; font-size: 12px; color: white;"></span>' +
            '</button>' +
            '<p style="margin: 4px 0 0 0; font-size: 13px; color: #8b949e;">Give us a ⭐ — it helps others find us!</p>' +
          '</div>' +
        '</div>' +
      '</div>';

    // Attach event handlers
    var bugBtn = $('#btn-bug');
    if (bugBtn) {
      bugBtn.addEventListener('click', function() {
        var systemInfo = '**Platform:** ' + navigator.platform + '\\n**Browser:** ' + navigator.userAgent;
        var body = encodeURIComponent(
          '## System Info\n' + systemInfo.replace(/\\n/g, '\n') + '\n\n' +
          '## Description\n\n' +
          '## Steps to Reproduce\n1. \n2. \n3. \n\n' +
          '## Expected Behavior\n\n' +
          '## Logs\n```\n\n```\n'
        );
        window.open('https://github.com/' + GITHUB_REPO + '/issues/new?template=bug_report.yml&title=%5BBug%5D%3A+&body=' + body, '_blank');
      });
      bugBtn.addEventListener('mouseenter', function() { this.style.filter = 'brightness(1.1)'; });
      bugBtn.addEventListener('mouseleave', function() { this.style.filter = ''; });
    }

    var featureBtn = $('#btn-feature');
    if (featureBtn) {
      featureBtn.addEventListener('click', function() {
        window.open('https://github.com/' + GITHUB_REPO + '/issues/new?template=feature_request.yml', '_blank');
      });
      featureBtn.addEventListener('mouseenter', function() { this.style.filter = 'brightness(1.1)'; });
      featureBtn.addEventListener('mouseleave', function() { this.style.filter = ''; });
    }

    var starBtn = $('#btn-star');
    if (starBtn) {
      starBtn.addEventListener('click', function() {
        window.open('https://github.com/' + GITHUB_REPO, '_blank');
      });
      starBtn.addEventListener('mouseenter', function() { this.style.filter = 'brightness(1.2)'; });
      starBtn.addEventListener('mouseleave', function() { this.style.filter = ''; });
    }

    // Fetch star count
    fetch('https://api.github.com/repos/' + GITHUB_REPO)
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var badge = $('#star-count');
        if (badge && d.stargazers_count !== undefined) {
          badge.textContent = '★ ' + d.stargazers_count;
          badge.style.display = 'inline';
        }
      })
      .catch(function() {});
  }

  // ── Boot ──────────────────────────────────────────────────────

  var i18nReady = window.i18n ? window.i18n.loadAll() : Promise.resolve();

  i18nReady.catch(function () {}).then(function () {
    if (window.i18n) {
      window.i18n.onChange(function () { render(); });
    }

    fetch('/admin/api/branding')
      .then(function (r) { return r.json(); })
      .then(function (b) {
        state.serverName = b.serverName || 'Holler Server';
        if (b.adminTitle) document.title = b.adminTitle;
      })
      .catch(function () {})
      .then(tryRestore);
  });

})();
