const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
let turnstileWid = null;
let turnstileReady = false;

function toggleSelectAllModels(e, pickerId) {
  e.preventDefault();
  const picker = document.getElementById(pickerId);
  const items = picker.querySelectorAll('.model-picker-item');
  const allSel = Array.from(items).every(i => i.classList.contains('sel'));
  items.forEach(i => { if (allSel !== i.classList.contains('sel')) i.click(); });
  e.target.textContent = allSel ? '全选' : '取消全选';
}

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

const API_TIMEOUT = 8000;

async function api(method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT);
  try {
    const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', signal: controller.signal };
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
  } finally {
    clearTimeout(timer);
  }
}

const S = {
  page: 'loading', providers: [], activePid: null, activeModel: '',
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
    if (S.providers.length && !S.activePid) {
      S.activePid = S.providers[0].id;
      S.activeModel = S.providers[0].models?.[0] || S.providers[0].model || '';
    }
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
  S.activePid = null; S.activeModel = ''; S.activeCid = null;
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
  let options = [];
  S.providers.forEach(p => {
    (p.models || [p.model].filter(Boolean)).forEach(m => {
      const val = `${p.id}|${m}`;
      const selAttr = (p.id === S.activePid && m === S.activeModel) ? ' selected' : '';
      options.push(`<option value="${val}"${selAttr}>${esc(p.name)} · ${esc(m)}</option>`);
    });
  });
  sel.innerHTML = options.length ? options.join('') : '<option value="">无提供商</option>';
  sel.addEventListener('change', async e => {
    const parts = (e.target.value || '').split('|');
    const newPid = parts[0] || null;
    const newModel = parts[1] || '';
    if (newPid !== S.activePid) {
      S.activePid = newPid;
      S.activeModel = newModel;
      await loadConvs();
      renderAll();
    } else {
      S.activeModel = newModel;
    }
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
    if (S.activeModel) body.model = S.activeModel;
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
      <input type="text" id="pf-url" placeholder="https://api.deepseek.com">
      <label>API Key <span style="color:var(--danger-text)">*</span></label>
      <input type="password" id="pf-key" placeholder="sk-...">
      <label>模型列表 <span style="color:var(--danger-text)">*</span></label>
      <div class="pf-field" style="display:flex;gap:8px;align-items:center">
        <input type="text" id="pf-models" placeholder="deepseek-chat, deepseek-reasoner（逗号分隔）" style="flex:1">
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
    const allModels = (p.models && p.models.length) ? p.models.join(', ') : (p.model || '');
    area.innerHTML = `<div class="provider-form">
      <label>名称 <span style="color:var(--danger-text)">*</span></label>
      <input type="text" id="pf-name" value="${esc(p.name)}">
      <label>API 地址 <span style="color:var(--danger-text)">*</span></label>
      <input type="text" id="pf-url" value="${esc(p.base_url)}">
      <label>API Key</label>
      <input type="password" id="pf-key" placeholder="留空则不修改">
      <label>模型列表 <span style="color:var(--danger-text)">*</span></label>
      <div class="pf-field" style="display:flex;gap:8px;align-items:center">
        <input type="text" id="pf-models" value="${esc(allModels)}" placeholder="model1, model2（逗号分隔）" style="flex:1">
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
  const modelsRaw = $('#pf-models').value.trim();
  const modelList = modelsRaw ? modelsRaw.split(',').map(m => m.trim()).filter(Boolean) : [];
  const body = {
    name: $('#pf-name').value.trim(),
    base_url: $('#pf-url').value.trim(),
    models: modelList.join(','),
    model: modelList[0] || ''
  };
  const key = $('#pf-key').value.trim();
  if (key) body.api_key = key;
  if (!body.name || !body.base_url || !body.models || (!pid && !key)) {
    alert('名称、API 地址、模型列表、API Key 均为必填'); return;
  }
  try {
    if (pid) { await api('PUT', `/api/providers/${pid}`, body); }
    else {
      const r = await api('POST', '/api/providers', body);
      S.activePid = r.id;
      S.activeModel = modelList[0] || '';
    }
    $('#provider-form-area').innerHTML = '';
    await loadProviders();
    if (!S.activePid && S.providers.length) { S.activePid = S.providers[0].id; S.activeModel = S.providers[0].models?.[0] || ''; }
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
      S.activeModel = S.providers[0]?.models?.[0] || '';
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
    const modelInput = $('#pf-models');
    const modelWrap = modelInput.closest('.pf-field') || modelInput.parentElement;
    let picker = document.getElementById('pf-model-picker');
    if (!picker) {
      picker = document.createElement('div');
      picker.id = 'pf-model-picker';
      picker.className = 'model-picker';
      modelWrap.appendChild(picker);
    }
    const current = modelInput.value.split(',').map(s => s.trim()).filter(Boolean);
    picker.innerHTML = `<div style="padding:4px 8px;font-size:12px;color:var(--text2);border-bottom:1px solid var(--border-color);margin-bottom:4px">点击添加 / 点击已选移除 | <a href="#" onclick="toggleSelectAllModels(event,'pf-model-picker')" style="color:var(--primary)">全选</a></div>`
      + models.map(m => {
        const sel = current.includes(m.id) ? ' sel' : '';
        return `<div class="model-picker-item${sel}" data-model="${esc(m.id)}">${current.includes(m.id) ? '✓ ' : ''}${esc(m.id)}</div>`;
      }).join('');
    picker.querySelectorAll('.model-picker-item').forEach(el => {
      el.addEventListener('click', () => {
        const parts = modelInput.value.split(',').map(s => s.trim()).filter(Boolean);
        const idx = parts.indexOf(el.dataset.model);
        if (idx >= 0) { parts.splice(idx, 1); }
        else { parts.push(el.dataset.model); }
        modelInput.value = parts.join(', ');
        el.classList.toggle('sel');
        el.textContent = (el.classList.contains('sel') ? '✓ ' : '') + el.dataset.model;
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
    const modelInput = $('#pf-models');
    const modelWrap = modelInput.closest('.pf-field') || modelInput.parentElement;
    let picker = document.getElementById('pf-model-picker');
    if (!picker) {
      picker = document.createElement('div');
      picker.id = 'pf-model-picker';
      picker.className = 'model-picker';
      modelWrap.appendChild(picker);
    }
    const current = modelInput.value.split(',').map(s => s.trim()).filter(Boolean);
    picker.innerHTML = `<div style="padding:4px 8px;font-size:12px;color:var(--text2);border-bottom:1px solid var(--border-color);margin-bottom:4px">点击添加 / 点击已选移除 | <a href="#" onclick="toggleSelectAllModels(event,'pf-model-picker')" style="color:var(--primary)">全选</a></div>`
      + models.map(m => {
        const sel = current.includes(m.id) ? ' sel' : '';
        return `<div class="model-picker-item${sel}" data-model="${esc(m.id)}">${current.includes(m.id) ? '✓ ' : ''}${esc(m.id)}</div>`;
      }).join('');
    picker.querySelectorAll('.model-picker-item').forEach(el => {
      el.addEventListener('click', () => {
        const parts = modelInput.value.split(',').map(s => s.trim()).filter(Boolean);
        const idx = parts.indexOf(el.dataset.model);
        if (idx >= 0) { parts.splice(idx, 1); }
        else { parts.push(el.dataset.model); }
        modelInput.value = parts.join(', ');
        el.classList.toggle('sel');
        el.textContent = (el.classList.contains('sel') ? '✓ ' : '') + el.dataset.model;
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
        <div class="pdetail">${esc((p.models || [p.model]).filter(Boolean).join(', ') || '-')} · ${esc(p.base_url)}</div>
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
    if (S.providers.length && !S.activePid) { S.activePid = S.providers[0].id; S.activeModel = S.providers[0].models?.[0] || ''; }
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

async function openUsers() {
  $('#user-list').innerHTML = '<div style="padding:12px;color:var(--text3);text-align:center">加载中...</div>';
  $('#users-page').classList.remove('hidden');
  await loadUsers();
  $('#user-add-form').style.display = 'none';
  $('#btn-add-user').style.display = '';
}

// ===== SETTINGS PAGE ============================================================
function settings_switchTab(tab) {
  document.querySelectorAll('.set-nav-item').forEach(n => n.classList.toggle('active', n.dataset.tab === tab));
  document.querySelectorAll('.set-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tab}`));
}

async function settings_loadProviders() {
  try { S.providers = await api('GET', '/api/providers'); } catch { S.providers = []; }
  if (!S.activePid && S.providers.length) {
    S.activePid = S.providers[0].id;
    S.activeModel = S.providers[0].models?.[0] || S.providers[0].model || '';
  }
}

function settings_renderProviderList() {
  const list = $('#providers-list');
  if (!list) return;
  list.innerHTML = S.providers.map(p => `
    <div class="provider-item${p.id === S.activePid ? ' active' : ''}" data-sid="${p.id}">
      <div class="pname">${esc(p.name)}</div>
      <div class="pdetail">${esc((p.models || [p.model]).filter(Boolean).join(', ') || '-')}</div>
    </div>`).join('') || '<div style="padding:16px;color:var(--text3);font-size:12px;text-align:center">暂无提供商</div>';

  list.querySelectorAll('.provider-item').forEach(item => {
    item.addEventListener('click', () => {
      const pid = item.dataset.sid;
      S.activePid = pid;
      settings_renderProviderList();
      settings_renderProviderForm(pid);
    });
  });
}

function settings_renderProviderForm(pid) {
  const area = $('#provider-editor');
  if (!area) return;
  const p = pid ? S.providers.find(x => x.id === pid) : null;

  if (!pid || !p) {
    // New provider
    area.innerHTML = `<div class="pf-form">
      <h3 style="font-size:16px;font-weight:600;color:var(--text);margin-bottom:20px">新建提供商</h3>
      <label>名称 <span style="color:var(--danger-text)">*</span></label>
      <input type="text" id="pf-name" placeholder="如：DeepSeek">
      <label>API 地址 <span style="color:var(--danger-text)">*</span></label>
      <input type="text" id="pf-url" placeholder="https://api.deepseek.com">
      <label>API Key <span style="color:var(--danger-text)">*</span></label>
      <input type="password" id="pf-key" placeholder="sk-...">
      <label>模型列表 <span style="color:var(--danger-text)">*</span></label>
      <div class="pf-model-bar"><input type="text" id="pf-models" placeholder="deepseek-chat, deepseek-reasoner"><button class="btn-sm" id="btn-pf-fetch">获取</button></div>
      <div class="model-picker" id="pf-model-picker" style="display:none"></div>
      <div class="pf-actions">
        <button class="btn-sm" id="btn-pf-cancel">取消</button>
        <button class="btn-sm primary" id="btn-pf-save">保存</button>
      </div>
    </div>`;
    $('#btn-pf-save').addEventListener('click', () => settings_saveProvider(null));
    $('#btn-pf-cancel').addEventListener('click', () => { S.activePid = S.providers.length ? S.providers[0].id : null; settings_renderProviderList(); if (S.activePid) settings_renderProviderForm(S.activePid); else area.innerHTML = '<div class="empty-state">选择左侧提供商或点击「添加」</div>'; });
    $('#btn-pf-fetch').addEventListener('click', () => fetchModelsFromUrl());
    return;
  }

  // Edit existing
  const models = (p.models || []).join(', ');
  area.innerHTML = `<div class="pf-form">
    <h3 style="font-size:16px;font-weight:600;color:var(--text);margin-bottom:20px">${esc(p.name)}</h3>
    <label>名称 <span style="color:var(--danger-text)">*</span></label>
    <input type="text" id="pf-name" value="${esc(p.name)}">
    <label>API 地址 <span style="color:var(--danger-text)">*</span></label>
    <input type="text" id="pf-url" value="${esc(p.base_url)}">
    <label>API Key</label>
    <input type="password" id="pf-key" placeholder="留空则不修改">
    <label>模型列表 <span style="color:var(--danger-text)">*</span></label>
    <div class="pf-model-bar"><input type="text" id="pf-models" value="${esc(models)}"><button class="btn-sm" id="btn-pf-fetch">获取</button></div>
    <div class="model-picker" id="pf-model-picker" style="display:none"></div>
    <div class="pf-actions">
      <button class="btn-sm danger" id="btn-pf-delete">删除</button>
      <button class="btn-sm" id="btn-pf-cancel">取消</button>
      <button class="btn-sm primary" id="btn-pf-save">保存</button>
    </div>
  </div>`;
  $('#btn-pf-save').addEventListener('click', () => settings_saveProvider(pid));
  $('#btn-pf-cancel').addEventListener('click', () => { settings_renderProviderForm(pid); });
  $('#btn-pf-delete').addEventListener('click', () => settings_deleteProvider(pid));
  $('#btn-pf-fetch').addEventListener('click', () => fetchProviderModels(pid));
}

async function settings_saveProvider(pid) {
  const modelsRaw = ($('#pf-models').value || '').trim();
  const modelList = modelsRaw ? modelsRaw.split(',').map(m => m.trim()).filter(Boolean) : [];
  const body = {
    name: $('#pf-name').value.trim(),
    base_url: $('#pf-url').value.trim(),
    models: modelList.join(','),
    model: modelList[0] || ''
  };
  const key = ($('#pf-key').value || '').trim();
  if (key) body.api_key = key;
  if (!body.name || !body.base_url || !body.models || (!pid && !key)) {
    alert('名称、API 地址、模型列表、API Key 均为必填'); return;
  }
  try {
    if (pid) { await api('PUT', `/api/providers/${pid}`, body); }
    else {
      const r = await api('POST', '/api/providers', body);
      S.activePid = r.id;
    }
    await settings_loadProviders();
    if (!S.activePid && S.providers.length) S.activePid = S.providers[0].id;
    settings_renderProviderList();
    if (S.activePid) settings_renderProviderForm(S.activePid);
  } catch (e) { alert(e.message); }
}

async function settings_deleteProvider(pid) {
  if (!confirm('删除此提供商？关联的对话也会被删除。')) return;
  try {
    await api('DELETE', `/api/providers/${pid}`);
    S.providers = S.providers.filter(p => p.id !== pid);
    if (S.activePid === pid) S.activePid = S.providers[0]?.id || null;
    settings_renderProviderList();
    const area = $('#provider-editor');
    if (S.activePid) settings_renderProviderForm(S.activePid);
    else area.innerHTML = '<div class="empty-state">选择左侧提供商或点击「添加」</div>';
  } catch (e) { alert(e.message); }
}

async function settings_saveAll() {
  try {
    await api('POST', '/api/settings', {
      turnstile_site_key: $('#settings-sitekey').value.trim(),
      turnstile_secret: $('#settings-secret').value.trim(),
      idle_timeout: parseInt($('#settings-idle').value) || 1440,
      use_container_network: $('#settings-container-net').checked,
      web_search_engine: $('#settings-search-engine').value,
      web_search_api_key: $('#settings-search-key').value.trim(),
      querit_max_results: parseInt($('#settings-search-max').value) || 10,
      querit_time_range: $('#settings-search-time').value,
      user_models: $('#settings-user-models').value.trim()
    });
    alert('保存成功');
  } catch (e) { alert('保存失败: ' + e.message); }
}

function setMainError(msg) {
  const main = document.querySelector('.set-main');
  if (main) main.innerHTML = '<div style="padding:24px;background:var(--danger-bg);color:var(--danger-text);border-radius:10px;margin:16px;">' + msg + '</div>';
}

async function initSettings() {
  // Bind all events immediately — page stays responsive regardless of API status
  document.querySelectorAll('.set-nav-item').forEach(item => {
    item.addEventListener('click', () => settings_switchTab(item.dataset.tab));
  });
  $('#btn-add-provider')?.addEventListener('click', () => {
    S.activePid = null;
    settings_renderProviderList();
    settings_renderProviderForm(null);
  });
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-sm primary';
  saveBtn.textContent = '保存设置';
  saveBtn.style.cssText = 'position:fixed;bottom:24px;right:24px;padding:10px 20px;font-size:13px;box-shadow:0 2px 12px rgba(0,0,0,.15);z-index:10;';
  saveBtn.addEventListener('click', settings_saveAll);
  document.body.appendChild(saveBtn);

  // Check auth — show clear error instead of silent redirect
  try {
    const s = await api('GET', '/api/status');
    if (!s.initialized) { setMainError('系统未初始化，请先 <a href="index.html">完成初始化</a> 后再访问设置'); return; }
    if (!s.is_admin) { setMainError('需要管理员权限，请 <a href="index.html">返回首页</a>'); return; }
  } catch (e) {
    setMainError('连接服务器失败（' + esc(e.message) + '），请 <a href="index.html">刷新重试</a>');
    return;
  }

  // Load data asynchronously
  try {
    const s = await api('GET', '/api/settings');
    $('#settings-sitekey').value = s.turnstile_site_key || '';
    $('#settings-secret').value = s.turnstile_secret || '';
    $('#settings-idle').value = s.idle_timeout || 1440;
    $('#settings-container-net').checked = s.use_container_network || false;
    $('#settings-search-engine').value = s.web_search_engine || 'bing';
    $('#settings-search-key').value = s.web_search_api_key || '';
    $('#settings-search-max').value = s.querit_max_results || 10;
    $('#settings-search-time').value = s.querit_time_range || 'none';
    $('#settings-user-models').value = s.user_models || '';
  } catch {}

  try { await settings_loadProviders(); settings_renderProviderList(); if (S.activePid) settings_renderProviderForm(S.activePid); } catch {}
}

// ===== USERS PAGE ==============================================================
function users_renderList(users) {
  const list = $('#user-list');
  if (!list) return;
  list.innerHTML = users.map(u => `
    <div class="usr-item">
      <div class="usr-info">
        <div class="usr-name">${esc(u.username)} <span class="usr-badge ${u.is_admin ? 'admin' : 'user'}">${u.is_admin ? '管理员' : '普通用户'}</span></div>
        <div class="usr-meta">创建于 ${new Date(u.created_at*1000).toLocaleString('zh-CN')}</div>
      </div>
      <button class="btn-sm danger" data-del="${u.id}" ${u.is_admin ? 'disabled' : ''}>删除</button>
    </div>`).join('') || '<div class="usr-empty">暂无用户</div>';

  list.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => users_delete(btn.dataset.del));
  });
}

async function users_load() {
  const list = $('#user-list');
  if (!list) return;
  try {
    const r = await api('GET', '/api/users');
    users_renderList(r.users || []);
  } catch (e) {
    const msg = e.name === 'AbortError' ? '请求超时，请检查网络连接后刷新重试' : e.message;
    list.innerHTML = `<div class="usr-error">加载失败: ${esc(msg)}</div>`;
  }
}

function users_toggleAdd() {
  const form = $('#user-add-form');
  const show = form.style.display === 'none' || !form.style.display;
  form.style.display = show ? 'block' : 'none';
  $('#btn-add-user').style.display = show ? 'none' : '';
  if (show) $('#new-username').focus();
}

async function users_add() {
  const name = $('#new-username').value.trim();
  const pw = $('#new-user-password').value.trim();
  if (!name || !pw) { alert('用户名和密码不能为空'); return; }
  if (pw.length < 4) { alert('密码至少 4 位'); return; }
  try {
    await api('POST', '/api/users', { username: name, password: pw });
    $('#new-username').value = '';
    $('#new-user-password').value = '';
    users_toggleAdd();
    await users_load();
  } catch (e) { alert(e.message); }
}

async function users_delete(uid) {
  if (!confirm('确定删除此用户？')) return;
  try {
    await api('DELETE', `/api/users/${uid}`);
    await users_load();
  } catch (e) { alert(e.message); }
}

async function initUsers() {
  // Bind events immediately
  $('#btn-add-user')?.addEventListener('click', users_toggleAdd);
  $('#btn-add-user-confirm')?.addEventListener('click', users_add);
  $('#btn-add-user-cancel')?.addEventListener('click', users_toggleAdd);

  // Check auth — show error instead of silent redirect
  try {
    const s = await api('GET', '/api/status');
    if (!s.initialized || !s.is_admin) {
      const list = $('#user-list');
      if (list) list.innerHTML = '<div class="usr-error">无权限访问，请 <a href="index.html">返回首页</a></div>';
      return;
    }
  } catch (e) {
    const list = $('#user-list');
    if (list) list.innerHTML = '<div class="usr-error">连接失败: ' + esc(e.message) + '，请 <a href="index.html">刷新重试</a></div>';
    return;
  }

  // Load data
  try { await users_load(); } catch {}
}

// ===== PAGE ROUTER =============================================================
(function() {
  const path = window.location.pathname.split('/').pop();
  if (path === 'settings.html' || path === 'settings') initSettings();
  else if (path === 'users.html' || path === 'users') initUsers();
  else checkStatus();
})();
