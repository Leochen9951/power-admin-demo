import {
  get, post, fmt, icon, p, esc, table, bindRowClick, pager, bindPager, openModal,
  field, formData, toast, confirmDialog,
} from '../core.js';
import { openBillModal } from './accounts.js';

const SIZE = 15;
const TABS = [['', '全部'], ['unpaid', '待缴 / 欠费'], ['paid', '已缴清'], ['overdue', '已逾期'], ['partial', '部分缴']];

export default async function render(view, ctx) {
  const q = { page: 1, ...ctx.query };
  const periods = (ctx.meta?.periods || []).map((x) => x.period);
  const period = q.period || periods[0] || '';
  const qs = new URLSearchParams();
  if (period) qs.set('period', period);
  if (q.status) qs.set('status', q.status);
  if (q.q) qs.set('q', q.q);
  qs.set('page', q.page); qs.set('size', SIZE);

  const data = await get(`/api/bills?${qs}`);
  const s = data.summary || {};

  view.innerHTML = `
    <div class="page-head">
      <div><h1>账单管理</h1><p>按月出账 · 调整项并入下一期，不改历史账单</p></div>
      <div class="page-actions">
        <select class="select" id="fperiod">
          ${periods.map((x) => `<option value="${x}" ${x === period ? 'selected' : ''}>${fmt.period(x)}</option>`).join('')}
        </select>
        <a class="btn" href="/api/export/bills?period=${period}">${icon('down')}导出</a>
        <button class="btn primary" id="btnIssue">${icon('bill')}生成账单</button>
      </div>
    </div>

    <div class="grid g-4 mb-16">
      <div class="card kpi"><div class="kpi-label">应收合计</div>
        <div class="kpi-value">¥${fmt.money(s.amount)}</div>
        <div class="kpi-foot">${s.cnt || 0} 张账单 · ${fmt.kwh(s.kwh)} kWh</div></div>
      <div class="card kpi"><div class="kpi-label">实收金额</div>
        <div class="kpi-value" style="color:var(--primary)">¥${fmt.money(s.paid)}</div>
        <div class="kpi-foot">收缴率 ${s.amount ? ((s.paid / s.amount) * 100).toFixed(1) : 0}%</div></div>
      <div class="card kpi"><div class="kpi-label">未结清账单</div>
        <div class="kpi-value" style="color:var(--accent)">${s.unpaid_cnt || 0}</div>
        <div class="kpi-foot">张待缴 / 逾期</div></div>
      <div class="card kpi"><div class="kpi-label">本账期欠费</div>
        <div class="kpi-value" style="color:var(--danger)">¥${fmt.money(s.outstanding)}</div>
        <div class="kpi-foot">含部分缴费余额</div></div>
    </div>

    <div class="toolbar">
      <div class="search">${icon('search')}<input class="input" id="fq" placeholder="户号 / 姓名 / 电话" value="${esc(q.q || '')}"/></div>
      <div class="row gap-4" id="tabs">
        ${TABS.map(([v, l]) => `<button class="btn sm ${String(q.status || '') === v ? 'primary' : ''}" data-st="${v}">${l}</button>`).join('')}
      </div>
      <div class="spacer"></div>
      <span class="small muted">点击行查看计费明细</span>
    </div>

    <div class="card">
      ${table({
        columns: [
          { label: '账单号', render: (r) => `<span class="mono small">${r.bill_no}</span>` },
          { label: '用户', render: (r) => `<div class="strong">${esc(r.customer_name)}</div><div class="small muted mono">${r.account_no}</div>` },
          { label: '账期', render: (r) => `<span class="mono">${r.period}</span>` },
          { label: '用电量', align: 'right', render: (r) => `${fmt.kwh(r.usage_kwh)} <span class="muted small">kWh</span>` },
          { label: '电费', align: 'right', render: (r) => `¥${fmt.money(r.energy_fee)}` },
          { label: '调整', align: 'right', render: (r) => Number(r.adjustment) ? `<span style="color:${Number(r.adjustment) > 0 ? 'var(--danger)' : 'var(--ok)'}">${Number(r.adjustment) > 0 ? '+' : ''}${fmt.money(r.adjustment)}</span>` : '<span class="muted">—</span>' },
          { label: '应收', align: 'right', render: (r) => `<b>¥${fmt.money(r.total_amount)}</b>` },
          { label: '已缴', align: 'right', render: (r) => `¥${fmt.money(r.paid_amount)}` },
          { label: '状态', render: (r) => p.bill(r.status) },
          { label: '到期日', render: (r) => `<span class="small mono">${fmt.date(r.due_date)}</span>` },
        ],
        rows: data.items,
        empty: '该账期暂无账单',
      })}
      ${data.total ? pager({ page: data.page, pages: data.pages, total: data.total, size: data.size }) : ''}
    </div>`;

  view.querySelector('#fperiod').onchange = (e) => {
    const u = new URLSearchParams(); u.set('period', e.target.value);
    ctx.navigate(`/bills?${u}`);
  };
  view.querySelectorAll('[data-st]').forEach((b) => {
    b.onclick = () => {
      const u = new URLSearchParams();
      if (period) u.set('period', period);
      if (b.dataset.st) u.set('status', b.dataset.st);
      ctx.navigate(`/bills?${u}`);
    };
  });
  view.querySelector('#fq').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const u = new URLSearchParams();
      if (period) u.set('period', period);
      if (e.target.value) u.set('q', e.target.value);
      ctx.navigate(`/bills?${u}`);
    }
  });
  bindPager(view, (page) => {
    const u = new URLSearchParams(location.hash.split('?')[1] || '');
    u.set('page', page); ctx.navigate(`/bills?${u}`);
  });
  bindRowClick(view, data.items, async (r) => {
    const { bill } = await get(`/api/bills/${r.id}`);
    openBillModal(bill);
  });
  view.querySelector('#btnIssue').onclick = () => openIssue(ctx);
}

function openIssue(ctx) {
  const meta = ctx.meta || { periods: [] };
  const done = new Set((meta.periods || []).map((x) => x.period));
  const now = new Date();
  const base = now.getFullYear() * 12 + now.getMonth() + 1;
  const options = [];
  let firstOpen = null;
  for (let i = 0; i < 14; i++) {
    const t = base - i;
    const y = Math.floor((t - 1) / 12);
    const m = ((t - 1) % 12) + 1;
    const per = `${y}-${String(m).padStart(2, '0')}`;
    const isDone = done.has(per);
    if (!isDone && !firstOpen) firstOpen = per;
    options.push(`<option value="${per}" ${isDone ? 'disabled' : ''} ${per === firstOpen ? 'selected' : ''}>${fmt.period(per)}${isDone ? '（已出账）' : ''}</option>`);
  }
  if (!firstOpen) {
    return toast('最近 14 个账期均已出账，暂无需要生成的账单');
  }
  openModal({
    title: '生成账期账单',
    subtitle: '按安装段内的读数差 × 倍率计算电量，叠加阶梯电价与未结调整项',
    body: `
      <label class="field"><span>选择账期</span>
        <select class="select" name="period" style="width:100%">${options.join('')}</select></label>
      <div class="notice warn">${icon('alert')}<div>出账后不可直接修改金额，只能通过「调整项」在后续账期追补或退补；已出账的账期会自动跳过。</div></div>`,
    footer: `<button class="btn" data-close-modal>取消</button><button class="btn primary" data-submit>开始出账</button>`,
    onMount(root, close) {
      root.querySelector('[data-submit]').onclick = async () => {
        const body = formData(root);
        if (!body.period) return toast('没有可出账的账期', 'err');
        try {
          const res = await post('/api/bills/issue', body);
          close();
          toast(`${res.period} 出账完成：${res.accounts} 户，¥${fmt.money(res.amount)}`);
          ctx.navigate(`/bills?period=${res.period}`);
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}
