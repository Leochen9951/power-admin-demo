/* ============================================================
   核心：API、格式化、DOM 小工具
   ============================================================ */

const state = { user: null, meta: null };

export async function api(path, opts = {}) {
  // 静态演示版（GitHub Pages）：请求转交本地快照数据层
  if (typeof window !== 'undefined' && window.__staticApi) {
    return window.__staticApi(path, opts);
  }
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error(data?.error || `请求失败 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}
export const get = (p) => api(p);
export const post = (p, body) => api(p, { method: 'POST', body });
export const put = (p, body) => api(p, { method: 'PUT', body });

export { state };

/* ---------------------------- 格式化 ---------------------------- */
export const fmt = {
  money(n, d = 2) {
    if (n === null || n === undefined || n === '') return '—';
    return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
  },
  int(n) {
    if (n === null || n === undefined) return '—';
    return Number(n).toLocaleString('zh-CN');
  },
  kwh(n, d = 1) {
    if (n === null || n === undefined) return '—';
    return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
  },
  date(s) { return s ? String(s).slice(0, 10) : '—'; },
  dt(s) { return s ? String(s).slice(0, 16) : '—'; },
  time(s) { return s ? String(s).slice(11, 16) : ''; },
  period(p) {
    if (!p) return '—';
    const [y, m] = String(p).split('-');
    return `${y} 年 ${Number(m)} 月`;
  },
  month(p) { return p ? String(p).slice(5, 7) + '月' : ''; },
  pct(n, d = 1) { return n === null || n === undefined ? '—' : `${Number(n).toFixed(d)}%`; },
  weekday(s) { return '日一二三四五六'[new Date(s).getDay()]; },
};

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
export const esc = escapeHtml;

export function icon(name, cls = '') {
  return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

export function debounce(fn, ms = 320) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ---------------------------- 状态展示 ---------------------------- */
const ACCOUNT_STATUS = { active: ['正常', 'ok'], suspended: ['暂停', 'warn'], closed: ['销户', 'gray'], pending: ['待开户', 'info'] };
const BILL_STATUS = { paid: ['已缴清', 'ok'], issued: ['待缴费', 'info'], partial: ['部分缴', 'warn'], overdue: ['已逾期', 'danger'], void: ['已作废', 'gray'], draft: ['草稿', 'gray'] };
const DEVICE_STATUS = { in_service: ['在运', 'ok'], in_stock: ['库存', 'info'], fault: ['故障', 'danger'], returned: ['返厂', 'warn'], scrapped: ['报废', 'gray'] };
const WORK_STATUS = { reported: ['待派单', 'warn'], processing: ['处理中', 'info'], pending_review: ['待审核', 'purple'], completed: ['已完成', 'ok'], cancelled: ['已取消', 'gray'] };
const PAY_STATUS = { success: ['支付成功', 'ok'], pending: ['处理中', 'info'], failed: ['失败', 'danger'], refunded: ['已退款', 'warn'], timeout: ['超时', 'gray'] };
const SOURCE_NAME = { iot_push: '设备上报', iot_poll: '平台召测', manual: '人工补录', estimated: '估抄', import: '导入', migration: '迁移' };
const QUALITY_NAME = { valid: ['正常', 'ok'], estimated: ['估抄', 'warn'], suspect: ['异常', 'danger'], missing: ['缺失', 'gray'] };
const REASON_NAME = { meter_fault: '表计故障', module_fault: '通信模块故障', ratio_change: '倍率变更', relocation: '移表', other: '其他' };

function pill(map, v, fallback = '—') {
  const [label, cls] = map[v] || [fallback, 'gray'];
  return `<span class="pill ${cls}">${label}</span>`;
}
export const p = {
  account: (v) => pill(ACCOUNT_STATUS, v),
  bill: (v) => pill(BILL_STATUS, v),
  device: (v) => pill(DEVICE_STATUS, v),
  work: (v) => pill(WORK_STATUS, v),
  pay: (v) => pill(PAY_STATUS, v),
  quality: (v) => pill(QUALITY_NAME, v, v),
  source: (v) => `<span class="tag">${SOURCE_NAME[v] || v}</span>`,
  reason: (v) => REASON_NAME[v] || v || '—',
};
export const LABELS = { ACCOUNT_STATUS, BILL_STATUS, DEVICE_STATUS, WORK_STATUS, PAY_STATUS, SOURCE_NAME, QUALITY_NAME, REASON_NAME };

export function amountClass(n) {
  return Number(n) > 0 ? '' : 'muted';
}

/* ---------------------------- Toast ---------------------------- */
export function toast(msg, type = '') {
  const root = document.getElementById('toastRoot');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(type === 'err' ? 'alert' : 'check')}<span>${escapeHtml(msg)}</span>`;
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = '.3s'; }, 2600);
  setTimeout(() => el.remove(), 3000);
}

/* ---------------------------- 弹窗 ---------------------------- */
let openCount = 0;
export function openModal({ title, subtitle = '', body, footer = '', size = '', onMount, closeOnMask = true }) {
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.innerHTML = `
    <div class="modal ${size}" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div><h3>${title}</h3>${subtitle ? `<p>${subtitle}</p>` : ''}</div>
        <button class="x-btn" data-close>${icon('x')}</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;
  document.getElementById('modalRoot').appendChild(wrap);
  openCount++;
  const close = () => {
    if (!wrap.parentNode) return;
    wrap.remove(); openCount--;
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape' && openCount) close(); };
  document.addEventListener('keydown', onKey);
  wrap.querySelector('[data-close]').onclick = close;
  if (closeOnMask) wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  wrap.querySelectorAll('[data-close-modal]').forEach((b) => (b.onclick = close));
  if (onMount) onMount(wrap, close);
  return { close, root: wrap };
}

export function confirmDialog(title, text, { danger = false, okText = '确定' } = {}) {
  return new Promise((resolve) => {
    const m = openModal({
      title,
      size: '',
      body: `<p style="color:var(--ink-2);font-size:13px;line-height:1.7">${text}</p>`,
      footer: `<button class="btn" data-close-modal>取消</button>
               <button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${okText}</button>`,
      onMount(root, close) {
        root.querySelector('[data-ok]').onclick = () => { close(); resolve(true); };
        root.querySelector('[data-close-modal]').onclick = () => { close(); resolve(false); };
        root.addEventListener('mousedown', (e) => { if (e.target === root) resolve(false); });
      },
    });
    void m;
  });
}

/** 路由切换时清理残留的弹窗与抽屉，避免遮罩留在新页面上 */
export function closeAllLayers() {
  document.querySelectorAll('#modalRoot .overlay').forEach((el) => el.remove());
  document.querySelectorAll('.drawer-wrap').forEach((el) => el.remove());
  document.body.style.overflow = '';
  openCount = 0;
}

/* ---------------------------- 抽屉 ---------------------------- */
export function openDrawer({ title, subtitle = '', headExtra = '', body, onMount }) {
  const wrap = document.createElement('div');
  wrap.className = 'drawer-wrap';
  wrap.innerHTML = `
    <div class="drawer-mask" data-close></div>
    <div class="drawer">
      <div class="drawer-head">
        <div class="row between" style="align-items:flex-start">
          <div>
            <h3 style="font-size:17px;letter-spacing:-.3px">${title}</h3>
            ${subtitle ? `<p style="color:var(--muted);font-size:12.5px;margin-top:3px">${subtitle}</p>` : ''}
          </div>
          <button class="x-btn" data-close>${icon('x')}</button>
        </div>
        ${headExtra}
      </div>
      <div class="drawer-body">${body}</div>
    </div>`;
  document.body.appendChild(wrap);
  wrap.style.overflow = 'hidden';
  const close = () => { wrap.remove(); document.body.style.overflow = ''; document.removeEventListener('keydown', key); };
  const key = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', key);
  wrap.querySelectorAll('[data-close]').forEach((b) => (b.onclick = close));
  document.body.style.overflow = 'hidden';
  if (onMount) onMount(wrap, close);
  return { close, root: wrap };
}

/* ---------------------------- 表格 ---------------------------- */
export function table({ columns, rows, empty = '暂无数据', onRowClick = null }) {
  if (!rows || !rows.length) {
    return `<div class="tbl-wrap-empty">${empty}</div>`;
  }
  const head = columns.map((c) => `<th class="${c.align === 'right' ? 'num' : ''} ${c.cls || ''}">${c.label}</th>`).join('');
  const body = rows.map((r, i) => {
    const tds = columns.map((c) => {
      const v = typeof c.render === 'function' ? c.render(r, i) : (r[c.key] ?? '—');
      return `<td class="${c.align === 'right' ? 'num' : ''} ${c.cls || ''}">${v}</td>`;
    }).join('');
    return `<tr class="${onRowClick ? 'clickable' : ''}" data-idx="${i}">${tds}</tr>`;
  }).join('');
  return `<div class="table-wrap"><table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function bindRowClick(root, rows, handler) {
  root.querySelectorAll('tbody tr[data-idx]').forEach((tr) => {
    tr.classList.add('clickable');
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button, a, input, select')) return;
      handler(rows[Number(tr.dataset.idx)]);
    });
  });
}

export function pager({ page, pages, total, size }, onChange) {
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(page * size, total);
  const nums = [];
  const push = (n) => nums.push(n);
  const start = Math.max(1, Math.min(page - 2, pages - 4));
  for (let i = start; i <= Math.min(pages, start + 4); i++) push(i);
  if (!nums.includes(1)) nums.unshift(1);
  if (!nums.includes(pages) && pages > 1) nums.push(pages);
  return `<div class="pagination">
    <span>共 ${total} 条，当前 ${from}–${to}</span>
    <div class="pager">
      <button data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹</button>
      ${nums.map((n, i) => {
        const prev = nums[i - 1];
        const gap = prev && n - prev > 1 ? '<button disabled>…</button>' : '';
        return `${gap}<button data-page="${n}" class="${n === page ? 'active' : ''}">${n}</button>`;
      }).join('')}
      <button data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>›</button>
    </div>
  </div>`.replace(/<button disabled>…<\/button>/g, '<button disabled>…</button>');
}

export function bindPager(root, onChange) {
  root.querySelectorAll('.pager button[data-page]').forEach((b) => {
    if (b.disabled) return;
    b.addEventListener('click', () => onChange(Number(b.dataset.page)));
  });
}

/* ---------------------------- 表单 ---------------------------- */
export function field({ label, name, value = '', type = 'text', options = null, placeholder = '', required = false, hint = '', span = 1, attrs = '' }) {
  let control;
  if (type === 'select') {
    control = `<select class="select" name="${name}" ${required ? 'required' : ''} style="width:100%">
      ${(options || []).map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
    </select>`;
  } else if (type === 'textarea') {
    control = `<textarea class="textarea" name="${name}" placeholder="${esc(placeholder)}" ${required ? 'required' : ''}>${esc(value)}</textarea>`;
  } else {
    control = `<input class="input" name="${name}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${required ? 'required' : ''} style="width:100%" ${attrs}/>`;
  }
  return `<label class="field" ${span > 1 ? `style="grid-column:span ${span}"` : ''}>
    <span>${label}${required ? ' <b style="color:var(--danger)">*</b>' : ''}</span>
    ${control}
    ${hint ? `<em style="display:block;font-style:normal;font-size:11px;color:var(--muted);margin-top:4px">${hint}</em>` : ''}
  </label>`;
}

export function formGrid(inner, cols = 2) {
  return `<div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:0 14px">${inner}</div>`;
}

export function formData(root) {
  const out = {};
  root.querySelectorAll('[name]').forEach((el) => {
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else out[el.name] = el.value.trim();
  });
  return out;
}

export function setTopNote(text) {
  const el = document.getElementById('topNote');
  if (el) el.textContent = text;
}

export function spinner(text = '加载中…') {
  return `<div class="empty"><div class="empty-ico">${icon('refresh')}</div>${text}</div>`;
}

export function notice(text, type = '') {
  return `<div class="notice ${type}">${icon(type === 'warn' ? 'alert' : 'check')}<div>${text}</div></div>`;
}
