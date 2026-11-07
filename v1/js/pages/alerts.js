import { get, fmt, icon, esc, toast } from '../core.js';

const TYPE_META = {
  suspect: { icon: 'alert', label: '表码异常' },
  offline: { icon: 'plug', label: '设备离线' },
  no_data: { icon: 'plug', label: '无数据' },
  arrears: { icon: 'bill', label: '欠费逾期' },
  spike: { icon: 'bolt', label: '电量突增' },
  drop: { icon: 'bolt', label: '电量骤降' },
  zero: { icon: 'meter', label: '零电量' },
  replacement: { icon: 'swap', label: '换表待办' },
};

const FILTERS = [
  ['', '全部'], ['high', '高优先'], ['suspect', '表码'], ['offline', '离线'], ['arrears', '欠费'], ['spike', '电量异常'], ['replacement', '换表'],
];

export default async function render(view, ctx) {
  const { items } = await get('/api/alerts');
  const filter = ctx.query.type || '';
  const list = filter
    ? items.filter((a) => (filter === 'high' ? a.severity === 'high' : filter === 'spike' ? ['spike', 'drop', 'zero'].includes(a.type) : a.type === filter))
    : items;

  const high = items.filter((a) => a.severity === 'high').length;
  const medium = items.filter((a) => a.severity === 'medium').length;
  const low = items.filter((a) => a.severity === 'low').length;
  const totalAmount = items.filter((a) => a.type === 'arrears').reduce((s, a) => s + (a.amount || 0), 0);

  view.innerHTML = `
    <div class="page-head">
      <div><h1>异常中心</h1><p>系统根据抄表数据自动推导，无需人工标记</p></div>
      <div class="page-actions">
        <button class="btn" id="reload">${icon('refresh')}刷新</button>
      </div>
    </div>

    <div class="grid g-4 mb-16">
      <div class="card kpi"><div class="kpi-label">待处理异常</div>
        <div class="kpi-value">${items.length}</div><div class="kpi-foot">全部类型合计</div></div>
      <div class="card kpi"><div class="kpi-label">高优先</div>
        <div class="kpi-value" style="color:var(--danger)">${high}</div><div class="kpi-foot">需当日处理</div></div>
      <div class="card kpi"><div class="kpi-label">中 / 低优先</div>
        <div class="kpi-value">${medium}<span class="muted" style="font-size:16px"> / ${low}</span></div>
        <div class="kpi-foot">可安排计划处理</div></div>
      <div class="card kpi"><div class="kpi-label">涉欠金额</div>
        <div class="kpi-value" style="color:var(--accent)">¥${fmt.money(totalAmount)}</div><div class="kpi-foot">逾期账单合计</div></div>
    </div>

    <div class="toolbar">
      ${FILTERS.map(([v, l]) => `<button class="btn sm ${filter === v ? 'primary' : ''}" data-f="${v}">${l}</button>`).join('')}
    </div>

    <div class="card">
      <div class="card-body" style="padding:6px 18px">
        ${list.length ? list.map((a) => `
          <div class="list-item" style="padding:14px 0">
            <span class="kpi-ico ${a.severity === 'high' ? 'red' : a.severity === 'medium' ? 'amber' : 'blue'}"
              style="width:34px;height:34px;border-radius:10px">${icon(TYPE_META[a.type]?.icon || 'alert')}</span>
            <div class="li-main">
              <b>${esc(a.title)} ${a.accountNo ? `<span class="mono muted small" style="font-weight:400">${a.accountNo}</span>` : ''}</b>
              <span>${esc(a.customerName || '')} ${esc(a.detail || '')}</span>
            </div>
            <div class="row gap-8">
              ${a.amount ? `<b style="color:var(--danger)">¥${fmt.money(a.amount)}</b>` : ''}
              ${a.accountId ? `<button class="btn sm" data-acc="${a.accountId}">查看户档</button>` : ''}
              ${a.type === 'offline' || a.type === 'no_data' ? `<button class="btn sm" data-goto="readings">补录</button>` : ''}
              ${a.type === 'replacement' ? `<button class="btn sm" data-goto="replacements">去处理</button>` : ''}
              ${a.type === 'arrears' ? `<button class="btn sm" data-goto="bills">账单</button>` : ''}
            </div>
          </div>`).join('') : '<div class="empty"><div class="empty-ico">' + icon('check') + '</div>没有该类型的异常</div>'}
      </div>
    </div>`;

  view.querySelectorAll('[data-f]').forEach((b) => {
    b.onclick = () => ctx.navigate(b.dataset.f ? `/alerts?type=${b.dataset.f}` : '/alerts');
  });
  view.querySelectorAll('[data-acc]').forEach((b) => {
    b.onclick = () => ctx.navigate(`/accounts?id=${b.dataset.acc}`);
  });
  view.querySelectorAll('[data-goto]').forEach((b) => {
    b.onclick = () => ctx.navigate(`/${b.dataset.goto}`);
  });
  view.querySelector('#reload').onclick = () => ctx.refresh();
}
