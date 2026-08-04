const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
let turnstileWid = null;
let turnstileReady = false;

function ensureTurnstile(cb) {
  if (window.turnstile) { turnstileReady = true; cb(); return; }
  let tries = 0, max = 100;
  const t = setInterval(() => {
    tries++;
    if (window.turnstile || tries >= max) {
      clearInterval(t);
      if (window.turnstile) { turnstileReady = true; cb(); }
    }
  }, 100);
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(path, opts);
  if (resp.status === 401) {
    if (S.page === 'main') showLogin();
    throw new Error('Unauthorized');
  }
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    throw new Error(e.detail || `Error ${resp.status}`);
  }
  return resp.json();
}

const S = {
  page: 'loading', providers: [], activePid: null,
  convs: [], activeCid: null, messages: [], settings: {}, streaming: false,
  files: [], webSearch: false, isAdmin: false, currentUsername: ''
};

function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

function md(text) {
  let h = esc(text);
  h = h.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${esc(code.trim())}</code></pre>`);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
  h = h.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  h = h.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^# (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^- (.+)$/gm, '<li>$1</li>');
  h = h.replace(/((?:<li>.*<\/li>\s*)+)/g, '<ul>$1</ul>');
  h = h.replace(/\n/g, '<br>');
  return h;
}

async function checkStatus() {
  try {
    const s = await api('GET', '/api/status');
    if (!s.initialized) { showInit(s); return; }
    S.settings.turnstileSiteKey = s.turnstile_site_key || '';
    S.isAdmin = s.is_admin || false;
    S.currentUsername = s.username || '';
    S.providers = await api('GET', '/api/providers');
    if (S.providers.length && !S.activePid) S.activePid = S.providers[0].id;
    if (S.activePid) await loadConvs();
    showMain();
    renderAll();
  } catch {
    showLogin();
  }
}

function showInit(status) {
  S.page = 'init';
  document.querySelectorAll('.overlay').forEach(e => e.classList.add('hidden'));
  $('#app').style.display = 'none';
  S.settings.turnstileSiteKey = status?.turnstile_site_key || '';
  $('#init-overlay').classList.remove('hidden');
}

function showLogin() {
  S.page = 'login';
  document.querySelectorAll('.overlay').forEach(e => e.classList.add('hidden'));
  $('#app').style.display = 'none';
  S.activePid = null; S.activeCid = null;
  $('#login-overlay').classList.remove('hidden');
  const box = $('#turnstile-box');
  if (S.settings.turnstileSiteKey) {
    box.classList.remove('hidden');
    ensureTurnstile(() => {
      try { turnstile.remove(turnstileWid); } catch {}
      try { turnstileWid = turnstile.render('#turnstile-box', { sitekey: S.settings.turnstileSiteKey, theme: 'auto' }); } catch {}
    });
  } else { box.classList.add('hidden'); }
  setTimeout(() => $('#login-password').focus(), 100);
}

async function showMain() {
  S.page = 'main';
  document.querySelectorAll('.overlay').forEach(e => e.classList.add('hidden'));
  $('#app').style.display = 'flex';
  $('#btn-open-settings').classList.toggle('hidden', !S.isAdmin);
  $('#btn-open-users').classList.toggle('hidden', !S.isAdmin);
}

async function loadProviders() {
  try { S.providers = await api('GET', '/api/providers'); } catch { S.providers = []; }
}
async function loadConvs() {
  if (!S.activePid) { S.convs = []; S.activeCid = null; S.messages = []; return; }
  try { S.convs = await api('GET', `/api/conversations?provider_id=${S.activePid}`); } catch { S.convs = []; }
  S.activeCid = S.convs.length ? S.convs[0].id : null;
  if (S.activeCid) await loadMessages();
  else S.messages = [];
}
async function loadMessages() {
  if (!S.activeCid) { S.messages = []; return; }
  try { S.messages = await api('GET', `/api/conversations/${S.activeCid}/messages`); } catch { S.messages = []; }
}

function renderModelSelect() {
  const sel = $('#chat-model-select');
  sel.innerHTML = S.providers.map(p => `<option value="${p.id}" ${p.id===S.activePid?'selected':''}>${esc(p.name)} · ${esc(p.model)}</option>`).join('');
  if (!S.providers.length) sel.innerHTML = '<option value="">无提供商</option>';
  sel.addEventListener('change', async e => {
    S.activePid = e.target.value || null;
    await loadConvs();
    renderAll();
  }, { once: true });
}

function renderConvList() {
  const list = $('#conv-list');
  list.innerHTML = S.convs.length
    ? S.convs.map(c => `<div class="conv-item${c.id===S.activeCid?' active':''}" data-cid="${c.id}">
        <span class="conv-name">${esc(c.title)}</span>
        ${c.system_prompt ? '<span class="sys-prompt-dot" title="已设置系统提示词"></span>' : ''}
        <button class="conv-del" data-cid="${c.id}">&times;</button>
      </div>`).join('')
    : '<div style="color:var(--text3);font-size:12px;padding:12px;text-align:center">暂无对话</div>';

  list.querySelectorAll('.conv-item').forEach(el => {
    el.addEventListener('click', async e => {
      if (e.target.classList.contains('conv-del')) {
        e.stopPropagation();
        await deleteConv(el.dataset.cid);
      } else {
        S.activeCid = el.dataset.cid;
        await loadMessages();
        renderAll();
      }
    });
  });
}

function renderMessages() {
  const c = $('#messages');
  const conv = S.convs.find(x => x.id === S.activeCid);
  $('#chat-title').textContent = conv?.title || '水鱼 Chat';
  const settingsBtn = $('#btn-conv-settings');
  if (S.activeCid && conv) {
    settingsBtn.classList.remove('hidden');
    if (conv.system_prompt) settingsBtn.style.color = 'var(--brand)';
    else settingsBtn.style.color = '';
  } else {
    settingsBtn.classList.add('hidden');
  }
  if (!S.activeCid || !S.messages.length) {
    c.innerHTML = `<div class="empty-hint"><img class="fish" src="icon.ico" width="48" height="48" alt="">水鱼 Chat · 选择一个对话开始</div>`;
    return;
  }

  let html = S.messages.filter(m => m.role !== 'system').map(m => {
    const cls = m.role === 'user' ? 'user' : (m.error ? 'error' : 'assistant');
    return `<div class="message ${cls}"><div class="bubble">${md(m.content)}</div></div>`;
  }).join('');

  if (S.streaming) {
    html += '<div class="message assistant"><div class="bubble"><div class="typing-indicator"><span></span><span></span><span></span></div></div></div>';
  }
  c.innerHTML = html;
  c.scrollTop = c.scrollHeight;
}

function renderAll() {
  renderModelSelect();
  renderConvList();
  renderMessages();
}

async function newConv() {
  if (!S.activePid) return;
  try {
    const r = await api('POST', '/api/conversations', { provider_id: S.activePid, title: '新对话' });
    S.convs.unshift(r);
    S.activeCid = r.id;
    S.messages = [];
    renderAll();
  } catch (e) { alert(e.message); }
}

async function deleteConv(cid) {
  if (!confirm('删除此对话？')) return;
  try {
    await api('DELETE', `/api/conversations/${cid}`);
    S.convs = S.convs.filter(c => c.id !== cid);
    if (S.activeCid === cid) {
      S.activeCid = S.convs.length ? S.convs[0].id : null;
      S.activeCid ? await loadMessages() : (S.messages = []);
    }
    renderAll();
  } catch (e) { alert(e.message); }
}

async function sendMsg() {
  const input = $('#user-input');
  const text = input.value.trim();
  const hasFiles = S.files.length > 0;
  if ((!text && !hasFiles) || S.streaming) return;
  if (!S.activePid) { alert('请先添加 API 提供商'); return; }
  if (!S.activeCid) await newConv();
  if (!S.activeCid) return;

  input.value = ''; input.style.height = 'auto';
  const msg = { role: 'user', content: text };
  let pendingFiles = [];
  if (hasFiles) {
    msg.files = S.files.map(f => ({ name: f.name, size: f.size, type: f.type }));
    pendingFiles = S.files.slice();
    clearFiles();
  }
  S.messages.push(msg);
  S.streaming = true;
  renderAll();

  try {
    const body = { content: text };
    if (S.webSearch) body.web_search = true;
    if (msg.files?.length) body.files = msg.files.map(f => f.name);
    if (pendingFiles.length) {
      const fd = new FormData();
      pendingFiles.forEach(f => fd.append('files', f.blob, f.name));
      const uploadR = await fetch('/api/upload', { method: 'POST', body: fd, credentials: 'same-origin' });
      if (uploadR.ok) {
        const uj = await uploadR.json();
        body.file_ids = uj.file_ids || [];
      }
    }
    const r = await api('POST', `/api/conversations/${S.activeCid}/chat`, body);
    S.streaming = false;
    S.messages = r.messages || S.messages;
    renderAll();
    await loadConvs();
    renderConvList();
  } catch (e) {
    S.streaming = false;
    S.messages.push({ role: 'assistant', content: `请求失败: ${e.message}`, error: true });
    renderAll();
  }
}

function switchSettingsTab(tab) {
  $$('.settings-nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  $$('.settings-panel').forEach(el => el.classList.toggle('hidden', el.id !== `panel-${tab}`));
}

function renderProviderForm(pid) {
  const area = $('#provider-form-area');
  if (!pid) {
    area.innerHTML = `<div class="provider-form">
      <label>名称 <span style="color:var(--danger-text)">*</span></label>
      <input type="text" id="pf-name" placeholder="如：DeepSeek">
      <label>API 地址 <span style="color:var(--danger-text)">*</span></label>
      <input type="text" id="pf-url" placeholder="https://api.deepseek.com/v1">
      <label>API Key <span style="color:var(--danger-text)">*</span></label>
      <input type="password" id="pf-key" placeholder="sk-...">
      <label>模型 <span style="color:var(--danger-text)">*</span></label>
      <div class="pf-field" style="display:flex;gap:8px;align-items:center">
        <input type="text" id="pf-model" placeholder="deepseek-chat" style="flex:1">
        <button type="button" class="btn-secondary" id="btn-pf-fetch">获取</button>
      </div>
      <div class="provider-form-actions">
        <button class="btn-secondary" id="btn-pf-cancel">取消</button>
        <button class="btn-primary" id="btn-pf-save">保存</button>
      </div>
    </div>`;
    $('#btn-pf-save').addEventListener('click', () => saveProviderForm(null));
    $('#btn-pf-cancel').addEventListener('click', () => { area.innerHTML = ''; });
    $('#btn-pf-fetch').addEventListener('click', () => fetchModelsFromUrl());
  } else {
    const p = S.providers.find(x => x.id === pid);
    if (!p) return;
    area.innerHTML = `<div class="provider-form">
      <label>名称 <span style="color:var(--danger-text)">*</span></label>
      <input type="text" id="pf-name" value="${esc(p.name)}">
      <label>API 地址 <span style="color:var(--danger-text)">*</span></label>
      <input type="text" id="pf-url" value="${esc(p.base_url)}">
      <label>API Key</label>
      <input type="password" id="pf-key" placeholder="留空则不修改">
      <label>模型 <span style="color:var(--danger-text)">*</span></label>
      <div class="pf-field" style="display:flex;gap:8px;align-items:center">
        <input type="text" id="pf-model" value="${esc(p.model)}" style="flex:1">
        <button type="button" class="btn-secondary" id="btn-pf-fetch">获取</button>
      </div>
      <div class="provider-form-actions">
        <button class="btn-danger" id="btn-pf-delete">删除</button>
        <button class="btn-secondary" id="btn-pf-cancel">取消</button>
        <button class="btn-primary" id="btn-pf-save">保存</button>
      </div>
    </div>`;
    $('#btn-pf-save').addEventListener('click', () => saveProviderForm(pid));
    $('#btn-pf-cancel').addEventListener('click', () => { area.innerHTML = ''; renderProviderList(); });
    $('#btn-pf-delete').addEventListener('click', () => deleteProviderInline(pid));
    $('#btn-pf-fetch').addEventListener('click', () => fetchProviderModels(pid));
  }
}

async function saveProviderForm(pid) {
  const body = {
    name: $('#pf-name').value.trim(),
    base_url: $('#pf-url').value.trim(),
    model: $('#pf-model').value.trim()
  };
  const key = $('#pf-key').value.trim();
  if (key) body.api_key = key;
  if (!body.name || !body.base_url || !body.model || (!pid && !key)) {
    alert('名称、API 地址、模型、API Key 均为必填'); return;
  }
  try {
    if (pid) { await api('PUT', `/api/providers/${pid}`, body); }
    else {
      const r = await api('POST', '/api/providers', body);
      S.activePid = r.id;
    }
    $('#provider-form-area').innerHTML = '';
    await loadProviders();
    if (!S.activePid && S.providers.length) S.activePid = S.providers[0].id;
    if (S.activePid) await loadConvs();
    renderProviderList();
    renderAll();
  } catch (e) { alert(e.message); }
}

async function deleteProviderInline(pid) {
  if (!confirm('删除此提供商？关联的对话也会被删除。')) return;
  try {
    await api('DELETE', `/api/providers/${pid}`);
    S.providers = S.providers.filter(p => p.id !== pid);
    if (S.activePid === pid) {
      S.activePid = S.providers[0]?.id || null;
      S.activeCid = null; S.messages = [];
      if (S.activePid) await loadConvs();
    }
    $('#provider-form-area').innerHTML = '';
    renderProviderList();
    renderAll();
  } catch (e) { alert(e.message); }
}

function toggleQueritOptions() {
  if (!$('#settings-search-engine')) return;
  const eng = $('#settings-search-engine').value;
  $('#querit-options').classList.toggle('hidden', eng !== 'querit');
  const keyRow = $('#search-key-row');
  if (keyRow) keyRow.classList.toggle('hidden', eng === 'bing');
}

async function fetchProviderModels(pid) {
  const btn = $('#btn-pf-fetch');
  if (btn) { btn.disabled = true; btn.textContent = '获取中...'; }
  try {
    const r = await api('POST', `/api/providers/${pid}/fetch-models`);
    const models = r.models || [];
    if (!models.length) { alert('未获取到模型列表'); return; }
    const modelInput = $('#pf-model');
    const modelWrap = modelInput.closest('.pf-field') || modelInput.parentElement;
    let picker = document.getElementById('pf-model-picker');
    if (!picker) {
      picker = document.createElement('div');
      picker.id = 'pf-model-picker';
      picker.className = 'model-picker';
      modelWrap.appendChild(picker);
    }
    picker.innerHTML = models.map(m => `<div class="model-picker-item" data-model="${esc(m.id)}">${esc(m.id)}</div>`).join('');
    picker.querySelectorAll('.model-picker-item').forEach(el => {
      el.addEventListener('click', () => {
        modelInput.value = el.dataset.model;
        picker.remove();
      });
    });
  } catch (e) {
    alert('获取模型失败: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '获取'; }
  }
}

async function fetchModelsFromUrl() {
  const btn = $('#btn-pf-fetch');
  const base = ($('#pf-url').value || '').trim();
  const key = ($('#pf-key').value || '').trim();
  if (!base) { alert('请先填写 API 地址'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '获取中...'; }
  try {
    const r = await api('POST', '/api/fetch-models', { base_url: base, api_key: key });
    const models = r.models || [];
    if (!models.length) { alert('未获取到模型列表'); return; }
    const modelInput = $('#pf-model');
    const modelWrap = modelInput.closest('.pf-field') || modelInput.parentElement;
    let picker = document.getElementById('pf-model-picker');
    if (!picker) {
      picker = document.createElement('div');
      picker.id = 'pf-model-picker';
      picker.className = 'model-picker';
      modelWrap.appendChild(picker);
    }
    picker.innerHTML = models.map(m => `<div class="model-picker-item" data-model="${esc(m.id)}">${esc(m.id)}</div>`).join('');
    picker.querySelectorAll('.model-picker-item').forEach(el => {
      el.addEventListener('click', () => {
        modelInput.value = el.dataset.model;
        picker.remove();
      });
    });
  } catch (e) {
    alert('获取模型失败: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '获取'; }
  }
}

function renderProviderList() {
  const list = $('#provider-list');
  list.innerHTML = S.providers.map(p => `
    <div class="provider-item">
      <div class="pinfo">
        <div class="pname">${esc(p.name)}</div>
        <div class="pdetail">${esc(p.model)} · ${esc(p.base_url)}</div>
      </div>
      <div class="pactions">
        <button class="paction-btn" data-edit="${p.id}">编辑</button>
        <button class="paction-btn del" data-del="${p.id}">删除</button>
      </div>
    </div>`).join('') || '<div style="color:var(--text3);font-size:13px;padding:12px 0;text-align:center">暂无提供商</div>';

  list.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => renderProviderForm(btn.dataset.edit));
  });
  list.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => deleteProviderInline(btn.dataset.del));
  });
}

async function openSettings() {
  try {
    const s = await api('GET', '/api/settings');
    $('#settings-sitekey').value = s.turnstile_site_key || '';
    $('#settings-secret').value = s.turnstile_secret || '';
    $('#settings-idle').value = s.idle_timeout;
    $('#settings-container-net').checked = s.use_container_network || false;
    $('#settings-search-engine').value = s.web_search_engine || 'bing';
    $('#settings-search-key').value = s.web_search_api_key || '';
    $('#settings-querit-max').value = s.querit_max_results || 10;
    $('#settings-querit-time').value = s.querit_time_range || 'none';
    $('#settings-user-models').value = s.user_models || '';
    toggleQueritOptions();
    switchSettingsTab('providers');
    renderProviderList();
    $('#settings-page').classList.remove('hidden');
  } catch { alert('无法加载设置'); }
}

async function saveSettings() {
  try {
    await api('POST', '/api/settings', {
      turnstile_site_key: $('#settings-sitekey').value.trim(),
      turnstile_secret: $('#settings-secret').value.trim(),
      idle_timeout: parseInt($('#settings-idle').value) || 15,
      use_container_network: $('#settings-container-net').checked,
      web_search_engine: $('#settings-search-engine').value,
      web_search_api_key: $('#settings-search-key').value.trim(),
      querit_max_results: parseInt($('#settings-querit-max').value) || 10,
      querit_time_range: $('#settings-querit-time').value,
      user_models: $('#settings-user-models').value.trim()
    });
    $('#settings-page').classList.add('hidden');
  } catch (e) { alert(e.message); }
}

async function doInit() {
  const name = ($('#init-username')?.value || '').trim() || 'admin';
  const pw = $('#init-password').value.trim();
  if (pw.length < 4) { alert('密码至少 4 位'); return; }
  try {
    await api('POST', '/api/init', {
      admin_name: name,
      password: pw,
      turnstile_site_key: $('#init-sitekey').value.trim(),
      turnstile_secret: $('#init-secret').value.trim()
    });
    $('#init-overlay').classList.add('hidden');
    const s = await api('GET', '/api/status');
    S.settings.turnstileSiteKey = s.turnstile_site_key || '';
    showLogin();
  } catch (e) { alert(e.message); }
}

async function doLogin() {
  const username = ($('#login-username')?.value || '').trim();
  const pw = $('#login-password').value.trim();
  if (!username) { alert('请输入用户名'); return; }
  if (!pw) { alert('请输入密码'); return; }
  const body = { username: username, password: pw };
  if (S.settings.turnstileSiteKey && turnstileWid !== null) {
    const token = turnstile.getResponse(turnstileWid);
    if (!token) { alert('请完成人机验证'); return; }
    body.turnstile_token = token;
  }
  try {
    const resp = await api('POST', '/api/login', body);
    S.isAdmin = resp.is_admin || false;
    S.currentUsername = resp.username || '';
    $('#login-overlay').classList.add('hidden');
    await loadProviders();
    if (S.providers.length && !S.activePid) S.activePid = S.providers[0].id;
    if (S.activePid) await loadConvs();
    showMain();
    renderAll();
  } catch (e) { alert(e.message); }
}

async function doLogout() {
  try { await api('POST', '/api/logout'); } catch {}
  S.page = 'login'; S.activePid = null; S.activeCid = null;
  $('#app').style.display = 'none';
  showLogin();
}

$('#btn-init-submit').addEventListener('click', doInit);
$('#btn-login-submit').addEventListener('click', doLogin);
$('#btn-send').addEventListener('click', sendMsg);
$('#btn-new-chat').addEventListener('click', newConv);
$('#btn-open-settings').addEventListener('click', openSettings);
$('#btn-settings-save').addEventListener('click', saveSettings);
$('#btn-settings-close').addEventListener('click', () => $('#settings-page').classList.add('hidden'));
$('#btn-logout').addEventListener('click', doLogout);
$('#btn-toggle-sidebar').addEventListener('click', () => {
  if (window.innerWidth <= 640) {
    $('#sidebar').classList.toggle('open');
  } else {
    document.getElementById('app').classList.toggle('sidebar-collapsed');
    localStorage.setItem('sb-collapsed', document.getElementById('app').classList.contains('sidebar-collapsed'));
  }
});
$('#btn-add-provider').addEventListener('click', () => renderProviderForm(null));

function addFiles(fs) {
  for (const f of fs) {
    if (S.files.length >= 10) break;
    S.files.push({ name: f.name, size: f.size, type: f.type, blob: f });
  }
  renderFiles();
}

function removeFile(idx) {
  S.files.splice(idx, 1);
  renderFiles();
}

function clearFiles() {
  S.files = [];
  renderFiles();
}

function renderFiles() {
  const c = $('#attached-files');
  if (!S.files.length) { c.classList.add('hidden'); c.innerHTML = ''; return; }
  c.classList.remove('hidden');
  c.innerHTML = S.files.map((f, i) => {
    const isImg = f.type.startsWith('image/');
    return `<div class="attached-file">
      ${isImg ? `<img src="${URL.createObjectURL(f.blob)}" alt="">` : ''}
      <span>${esc(f.name)}</span>
      <button class="file-remove" data-idx="${i}">&times;</button>
    </div>`;
  }).join('');
  c.querySelectorAll('.file-remove').forEach(btn => {
    btn.addEventListener('click', () => removeFile(parseInt(btn.dataset.idx)));
  });
}

$('#btn-attach').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', e => {
  if (e.target.files.length) addFiles(e.target.files);
  e.target.value = '';
});
$('#btn-web-search').addEventListener('click', () => {
  S.webSearch = !S.webSearch;
  $('#btn-web-search').classList.toggle('active', S.webSearch);
});

$$('.settings-nav-item').forEach(el => {
  el.addEventListener('click', () => switchSettingsTab(el.dataset.tab));
});

$('#user-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});
$('#user-input').addEventListener('input', function() {
  this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 160) + 'px';
});
$('#login-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

if (localStorage.getItem('sb-collapsed') === 'true') {
  document.getElementById('app').classList.add('sidebar-collapsed');
}

$('#btn-conv-settings').addEventListener('click', openConvSettings);
$('#btn-conv-settings-cancel').addEventListener('click', () => $('#conv-settings-overlay').classList.add('hidden'));
$('#btn-conv-settings-save').addEventListener('click', saveConvSettings);

$('#settings-search-engine').addEventListener('change', toggleQueritOptions);

function openConvSettings() {
  if (!S.activeCid) return;
  const conv = S.convs.find(c => c.id === S.activeCid);
  $('#conv-settings-title').value = conv?.title || '';
  $('#conv-settings-prompt').value = conv?.system_prompt || '';
  $('#conv-settings-overlay').classList.remove('hidden');
  $('#conv-settings-title').focus();
}

async function saveConvSettings() {
  const title = $('#conv-settings-title').value.trim();
  const prompt = $('#conv-settings-prompt').value.trim();
  if (!title) { alert('标题不能为空'); return; }
  try {
    await api('PUT', `/api/conversations/${S.activeCid}`, { title, system_prompt: prompt });
    const conv = S.convs.find(c => c.id === S.activeCid);
    if (conv) { conv.title = title; conv.system_prompt = prompt; }
    $('#conv-settings-overlay').classList.add('hidden');
    renderAll();
  } catch(e) { alert(e.message); }
}

async function loadUsers() {
  try {
    const r = await api('GET', '/api/users');
    renderUsers(r.users || []);
  } catch (e) {
    $('#user-list').innerHTML = `<div style="color:var(--danger-text);padding:8px;font-size:13px">加载失败: ${esc(e.message)}</div>`;
  }
}

function renderUsers(users) {
  const list = $('#user-list');
  list.innerHTML = users.map(u => `
    <div class="provider-item">
      <div class="pinfo">
        <div class="pname">${esc(u.username)} ${u.is_admin ? '<span style="color:var(--brand);font-size:11px">管理员</span>' : '<span style="color:var(--text3);font-size:11px">普通用户</span>'}</div>
        <div class="pdetail">创建于 ${new Date(u.created_at*1000).toLocaleString('zh-CN')}</div>
      </div>
      <div class="pactions">
        <button class="paction-btn del" data-del="${u.id}" ${u.is_admin?'disabled':''}>删除</button>
      </div>
    </div>`).join('') || '<div style="color:var(--text3);font-size:13px;padding:12px 0;text-align:center">暂无用户</div>';

  list.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => deleteUser(btn.dataset.del));
  });
}

function toggleAddUser() {
  const form = $('#user-add-form');
  const show = form.style.display === 'none';
  form.style.display = show ? 'flex' : 'none';
  $('#btn-add-user').style.display = show ? 'none' : '';
  if (show) $('#new-username').focus();
}

async function addUser() {
  const name = $('#new-username').value.trim();
  const pw = $('#new-user-password').value.trim();
  if (!name || !pw) { alert('用户名和密码不能为空'); return; }
  if (pw.length < 4) { alert('密码至少 4 位'); return; }
  try {
    await api('POST', '/api/users', { username: name, password: pw });
    $('#new-username').value = '';
    $('#new-user-password').value = '';
    toggleAddUser();
    loadUsers();
  } catch (e) { alert(e.message); }
}

async function deleteUser(uid) {
  if (!confirm('确定删除此用户？此操作不可撤销。')) return;
  try {
    await api('DELETE', `/api/users/${uid}`);
    loadUsers();
  } catch (e) { alert(e.message); }
}

function openUsers() {
  loadUsers();
  $('#user-add-form').style.display = 'none';
  $('#btn-add-user').style.display = '';
  $('#users-page').classList.remove('hidden');
}

$('#btn-open-users')?.addEventListener('click', openUsers);
$('#btn-add-user')?.addEventListener('click', toggleAddUser);
$('#btn-add-user-confirm')?.addEventListener('click', addUser);
$('#btn-users-close')?.addEventListener('click', () => $('#users-page').classList.add('hidden'));

checkStatus();
