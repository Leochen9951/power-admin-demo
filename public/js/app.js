import { api, get, state, icon, toast, closeAllLayers } from './core.js';
import dashboard from './pages/dashboard.js';
import accounts from './pages/accounts.js';
import devices from './pages/devices.js';
import replacements from './pages/replacements.js';
import readings from './pages/readings.js';
import bills from './pages/bills.js';
import payments from './pages/payments.js';
import alerts from './pages/alerts.js';
import system from './pages/system.js';

const ROUTES = {
  dashboard: { title: '运营概览', sub: '用电、费用与设备运行的整体视图', render: dashboard, group: '运营监控' },
  alerts: { title: '异常中心', sub: '离线、断档、表码异常与逾期欠费', render: alerts, group: '运营监控' },
  accounts: { title: '用户档案', sub: '户号、户主与计量点信息', render: accounts, group: '用户与资产' },
  devices: { title: '电表管理', sub: '物联网电表资产与安装关系', render: devices, group: '用户与资产' },
  replacements: { title: '换表工单', sub: '故障报修、换表与数据衔接', render: replacements, group: '用户与资产' },
  readings: { title: '抄表数据', sub: '设备上报、人工补录与数据质量', render: readings, group: '计费与收费' },
  bills: { title: '账单管理', sub: '按月出账、电费明细与欠费', render: bills, group: '计费与收费' },
  payments: { title: '缴费记录', sub: '支付流水与账单核销', render: payments, group: '计费与收费' },
  system: { title: '系统与模拟', sub: '演示数据、设备模拟与账期推进', render: system, group: '系统' },
};

const NAV = [
  { group: '运营监控', items: ['dashboard', 'alerts'] },
  { group: '用户与资产', items: ['accounts', 'devices', 'replacements'] },
  { group: '计费与收费', items: ['readings', 'bills', 'payments'] },
  { group: '系统', items: ['system'] },
];

const ICONS = {
  dashboard: 'dash', alerts: 'alert', accounts: 'users', devices: 'meter',
  replacements: 'swap', readings: 'list', bills: 'bill', payments: 'pay', system: 'gear',
};

const badges = { alerts: 0, replacements: 0 };
let current = 'dashboard';

/* ------------------------------- 启动 ------------------------------- */
async function boot() {
  bindLogin();
  try {
    const { user } = await get('/api/auth/me');
    state.user = user;
    showApp();
  } catch {
    showLogin();
  }
}

function showLogin() {
  document.getElementById('app').hidden = true;
  document.getElementById('login').hidden = false;
}

async function showApp() {
  document.getElementById('login').hidden = true;
  document.getElementById('app').hidden = false;
  document.getElementById('userName').textContent = state.user.name;
  document.getElementById('userRole').textContent =
    { admin: '系统管理员', collector: '抄表员', cashier: '收费员' }[state.user.role] || state.user.role;
  document.getElementById('avatar').textContent = state.user.name.slice(0, 1);
  document.getElementById('logoutBtn').onclick = async () => {
    if (window.__STATIC_DEMO__) { location.reload(); return; }
    await api('/api/auth/logout', { method: 'POST' });
    location.reload();
  };
  if (window.__STATIC_DEMO__) mountStaticBanner();
  try {
    state.meta = await get('/api/meta');
    setTopNote(`数据截止 ${String(state.meta.asOf || '').slice(0, 16)} · 演示环境`);
  } catch { /* ignore */ }
  document.getElementById('topNote').title = '物联网网关最近一次数据冻结时间';
  buildNav();
  if (!location.hash) location.hash = '#/dashboard';
  route();
  refreshBadges();
  setInterval(refreshBadges, 60000);
}

function bindLogin() {
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const btn = e.target.querySelector('button');
    btn.disabled = true; btn.textContent = '登录中…';
    try {
      const { user } = await api('/api/auth/login', { method: 'POST', body: { username, password } });
      state.user = user;
      showApp();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false; btn.textContent = '登 录';
    }
  });
}

/* ------------------------------- 导航 ------------------------------- */
function buildNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = NAV.map((g) => `
    <div class="nav-group">${g.group}</div>
    ${g.items.map((key) => `
      <button class="nav-item" data-route="${key}">
        ${icon(ICONS[key])}<span>${ROUTES[key].title}</span>
        ${key === 'alerts' ? '<span class="nav-badge danger" data-badge="alerts" hidden></span>' : ''}
        ${key === 'replacements' ? '<span class="nav-badge" data-badge="replacements" hidden></span>' : ''}
      </button>`).join('')}
  `).join('');
  nav.querySelectorAll('[data-route]').forEach((b) => {
    b.addEventListener('click', () => { location.hash = `#/${b.dataset.route}`; });
  });
}

function paintNav(name) {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.route === name));
}

function paintBadge(key, n) {
  const el = document.querySelector(`[data-badge="${key}"]`);
  if (!el) return;
  el.hidden = !n;
  el.textContent = n > 99 ? '99+' : n;
}

async function refreshBadges() {
  try {
    const { items } = await get('/api/alerts');
    badges.alerts = items.filter((a) => a.severity === 'high').length;
    paintBadge('alerts', badges.alerts);
  } catch { /* ignore */ }
  try {
    const { items } = await get('/api/replacements?status=reported');
    badges.replacements = items.length;
    paintBadge('replacements', badges.replacements);
  } catch { /* ignore */ }
}

/* ------------------------------- 路由 ------------------------------- */
export function navigate(path) {
  // 兼容 '/bills'、'#/bills'、'/bills?period=2026-09' 三种写法，统一归一化为 '#/bills'
  const clean = String(path ?? '').replace(/^#/, '').replace(/^\/+/, '');
  const next = `#/${clean}`;
  if (location.hash === next) { route(); return; }   // 同一地址也要触发一次重渲染
  location.hash = next;
}

async function route() {
  const raw = (location.hash || '#/dashboard').replace(/^#\/+/, '');
  const [name, qs] = raw.split('?');
  if (!ROUTES[name] && name) console.warn('[route] 未知路由，回到概览：', name);
  const page = ROUTES[name] ? name : 'dashboard';
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  current = page;
  paintNav(page);
  document.getElementById('crumb').innerHTML =
    `<span>智电云</span>${icon('chev')}<b>${ROUTES[page].title}</b>`;
  closeAllLayers();
  const view = document.getElementById('view');
  view.innerHTML = `<div class="empty">加载中…</div>`;
  try {
    await ROUTES[page].render(view, { query, navigate, refresh: () => route(), user: state.user, meta: state.meta });
  } catch (e) {
    if (e.status === 401) { showLogin(); return; }
    console.error(e);
    view.innerHTML = `<div class="card"><div class="empty">
      <div class="empty-ico">${icon('alert')}</div>
      <b>加载失败</b><div class="small muted" style="margin-top:6px">${e.message}</div>
    </div></div>`;
  }
}

window.addEventListener('hashchange', route);

export function setTopNote(text) {
  const el = document.getElementById('topNote');
  if (el) el.textContent = text;
}

function mountStaticBanner() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="/api/"], a[href^="./api/"]');
    if (!a) return;
    e.preventDefault();
    toast('静态演示版不支持导出，请使用在线版', 'err');
  });
  if (document.getElementById('staticBanner')) return;
  const el = document.createElement('div');
  el.id = 'staticBanner';
  el.innerHTML = '<b>静态演示版</b> · 数据为导出快照，缴费在浏览器内模拟，刷新后还原。完整功能请使用在线版。';
  document.body.appendChild(el);
  document.body.classList.add('has-static-banner');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
