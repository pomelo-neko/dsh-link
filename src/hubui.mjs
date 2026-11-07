// dsh-link hub web console (0.8): a single, dependency-free HTML page served at /ui.
//
// The page itself carries no secrets: the operator pastes an admin token, which the page keeps in
// localStorage and sends as a Bearer header on same-origin admin API calls. Everything the console
// shows comes from /api/v1/hub/* endpoints and every mutation goes through the same admin routes
// the CLI uses. Serving the HTML without a token is deliberate: it is a login page, it holds no hub
// data, and all hub APIs still require a token (the hub never trusts loopback addresses).
export const HUB_UI_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>dsh-link hub 控制台</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%232f6fa8'/%3E%3Cpath d='M3 8h2l1.5-3 2 6 1.5-3h3' stroke='white' stroke-width='1.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<style>
  :root { --bg:#0f1722; --panel:#16202e; --panel2:#1c2938; --line:#26374b; --text:#d7e2ef; --muted:#8b9cb1; --accent:#2f6fa8; --accent2:#3d86c6; --ok:#3fb950; --warn:#d29922; --danger:#f85149; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.55 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
  code { font-family: ui-monospace, Consolas, monospace; background:var(--panel2); padding:1px 5px; border-radius:4px; }
  .hidden { display:none !important; }
  .muted { color:var(--muted); }
  .error-text { color:var(--danger); font-size:12px; }
  header { position:sticky; top:0; z-index:10; display:flex; align-items:center; gap:14px; padding:10px 18px; background:var(--panel); border-bottom:1px solid var(--line); }
  .brand { font-weight:600; font-size:16px; letter-spacing:.3px; }
  .brand .pill { font-size:11px; padding:1px 7px; border-radius:999px; background:var(--accent); color:#fff; margin-left:4px; vertical-align:2px; }
  .meta { color:var(--muted); }
  .spacer { flex:1; }
  .chip { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; border:1px solid var(--line); color:var(--muted); }
  .chip-ok { color:var(--ok); border-color:rgba(63,185,80,.4); background:rgba(63,185,80,.08); }
  .chip-warn { color:var(--warn); border-color:rgba(210,153,34,.4); background:rgba(210,153,34,.08); }
  .chip-off { color:var(--muted); }
  .btn { background:var(--panel2); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:6px 12px; cursor:pointer; font:inherit; }
  .btn:hover { border-color:var(--accent2); }
  .btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  .btn.primary:hover { background:var(--accent2); }
  .btn.danger { color:var(--danger); border-color:rgba(248,81,73,.35); }
  .btn.ghost { background:transparent; }
  .btn.small { padding:3px 8px; font-size:12px; }
  main { max-width:1180px; margin:0 auto; padding:18px; display:flex; flex-direction:column; gap:16px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; }
  .card-head { display:flex; align-items:center; gap:12px; margin-bottom:12px; flex-wrap:wrap; }
  .card-head h2 { margin:0; font-size:15px; }
  .card-head .grow { flex:1; }
  .login { max-width:560px; margin:48px auto; }
  .login h1 { margin:0 0 8px; font-size:20px; }
  .login p { margin:0 0 14px; }
  .row { display:flex; align-items:center; gap:10px; }
  .row.wrap { flex-wrap:wrap; }
  input, select, textarea { background:var(--panel2); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:7px 10px; font:inherit; }
  input:focus, select:focus { outline:1px solid var(--accent2); }
  input.short { width:200px; }
  input.tiny { width:78px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px; }
  .stat { background:linear-gradient(180deg, var(--panel), var(--panel2)); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .stat .value { font-size:24px; font-weight:600; margin:2px 0; }
  .stat .label { color:var(--muted); font-size:12px; }
  .table-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:top; white-space:nowrap; }
  td.wrap-cell { white-space:normal; word-break:break-all; }
  th { color:var(--muted); font-weight:500; font-size:12px; }
  tbody tr:hover { background:rgba(47,111,168,.08); }
  td.empty { color:var(--muted); text-align:center; padding:18px; white-space:normal; }
  .minted { margin:12px 0; padding:12px; border:1px dashed var(--warn); border-radius:8px; background:rgba(210,153,34,.06); }
  .minted code { font-size:13px; word-break:break-all; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:12px 18px; margin-bottom:12px; }
  .field { display:flex; flex-direction:column; gap:4px; }
  .field label { font-size:12px; color:var(--muted); }
  .field .hint { font-size:11px; color:var(--muted); }
  .toast { position:fixed; right:18px; bottom:18px; max-width:420px; background:var(--panel2); border:1px solid var(--line); border-left:3px solid var(--ok); border-radius:8px; padding:10px 14px; box-shadow:0 8px 24px rgba(0,0,0,.4); z-index:50; }
  .toast.error { border-left-color:var(--danger); }
  .login .error { color:var(--danger); margin:10px 0 0; }
  .modal { position:fixed; inset:0; z-index:60; background:rgba(6,10,16,.82); display:flex; align-items:center; justify-content:center; padding:18px; }
  .modal-card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px; width:min(560px,100%); max-height:92vh; overflow:auto; }
  .qr-wrap { display:flex; align-items:center; justify-content:center; background:#fff; border-radius:10px; padding:12px; margin:12px 0; }
  #qrCanvas { width:min(74vw,440px); height:auto; image-rendering:pixelated; }
  footer { color:var(--muted); text-align:center; font-size:12px; padding:12px 0 28px; }
  @media (max-width:700px) { header { flex-wrap:wrap; } .meta { display:none; } }
</style>
</head>
<body>
<header>
  <div class="brand">dsh-link <span class="pill">hub</span></div>
  <div class="meta"><span id="hubName">—</span> <span id="hubVersion"></span></div>
  <div class="spacer"></div>
  <span id="conn" class="chip chip-off">未连接</span>
  <button id="refreshBtn" class="btn ghost hidden" type="button">刷新</button>
  <button id="logoutBtn" class="btn ghost hidden" type="button">退出</button>
</header>

<section id="login" class="card login">
  <h1>连接 hub 控制台</h1>
  <p class="muted">输入 hub 的 admin 令牌（用 <code>dshlink hub token new --role admin</code> 或本页生成）。令牌只保存在本浏览器 localStorage，不会发送到 hub 以外的地方。</p>
  <div class="row">
    <input id="tokenInput" type="password" placeholder="admin token" autocomplete="off" style="flex:1">
    <button id="loginBtn" class="btn primary" type="button">连接</button>
  </div>
  <p id="loginError" class="error hidden"></p>
</section>

<main id="app" class="hidden">
  <section class="cards" id="cards"></section>

  <section class="card">
    <div class="card-head"><h2>节点</h2><span class="muted" id="nodesHint"></span></div>
    <div id="nodesTable" class="table-wrap"></div>
  </section>

  <section class="card">
    <div class="card-head"><h2>接入令牌</h2><span class="muted">enroll 令牌用于让新节点自动加入；默认 2 小时内有效、仅可使用一次。</span></div>
    <div class="row wrap">
      <input id="tkLabel" placeholder="标签（例如 laptop）" class="short">
      <select id="tkRole">
        <option value="enroll">enroll（节点自动接入）</option>
        <option value="admin">admin（全权限）</option>
        <option value="device">device（手机只读 + 控制）</option>
      </select>
      <input id="tkTtl" type="number" min="0" value="2" title="有效小时数，0 表示不过期" class="tiny">
      <span class="muted">小时有效</span>
      <input id="tkMax" type="number" min="1" value="1" title="最多可被使用次数" class="tiny">
      <span class="muted">次</span>
      <button id="mintBtn" class="btn primary" type="button">生成令牌</button>
    </div>
    <div id="minted" class="minted hidden">
      <div class="muted">令牌只显示一次，请立即复制并交给节点：</div>
      <div class="row"><code id="mintedToken"></code><button id="copyBtn" class="btn" type="button">复制</button></div>
      <div class="muted" id="mintedHint"></div>
    </div>
    <div id="tokensTable" class="table-wrap"></div>
  </section>

  <section class="card">
    <div class="card-head"><h2>手机证书（0.10）</h2><span class="muted">每部手机一张由 hub phone CA 签发的客户端证书；连接串只含 CA 公钥与一次性 secret，不含 hub 令牌或 CA 私钥。需要先在 hub 上运行 dshlink hub phone setup。</span></div>
    <div class="muted" id="phoneV2Hint">加载中…</div>
    <div class="stats" id="phoneV2Stats" style="margin-top:8px"></div>
    <div class="row wrap" style="margin-top:10px">
      <input id="pvLabel" placeholder="标签（例如 alice 的手机）" class="short">
      <input id="pvTtl" type="number" min="1" value="2" title="引导码有效小时数" class="tiny">
      <span class="muted">小时有效</span>
      <input id="pvMax" type="number" min="1" value="1" title="最多可被使用次数" class="tiny">
      <span class="muted">次</span>
      <input id="pvUrl" placeholder="手机可访问的 https 网关地址（无隧道时必填，如 https://127.0.0.1:8791）" class="short" style="min-width:300px">
      <label class="muted"><input id="pvTunnel" type="checkbox" checked> 使用 phone-frps 隧道</label>
      <button id="pvBtn" class="btn primary" type="button">生成证书引导码</button>
    </div>
    <div id="pvOut" class="minted hidden">
      <div class="muted" id="pvMeta"></div>
      <textarea id="pvCode" readonly rows="4" style="width:100%;box-sizing:border-box;font-family:monospace;font-size:12px"></textarea>
      <div class="row wrap"><button id="pvCopy" class="btn" type="button">复制引导码</button><button id="pvDownload" class="btn" type="button">下载引导文件</button><button id="pvQr" class="btn primary" type="button">显示二维码</button></div>
      <div class="muted">手机 App 0.6.0+ 导入 dshlink2: 引导码 → 自动生成密钥对并换取客户端证书。引导码只能用一次。App 0.6.2+ 可直接扫描二维码（多帧自动累积，码太长时不是一张图）。</div>
    </div>
    <div class="card-head" style="margin-top:12px"><h3 style="margin:0;font-size:14px">已登记的手机</h3><span class="muted" id="pvDeviceHint"></span></div>
    <div id="pvDevices" class="table-wrap"></div>
    <div class="card-head" style="margin-top:12px"><h3 style="margin:0;font-size:14px">引导码</h3><span class="muted">一次性，过期或用完后失效</span></div>
    <div id="pvBootstraps" class="table-wrap"></div>
  </section>

  <section class="card">
    <div class="card-head"><h2>手机接入（旧版 dshlink1）</h2><span class="muted">为一部手机生成一次性连接串：内含 device 令牌；hub 已启用 FRP 时还会内嵌 STCP 隧道与证书。APK 本身不含任何密钥。</span></div>
    <div class="row wrap">
      <input id="phLabel" placeholder="标签（例如 我的手机）" class="short">
      <input id="phTtl" type="number" min="0" value="2" title="有效小时数，0 表示不过期" class="tiny">
      <span class="muted">小时有效</span>
      <input id="phUrl" placeholder="手机可访问的 hub 地址（无 STCP 时必填，如 http://192.0.2.10:8790）" class="short" style="min-width:300px">
      <button id="phoneBtn" class="btn primary" type="button">生成手机连接串</button>
    </div>
    <div id="phoneOut" class="minted hidden">
      <div class="muted" id="phoneMeta"></div>
      <textarea id="phoneCode" readonly rows="4" style="width:100%;box-sizing:border-box;font-family:monospace;font-size:12px"></textarea>
      <div class="row wrap"><button id="phoneCopy" class="btn" type="button">复制连接串</button><button id="phoneDownload" class="btn" type="button">下载连接文件</button><button id="phoneQr" class="btn primary" type="button">显示二维码</button></div>
      <div class="muted">手机 App 0.5.0+：导入连接串 → 粘贴；或把下载的文件发到手机后从文件导入。令牌只显示这一次。App 0.6.2+ 可直接扫描二维码（多帧自动累积）。</div>
    </div>
  </section>

  <section class="card">
    <div class="card-head"><h2>缓存区（待投递队列）</h2>
      <div class="grow"></div>
      <label class="muted"><input id="pendingOnly" type="checkbox" checked> 只看待投递</label>
      <button id="flushBtn" class="btn" type="button">立即重投</button>
    </div>
    <div id="outboxTable" class="table-wrap"></div>
  </section>

  <section class="card">
    <div class="card-head"><h2>运行中的会话</h2><span class="muted">仅聚合状态，不含对话正文</span></div>
    <div id="runningTable" class="table-wrap"></div>
  </section>

  <section class="card">
    <div class="card-head"><h2>设置</h2><span class="muted">修改后立即生效并写入 hub 配置文件</span></div>
    <div id="settingsForm" class="grid"></div>
    <div class="row"><button id="saveSettingsBtn" class="btn primary" type="button">保存设置</button></div>
  </section>

  <section class="card">
    <div class="card-head"><h2>审计</h2><div class="grow"></div><button id="auditBtn" class="btn" type="button">加载最近 50 条</button></div>
    <div id="auditTable" class="table-wrap"></div>
  </section>
</main>

<div id="qrModal" class="modal hidden">
  <div class="modal-card">
    <div class="card-head"><h2 id="qrTitle">扫描二维码</h2><div class="grow"></div><button id="qrClose" class="btn" type="button">关闭</button></div>
    <div class="muted" id="qrHint">帧会自动循环；手机端的扫码页会自动累积已扫到的帧。</div>
    <div class="qr-wrap"><canvas id="qrCanvas" width="440" height="440"></canvas></div>
    <div class="row"><span class="chip" id="qrFrame">1/1</span><span class="muted" id="qrMeta"></span></div>
  </div>
</div>
<div id="toast" class="toast hidden"></div>
<footer>dsh-link hub __VERSION__ · 控制台仅同源调用 /api/v1，令牌保存在本浏览器</footer>

<script>
(function () {
  'use strict';
  var TOKEN_KEY = 'dshlink-hub-token';
  var state = {
    token: '', timer: null, signedIn: false, settingsDirty: false, mintedToken: '', phoneCode: '', phoneCodeV2: '',
    status: null, nodes: [], tokens: [], outbox: [], hub: null, settings: null,
    consoleUrl: '', running: null, phone: null, qr: null, qrTimer: null, qrIndex: 0
  };

  function $(id) { return document.getElementById(id); }
  function show(id, visible) { var node = $(id); if (node) node.classList.toggle('hidden', !visible); }
  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, function (ch) {
      var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return map[ch];
    });
  }
  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return esc(ts);
    return d.toLocaleString();
  }
  function shortId(id) {
    var text = String(id || '');
    return text.length > 18 ? text.slice(0, 8) + '…' + text.slice(-6) : text;
  }
  function fmtDuration(sec) {
    var s = Number(sec) || 0;
    if (s < 60) return s + ' 秒';
    if (s < 3600) return Math.round(s / 60) + ' 分钟';
    if (s < 86400) return (s / 3600).toFixed(1) + ' 小时';
    return (s / 86400).toFixed(1) + ' 天';
  }
  function fmtBytes(n) {
    var v = Number(n) || 0;
    if (v >= 1073741824) return (v / 1073741824).toFixed(1) + ' GiB';
    if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MiB';
    if (v >= 1024) return (v / 1024).toFixed(1) + ' KiB';
    return v + ' B';
  }
  function toast(message, isError) {
    var node = $('toast');
    node.textContent = message;
    node.className = 'toast' + (isError ? ' error' : '');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { node.className = 'toast hidden'; }, isError ? 6000 : 3200);
  }
  function request(path, options) {
    options = options || {};
    var headers = { accept: 'application/json' };
    if (state.token) headers.authorization = 'Bearer ' + state.token;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    return fetch(path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    }).then(function (response) {
      return response.text().then(function (text) {
        var payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch (err) { payload = null; }
        if (!response.ok) {
          var error = new Error((payload && payload.error && payload.error.message) || ('HTTP ' + response.status));
          error.status = response.status;
          error.code = payload && payload.error ? payload.error.code : 'http_error';
          throw error;
        }
        return payload;
      });
    });
  }
  function table(headers, rows, empty) {
    var html = '<table><thead><tr>';
    for (var h = 0; h < headers.length; h += 1) html += '<th>' + esc(headers[h]) + '</th>';
    html += '</tr></thead><tbody>';
    if (!rows.length) html += '<tr><td class="empty" colspan="' + headers.length + '">' + esc(empty || '暂无数据') + '</td></tr>';
    for (var r = 0; r < rows.length; r += 1) {
      html += '<tr>';
      for (var c = 0; c < rows[r].length; c += 1) html += '<td>' + rows[r][c] + '</td>';
      html += '</tr>';
    }
    return html + '</tbody></table>';
  }
  var CHIPS = {
    online: ['在线', 'ok'], active: ['已启用', 'ok'], pending: ['待批准', 'warn'],
    offline: ['离线', 'off'], disabled: ['已停用', 'off'], delivered: ['已送达', 'ok'], revoked: ['已吊销', 'off'], used: ['已使用', 'off'],
    dropped: ['已丢弃', 'off'], unknown: ['未知', 'warn'], ok: ['正常', 'ok']
  };
  function chip(status) {
    var pair = CHIPS[status] || [status || '未知', 'off'];
    return '<span class="chip chip-' + pair[1] + '">' + esc(pair[0]) + '</span>';
  }
  function statCard(value, label, hint) {
    return '<div class="stat"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div><div class="label">' + esc(hint || '') + '</div></div>';
  }
  function field(label, control, hint) {
    return '<div class="field"><label>' + esc(label) + '</label>' + control + (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') + '</div>';
  }
  function checkbox(id, checked) {
    return '<label class="row"><input id="' + id + '" type="checkbox"' + (checked ? ' checked' : '') + '> <span class="muted">启用</span></label>';
  }

  function connected(ok, text) {
    var node = $('conn');
    node.textContent = text;
    node.className = 'chip ' + (ok ? 'chip-ok' : 'chip-off');
  }
  function loginError(message) {
    var node = $('loginError');
    node.textContent = message || '';
    show('loginError', !!message);
  }

  function startPolling() {
    stopPolling();
    state.timer = setInterval(function () { if (!document.hidden) load(true); }, 5000);
  }
  function stopPolling() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }

  function login() {
    var token = $('tokenInput').value.trim();
    if (!token) { loginError('请输入 admin 令牌'); return; }
    state.token = token;
    loginError('');
    request('/api/v1/hub/status').then(function () {
      localStorage.setItem(TOKEN_KEY, token);
      state.signedIn = true;
      show('login', false);
      show('app', true);
      show('refreshBtn', true);
      show('logoutBtn', true);
      connected(true, '已连接');
      startPolling();
      return load(true);
    }).catch(function (err) {
      state.signedIn = false;
      stopPolling();
      show('app', false);
      show('login', true);
      show('refreshBtn', false);
      show('logoutBtn', false);
      connected(false, '未连接');
      loginError('连接失败：' + (err.message || String(err)));
    });
  }
  function logout() {
    stopQr();
    localStorage.removeItem(TOKEN_KEY);
    state.token = '';
    state.signedIn = false;
    state.mintedToken = '';
    stopPolling();
    $('tokenInput').value = '';
    show('minted', false);
    show('app', false);
    show('login', true);
    show('refreshBtn', false);
    show('logoutBtn', false);
    $('hubName').textContent = '—';
    $('hubVersion').textContent = '';
    connected(false, '未连接');
  }

  function load(quiet) {
    if (!state.token) return Promise.resolve();
    var pending = $('pendingOnly').checked ? '&pending=1' : '';
    return Promise.all([
      request('/api/v1/hub/status'),
      request('/api/v1/hub/nodes'),
      request('/api/v1/hub/tokens'),
      request('/api/v1/hub/config'),
      request('/api/v1/hub/outbox?limit=100' + pending),
      request('/api/v1/hub/sessions/running').catch(function () { return null; }),
      request('/api/v1/hub/phone/status').catch(function () { return null; })
    ]).then(function (results) {
      state.status = results[0] || {};
      state.nodes = (results[1] && results[1].nodes) || [];
      state.tokens = (results[2] && results[2].tokens) || [];
      state.hub = (results[3] && results[3].hub) || null;
      state.settings = (results[3] && results[3].settings) || null;
      state.consoleUrl = (results[3] && results[3].console && results[3].console.url) || '';
      state.outbox = (results[4] && results[4].messages) || [];
      state.running = results[5] || null;
      state.phone = results[6] || null;
      state.signedIn = true;
      show('login', false);
      show('app', true);
      render();
      connected(true, '已连接');
    }).catch(function (err) {
      connected(false, '连接失败');
      if (err && err.status === 401) {
        state.signedIn = false;
        stopPolling();
        show('app', false);
        show('login', true);
        loginError('令牌无效或已过期');
        return;
      }
      if (!quiet) toast(err.message || String(err), true);
    });
  }

  function render() {
    var status = state.status || {};
    var hub = status.hub || state.hub || {};
    $('hubName').textContent = hub.name || 'hub';
    $('hubVersion').textContent = hub.softwareVersion ? ('v' + hub.softwareVersion) : '';
    var nodes = state.nodes || [];
    var online = 0;
    for (var i = 0; i < nodes.length; i += 1) if (nodes[i].status === 'online') online += 1;
    var counts = status.counts || {};
    var frp = status.frp || {};
    var cards = [
      statCard(String(online) + ' / ' + String(nodes.length), '节点在线', '网络中的 DSH 节点'),
      statCard(String(counts.outboxPending === undefined ? 0 : counts.outboxPending), '待投递队列', '缓存区等待重试的消息'),
      statCard(fmtDuration(status.uptimeSeconds), '运行时长', 'hub 进程已运行'),
      statCard(frp.enabled ? (frp.running ? '运行中' : '未运行') : '未启用', 'STCP / FRP', 'hub 自己的 frp 通道')
    ];
    $('cards').innerHTML = cards.join('');
    $('nodesHint').textContent = '在线 ' + online + ' / 共 ' + nodes.length + ' 个';
    renderNodes(nodes);
    renderTokens(state.tokens);
    renderOutbox(state.outbox);
    renderRunning(state.running);
    renderPhone(state.phone);
    if (!state.settingsDirty) renderSettings(state.settings);
  }

  function renderNodes(nodes) {
    var rows = [];
    for (var i = 0; i < nodes.length; i += 1) {
      var n = nodes[i];
      var actions = '';
      if (n.status === 'pending') actions += '<button class="btn small primary" data-action="approve" data-name="' + esc(n.name) + '">批准</button> ';
      actions += '<button class="btn small danger" data-action="revoke-node" data-name="' + esc(n.name) + '">移除</button>';
      rows.push([
        '<strong>' + esc(n.name) + '</strong>',
        chip(n.status),
        n.softwareVersion ? esc(n.softwareVersion) : '—',
        n.visitorPort ? '<code>' + esc(n.visitorPort) + '</code>' : '—',
        fmtTime(n.lastHeartbeatAt),
        actions
      ]);
    }
    $('nodesTable').innerHTML = table(['节点', '状态', '版本', 'visitor 端口', '最后心跳', '操作'], rows,
      '还没有节点接入。在下方生成 enroll 令牌，交给节点执行 dshlink hub enroll。');
  }

  function renderTokens(tokens) {
    var rows = [];
    for (var i = 0; i < tokens.length; i += 1) {
      var t = tokens[i];
      rows.push([
        '<code>' + esc(t.id) + '</code>',
        esc(t.label || '—'),
        chip(t.role === 'enroll' ? 'active' : 'online').replace(/>[^<]*</, '>' + esc(t.role) + '<'),
        esc(t.peer || '—'),
        t.expiresAt ? fmtTime(t.expiresAt) : '不过期',
        t.maxUses === null || t.maxUses === undefined ? '不限' : String(t.maxUses),
        String(t.uses === undefined ? 0 : t.uses),
        '<button class="btn small danger" data-action="revoke-token" data-id="' + esc(t.id) + '">吊销</button>'
      ]);
    }
    $('tokensTable').innerHTML = table(['ID', '标签', '角色', '绑定节点', '过期时间', '最大次数', '已用', '操作'], rows,
      '还没有令牌。当前连接的 admin 令牌也可在此生成的列表中看到。');
  }

  function renderOutbox(messages) {
    var rows = [];
    for (var i = 0; i < messages.length; i += 1) {
      var m = messages[i];
      var d = m.delivery || {};
      rows.push([
        fmtTime(m.ts),
        '<code>' + esc(shortId(m.id)) + '</code>',
        esc((m.from || '—') + ' → ' + (m.to || '—')),
        esc(m.subject || ''),
        chip(d.state || 'pending'),
        String(d.attempts === undefined ? 0 : d.attempts),
        d.nextAttemptAt ? fmtTime(d.nextAttemptAt) : '—',
        d.error ? '<span class="error-text">' + esc(d.error) + '</span>' : '—',
        '<button class="btn small" data-action="retry-msg" data-id="' + esc(m.id) + '">重投</button> ' +
          '<button class="btn small danger" data-action="drop-msg" data-id="' + esc(m.id) + '">丢弃</button>'
      ]);
    }
    $('outboxTable').innerHTML = table(['时间', 'ID', '方向', '主题', '状态', '尝试', '下次重试', '错误', '操作'], rows,
      '缓存区为空 —— 所有消息都已送达，或还没有跨节点消息。');
  }

  function renderRunning(running) {
    var rows = [];
    if (running && running.nodes) {
      for (var i = 0; i < running.nodes.length; i += 1) {
        var node = running.nodes[i];
        var sessions = node.sessions || [];
        var active = [];
        var count = 0;
        for (var j = 0; j < sessions.length; j += 1) {
          if (sessions[j].running) {
            count += 1;
            active.push(sessions[j].title || shortId(sessions[j].sessionId));
          }
        }
        rows.push([
          esc(node.name),
          node.online ? chip('online') : chip('offline'),
          String(node.running === undefined ? count : node.running),
          esc(active.join('、') || '—')
        ]);
      }
    }
    $('runningTable').innerHTML = table(['节点', '链路', '运行中', '会话'], rows,
      '暂无可展示的运行中会话（节点需要在 DSH host 上运行 dsh-link-bridge）。');
  }

  function renderPhone(phone) {
    phone = phone || {};
    var gateway = phone.gateway || {};
    var tunnel = phone.tunnel || {};
    var devices = phone.devices || [];
    var bootstraps = phone.bootstraps || [];
    var activeDevices = 0;
    for (var i = 0; i < devices.length; i += 1) if (devices[i].status === 'active') activeDevices += 1;
    var activeBootstraps = 0;
    for (var j = 0; j < bootstraps.length; j += 1) if (bootstraps[j].status === 'active') activeBootstraps += 1;
    var gatewayUrl = gateway.url || (gateway.port ? 'https://' + (gateway.bind || '127.0.0.1') + ':' + gateway.port : '');
    var hint = '未启用：在 hub 上运行 dshlink hub phone setup，然后重启 hub serve。';
    if (gateway.enabled) {
      hint = '网关 ' + (gateway.listening ? '运行中' : '未监听') + (gatewayUrl ? ' · ' + gatewayUrl : '') +
        (gateway.caFingerprint ? ' · CA ' + shortFingerprint(gateway.caFingerprint) : '') +
        ' · 注入令牌' + (gateway.hubTokenSet ? '已配置' : '未配置');
      if (gateway.reason) hint += ' · ' + gateway.reason;
    } else if (gateway.reason) {
      hint = '未启用：' + gateway.reason + '（运行 dshlink hub phone setup 后重启 hub serve）';
    }
    $('phoneV2Hint').textContent = hint;
    var tunnelText = tunnel.enabled ? (tunnel.running ? '运行中' : '未运行') : '未启用';
    $('phoneV2Stats').innerHTML = [
      statCard(String(activeDevices) + ' / ' + String(devices.length), '手机证书', '有效 / 已登记'),
      statCard(tunnelText, 'phone-frps', '独立隧道租户'),
      statCard(String(activeBootstraps), '有效引导码', '一次性、有 TTL')
    ].join('');
    $('pvDeviceHint').textContent = gateway.enabled ? '吊销后该手机下一次 TLS 握手即被拒绝' : '先启用手机网关';
    var rows = [];
    for (var d = 0; d < devices.length; d += 1) {
      var item = devices[d];
      var actions = item.status === 'revoked'
        ? '<span class="muted">已吊销</span>'
        : '<button class="btn small danger" data-action="revoke-phone" data-id="' + esc(item.id) + '" data-name="' + esc(item.deviceId || item.label || '') + '">吊销</button>';
      rows.push([
        esc(item.label || '—'),
        '<code>' + esc(item.deviceId || item.id) + '</code>',
        chip(item.status),
        '<code>' + esc(shortFingerprint(item.fingerprint)) + '</code>',
        fmtTime(item.createdAt),
        item.lastSeenAt ? fmtTime(item.lastSeenAt) : '—',
        actions
      ]);
    }
    $('pvDevices').innerHTML = table(['标签', '设备', '状态', '证书指纹', '登记时间', '最后使用', '操作'], rows,
      '还没有手机登记。生成一个引导码，在手机 App 0.6.0+ 导入即可自动换取证书。');
    var bootstrapRows = [];
    for (var b = 0; b < bootstraps.length; b += 1) {
      var boot = bootstraps[b];
      var bootActions = boot.status === 'active'
        ? '<button class="btn small danger" data-action="revoke-bootstrap" data-id="' + esc(boot.id) + '">作废</button>'
        : '<span class="muted">—</span>';
      bootstrapRows.push([
        '<code>' + esc(boot.id) + '</code>',
        esc(boot.label || '—'),
        chip(boot.status),
        String(boot.uses === undefined ? 0 : boot.uses) + ' / ' + String(boot.maxUses === undefined ? 1 : boot.maxUses),
        boot.expiresAt ? fmtTime(boot.expiresAt) : '—',
        bootActions
      ]);
    }
    $('pvBootstraps').innerHTML = table(['ID', '标签', '状态', '已用 / 上限', '过期时间', '操作'], bootstrapRows,
      '还没有引导码。每个引导码只能用一次，过期即失效。');
  }

  function shortFingerprint(value) {
    var text = String(value || '');
    return text.length > 23 ? text.slice(0, 23) + '…' : text;
  }
  function renderSettings(settings) {
    var form = $('settingsForm');
    if (!settings) { form.innerHTML = '<p class="muted">设置不可用（需要 admin 令牌）。</p>'; return; }
    var e = settings.enrollment || {};
    var f = settings.files || {};
    var options = '<option value=""' + (!settings.defaultNode ? ' selected' : '') + '>自动（唯一节点时）</option>';
    for (var i = 0; i < state.nodes.length; i += 1) {
      var n = state.nodes[i];
      options += '<option value="' + esc(n.name) + '"' + (settings.defaultNode === n.name ? ' selected' : '') + '>' + esc(n.name) + '</option>';
    }
    var html = '';
    html += field('控制台地址', '<code>' + esc(state.consoleUrl || (location.origin + '/ui')) + '</code>', '本机浏览器打开；远程请用 STCP / frp 暴露 hub 端口');
    html += field('默认节点', '<select id="setDefaultNode">' + options + '</select>', '未指定 peer 的请求默认发往哪个节点');
    html += field('消息保留（秒）', '<input id="setMessageTtl" type="number" min="60" value="' + esc(settings.messageTtlSeconds) + '">', '超过该时间的未投递消息会被丢弃');
    html += field('重试间隔（秒）', '<input id="setRetry" type="number" min="1" value="' + esc(settings.retrySeconds) + '">', '投递失败后的基础重试间隔');
    html += field('单节点队列上限', '<input id="setMaxPending" type="number" min="1" value="' + esc(settings.maxPendingPerTarget) + '">', '同一目标待投递消息过多时拒绝新消息');
    html += field('自动批准新节点', checkbox('setAutoApprove', e.autoApprove === true), '关闭后新节点需在节点列表中手动批准');
    html += field('最大节点数', '<input id="setMaxNodes" type="number" min="1" value="' + esc(e.maxNodes) + '">', 'enroll 拒绝超过该数量的节点');
    html += field('enroll 令牌有效期（小时）', '<input id="setTokenTtl" type="number" min="0" value="' + esc(e.tokenTtlHours) + '">', '0 表示不过期；默认 2 小时');
    html += field('文件代理', checkbox('setFilesEnabled', f.enabled === true), '允许通过 hub 传输文件（大文件默认不主动发送）');
    html += field('文件大小上限（MiB）', '<input id="setFilesMax" type="number" min="1" value="' + Math.round((Number(f.maxBytes) || 0) / 1048576) + '">', '超过该大小的上传会被拒绝');
    form.innerHTML = html;
  }

  function renderAudit(entries) {
    var rows = [];
    for (var i = 0; i < entries.length; i += 1) {
      var e = entries[i];
      var detail = {};
      for (var key in e) {
        if (!Object.prototype.hasOwnProperty.call(e, key)) continue;
        if (key === 'ts' || key === 'event') continue;
        detail[key] = e[key];
      }
      rows.push([fmtTime(e.ts), esc(e.event || '—'), '<span class="muted">' + esc(JSON.stringify(detail).slice(0, 220)) + '</span>']);
    }
    $('auditTable').innerHTML = table(['时间', '事件', '详情'], rows, '暂无审计记录。');
  }

  function mintToken() {
    var role = $('tkRole').value;
    var label = $('tkLabel').value.trim() || ('ui-' + role);
    var ttl = Number($('tkTtl').value);
    var maxUses = Number($('tkMax').value);
    var body = {
      role: role,
      label: label,
      ttlHours: isNaN(ttl) ? 2 : ttl,
      maxUses: isNaN(maxUses) ? 1 : maxUses
    };
    request('/api/v1/hub/tokens', { method: 'POST', body: body }).then(function (result) {
      state.mintedToken = result.token;
      $('mintedToken').textContent = result.token;
      $('mintedHint').textContent = '角色 ' + result.entry.role +
        (result.entry.expiresAt ? '，' + fmtTime(result.entry.expiresAt) + ' 过期' : '，不过期') +
        (result.entry.maxUses ? '，最多使用 ' + result.entry.maxUses + ' 次' : '');
      show('minted', true);
      toast('令牌已生成');
      return load(true);
    }).catch(function (err) { toast(err.message || String(err), true); });
  }
  function copyMinted() {
    var text = state.mintedToken || '';
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制'); }, function () { fallbackCopy(text); });
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); toast('已复制'); } catch (err) { toast('复制失败，请手动选择令牌', true); }
    document.body.removeChild(area);
  }
  var QR_FRAME_MS = 900;
  var QR_MARGIN_MODULES = 4;
  function drawQrFrame() {
    var qr = state.qr;
    if (!qr || !qr.frames || !qr.frames.length) return;
    var frame = qr.frames[state.qrIndex % qr.frames.length];
    var size = Number(frame.size) || frame.rows.length;
    var scale = Math.max(1, Math.floor(440 / (size + QR_MARGIN_MODULES * 2)));
    var dim = (size + QR_MARGIN_MODULES * 2) * scale;
    var canvas = $('qrCanvas');
    if (canvas.width !== dim) { canvas.width = dim; canvas.height = dim; }
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = '#000';
    var offset = QR_MARGIN_MODULES * scale;
    for (var y = 0; y < size; y += 1) {
      var row = frame.rows[y] || '';
      for (var x = 0; x < size; x += 1) {
        if (row.charAt(x) === '1') ctx.fillRect(offset + x * scale, offset + y * scale, scale, scale);
      }
    }
    $('qrFrame').textContent = frame.index + '/' + qr.total;
    $('qrMeta').textContent = '共 ' + qr.total + ' 帧 · 每 ' + (QR_FRAME_MS / 1000).toFixed(1) + ' 秒循环一次';
  }
  function stopQr() {
    if (state.qrTimer) { clearInterval(state.qrTimer); state.qrTimer = null; }
    state.qr = null;
    show('qrModal', false);
  }
  function showQr(code, title) {
    if (!code) { toast('先生成连接串或引导码', true); return; }
    request('/api/v1/hub/phone/qr', { method: 'POST', body: { code: code } }).then(function (result) {
      state.qr = result;
      state.qrIndex = 0;
      $('qrTitle').textContent = title || '扫描二维码';
      $('qrHint').textContent = '共 ' + result.total + ' 帧（每帧约 ' + result.chunkSize + ' 字符）。帧会自动循环，手机 App 0.6.2+ 的扫码页会自动累积已扫到的帧。';
      show('qrModal', true);
      drawQrFrame();
      if (state.qrTimer) clearInterval(state.qrTimer);
      state.qrTimer = setInterval(function () {
        if (!state.qr) return;
        state.qrIndex = (state.qrIndex + 1) % state.qr.frames.length;
        drawQrFrame();
      }, QR_FRAME_MS);
    }).catch(function (err) { toast(err.message || String(err), true); });
  }
  function showPhoneQr() { showQr(state.phoneCode, '扫描连接串二维码'); }
  function showPhoneQrV2() { showQr(state.phoneCodeV2, '扫描证书引导码二维码'); }
  function generatePhone() {
    stopQr();
    var label = $('phLabel').value.trim() || 'phone';
    var ttl = Number($('phTtl').value);
    var url = ($('phUrl').value || '').trim();
    request('/api/v1/hub/phone-invite', { method: 'POST', body: { label: label, ttlHours: isNaN(ttl) ? 2 : ttl, url: url || null } }).then(function (result) {
      state.phoneCode = result.code;
      $('phoneCode').value = result.code;
      var summary = result.summary;
      $('phoneMeta').textContent = '入口 ' + summary.entry.url + ' · ' +
        (summary.hasTunnel ? '内嵌 STCP（本地端口 ' + summary.tunnelBindPort + '）' : '无隧道，需手机直连') +
        ' · 令牌 ' + summary.tokenId + (result.expiresAt ? '，' + fmtTime(result.expiresAt) + ' 过期' : '，不过期');
      show('phoneOut', true);
      toast('连接串已生成，只显示这一次');
      return load(true);
    }).catch(function (err) { toast(err.message || String(err), true); });
  }
  function copyPhone() {
    var text = state.phoneCode || '';
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制连接串'); }, function () { fallbackCopy(text); });
    } else fallbackCopy(text);
  }
  function downloadPhone() {
    var code = state.phoneCode || '';
    if (!code) return;
    var blob = new Blob([code + '\n'], { type: 'text/plain' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'dshlink-phone-connect.txt';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
    toast('已下载连接文件');
  }
  function generatePhoneV2() {
    stopQr();
    var label = $('pvLabel').value.trim() || 'phone';
    var ttl = Number($('pvTtl').value);
    var maxUses = Number($('pvMax').value);
    var url = ($('pvUrl').value || '').trim();
    var tunnel = $('pvTunnel').checked;
    request('/api/v1/hub/phone/bootstrap', {
      method: 'POST',
      body: {
        label: label,
        ttlHours: isNaN(ttl) || ttl <= 0 ? 2 : ttl,
        maxUses: isNaN(maxUses) || maxUses <= 0 ? 1 : maxUses,
        tunnel: tunnel,
        url: url || null
      }
    }).then(function (result) {
      state.phoneCodeV2 = result.code;
      $('pvCode').value = result.code;
      var summary = result.summary || {};
      $('pvMeta').textContent = '入口 ' + (summary.entry && summary.entry.url ? summary.entry.url : '—') +
        ' · CA ' + shortFingerprint(summary.caFingerprint) +
        ' · ' + (summary.hasTunnel ? '内嵌 phone-frps 隧道（本地端口 ' + summary.tunnelBindPort + '）' : '无隧道，手机需能直连该 https 地址') +
        ' · ' + (result.expiresAt ? fmtTime(result.expiresAt) + ' 过期' : '不过期') +
        ' · 引导码 ' + (result.bootstrapId || '');
      show('pvOut', true);
      toast('证书引导码已生成，只显示这一次');
      return load(true);
    }).catch(function (err) { toast(err.message || String(err), true); });
  }
  function copyPhoneV2() {
    var text = state.phoneCodeV2 || '';
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制引导码'); }, function () { fallbackCopy(text); });
    } else fallbackCopy(text);
  }
  function downloadPhoneV2() {
    var code = state.phoneCodeV2 || '';
    if (!code) return;
    var blob = new Blob([code + '\n'], { type: 'text/plain' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'dshlink-phone-bootstrap.txt';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
    toast('已下载引导文件');
  }
  function revokePhoneDevice(id, name) {
    if (!id) return;
    if (!confirm('吊销手机 ' + (name || id) + ' 的证书？它下一次握手就会被拒绝，需要重新生成引导码。')) return;
    request('/api/v1/hub/phones/' + encodeURIComponent(id) + '/revoke', { method: 'POST' }).then(function () {
      toast('已吊销手机证书');
      return load(true);
    }).catch(function (err) { toast(err.message || String(err), true); });
  }
  function revokeBootstrap(id) {
    if (!id) return;
    if (!confirm('作废该引导码？尚未使用的手机将无法再凭它换取证书。')) return;
    request('/api/v1/hub/phone/bootstrap/' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
      toast('引导码已作废');
      return load(true);
    }).catch(function (err) { toast(err.message || String(err), true); });
  }
  function flushQueue() {
    request('/api/v1/hub/flush', { method: 'POST' }).then(function (result) {
      toast('已重投 ' + result.attempted + ' 条：成功 ' + result.delivered + '，失败 ' + result.failed + '，跳过 ' + result.skipped);
      return load(true);
    }).catch(function (err) { toast(err.message || String(err), true); });
  }
  function saveSettings() {
    var payload = {
      defaultNode: $('setDefaultNode').value || null,
      messageTtlSeconds: Number($('setMessageTtl').value),
      retrySeconds: Number($('setRetry').value),
      maxPendingPerTarget: Number($('setMaxPending').value),
      enrollment: {
        autoApprove: $('setAutoApprove').checked,
        maxNodes: Number($('setMaxNodes').value),
        tokenTtlHours: Number($('setTokenTtl').value)
      },
      files: {
        enabled: $('setFilesEnabled').checked,
        maxBytes: Math.max(1, Math.round(Number($('setFilesMax').value) * 1048576))
      }
    };
    request('/api/v1/hub/settings', { method: 'PATCH', body: payload }).then(function (result) {
      state.settings = result.settings || null;
      state.settingsDirty = false;
      renderSettings(state.settings);
      toast('设置已保存（' + ((result.applied || []).length) + ' 项）');
      return load(true);
    }).catch(function (err) { toast(err.message || String(err), true); });
  }
  function loadAudit() {
    request('/api/v1/audit?limit=50').then(function (result) {
      renderAudit(result.entries || []);
    }).catch(function (err) { toast(err.message || String(err), true); });
  }
  function approveNode(name) {
    if (!name) return;
    request('/api/v1/hub/nodes/' + encodeURIComponent(name) + '/approve', { method: 'POST' }).then(function (result) {
      if (result.uplinkToken) {
        state.mintedToken = result.uplinkToken;
        $('mintedToken').textContent = result.uplinkToken;
        $('mintedHint').textContent = '节点 ' + name + ' 的上行令牌，只显示一次；节点侧 token 需要保存到配置。';
        show('minted', true);
      }
      toast('已批准节点 ' + name);
      return load(true);
    }).catch(function (err) { toast(err.message || String(err), true); });
  }
  function revokeNode(name) {
    if (!name) return;
    request('/api/v1/hub/nodes/' + encodeURIComponent(name), { method: 'DELETE' }).then(function () {
      toast('已移除节点 ' + name);
      return load(true);
    }).catch(function (err) { toast(err.message || String(err), true); });
  }
  function revokeToken(id) {
    if (!id) return;
    request('/api/v1/hub/tokens/' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
      toast('已吊销令牌');
      state.tokens = state.tokens.filter(function (t) { return t.id !== id; });
      renderTokens(state.tokens);
    }).catch(function (err) { toast(err.message || String(err), true); });
  }
  function retryMessage(id) {
    if (!id) return;
    request('/api/v1/hub/outbox/' + encodeURIComponent(id) + '/retry', { method: 'POST' }).then(function (result) {
      var stateName = result.delivery && result.delivery.state ? result.delivery.state : 'pending';
      toast('重投结果：' + stateName);
      return load(true);
    }).catch(function (err) { toast(err.message || String(err), true); });
  }
  function dropMessage(id) {
    if (!id) return;
    request('/api/v1/hub/outbox/' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
      toast('已丢弃该消息');
      return load(true);
    }).catch(function (err) { toast(err.message || String(err), true); });
  }
  function onActionClick(ev) {
    var node = ev.target;
    while (node && node !== document) {
      if (node.getAttribute && node.getAttribute('data-action')) break;
      node = node.parentNode;
    }
    if (!node || !node.getAttribute) return;
    var action = node.getAttribute('data-action');
    var name = node.getAttribute('data-name') || '';
    var id = node.getAttribute('data-id') || '';
    if (action === 'approve') approveNode(name);
    else if (action === 'revoke-node') { if (confirm('移除节点 ' + name + '？对方需要重新 enroll 才能接入。')) revokeNode(name); }
    else if (action === 'revoke-token') { if (confirm('吊销该令牌？使用它的客户端将立即失去权限。')) revokeToken(id); }
    else if (action === 'retry-msg') retryMessage(id);
    else if (action === 'drop-msg') { if (confirm('丢弃这条消息？hub 缓存区中的记录会被标记为已丢弃。')) dropMessage(id); }
    else if (action === 'revoke-phone') revokePhoneDevice(id, name);
    else if (action === 'revoke-bootstrap') revokeBootstrap(id);
  }

  function init() {
    // When the console is opened on a LAN/public address, that address is what the phone should dial.
    var hostName = location.hostname;
    if (hostName && hostName !== '127.0.0.1' && hostName !== 'localhost' && hostName !== '::1' && hostName !== '[::1]') {
      $('phUrl').value = location.origin;
    }
    $('loginBtn').addEventListener('click', login);
    $('tokenInput').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') login(); });
    $('refreshBtn').addEventListener('click', function () { load(false); });
    $('logoutBtn').addEventListener('click', logout);
    $('mintBtn').addEventListener('click', mintToken);
    $('copyBtn').addEventListener('click', copyMinted);
    $('phoneBtn').addEventListener('click', generatePhone);
    $('phoneCopy').addEventListener('click', copyPhone);
    $('phoneDownload').addEventListener('click', downloadPhone);
    $('pvBtn').addEventListener('click', generatePhoneV2);
    $('pvCopy').addEventListener('click', copyPhoneV2);
    $('pvDownload').addEventListener('click', downloadPhoneV2);
    $('phoneQr').addEventListener('click', showPhoneQr);
    $('pvQr').addEventListener('click', showPhoneQrV2);
    $('qrClose').addEventListener('click', stopQr);
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && state.qr) stopQr(); });
    $('flushBtn').addEventListener('click', flushQueue);
    $('saveSettingsBtn').addEventListener('click', saveSettings);
    $('auditBtn').addEventListener('click', loadAudit);
    $('pendingOnly').addEventListener('change', function () { load(true); });
    $('settingsForm').addEventListener('input', function () { state.settingsDirty = true; });
    $('settingsForm').addEventListener('change', function () { state.settingsDirty = true; });
    document.addEventListener('click', onActionClick);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && state.signedIn) load(true); });
    var saved = localStorage.getItem(TOKEN_KEY);
    if (saved) {
      state.token = saved;
      $('tokenInput').value = saved;
      login();
    } else {
      show('login', true);
      show('app', false);
    }
  }

  init();
})();
</script>
</body>
</html>
`;

export function hubUiHtml({ version = '' } = {}) {
  return HUB_UI_HTML.replace('__VERSION__', String(version ?? ''));
}
