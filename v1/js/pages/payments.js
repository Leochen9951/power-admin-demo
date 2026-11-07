import { get, fmt, icon, p, esc, table, bindRowClick, pager, bindPager, openModal, toast } from '../core.js';

const SIZE = 15;
const CHANNELS = [['', '全部渠道'], ['wechat', '微信支付'], ['alipay', '支付宝'], ['bank', '银行代扣'], ['cash', '营业厅现金']];

export default async function render(view, ctx) {
  const q = { page: 1, ...ctx.query };
  const qs = new URLSearchParams();
  if (q.channel) qs.set('channel', q.channel);
  qs.set('page', q.page); qs.set('size', SIZE);
  const data = await get(`/api/payments?${qs}`);
  const s = data.summary || {};

  view.innerHTML = `
    <div class="page-head">
      <div><h1>缴费记录</h1><p>支付单与账单多对多核销，支持一笔缴多期、一期多次缴</p></div>
      <div class="page-actions">
        <span class="pill ok">累计收款 ¥${fmt.money(s.amount)}</span>
      </div>
    </div>

    <div class="toolbar">
      <div class="row gap-4">
        ${CHANNELS.map(([v, l]) => `<button class="btn sm ${String(q.channel || '') === v ? 'primary' : ''}" data-ch="${v}">${l}</button>`).join('')}
      </div>
      <div class="spacer"></div>
      <span class="small muted">共 ${s.cnt || 0} 笔成功交易</span>
    </div>

    <div class="card">
      ${table({
        columns: [
          { label: '支付单号', render: (r) => `<span class="mono small">${r.pay_no}</span>` },
          { label: '用户', render: (r) => `<div class="strong">${esc(r.customer_name)}</div><div class="small muted mono">${r.account_no}</div>` },
          { label: '金额', align: 'right', render: (r) => `<b>¥${fmt.money(r.amount)}</b>` },
          { label: '渠道', render: (r) => `<span class="tag">${esc(r.channel_name)}</span>` },
          { label: '核销账单', render: (r) => `<span class="small">${r.bills_cnt} 张</span>` },
          { label: '状态', render: (r) => p.pay(r.status) },
          { label: '支付时间', render: (r) => `<span class="mono small">${fmt.dt(r.paid_at)}</span>` },
          { label: '付款人', render: (r) => `<span class="small">${esc(r.payer_name || '—')}</span>` },
        ],
        rows: data.items,
        empty: '暂无缴费记录',
      })}
      ${data.total ? pager({ page: data.page, pages: data.pages, total: data.total, size: data.size }) : ''}
    </div>`;

  view.querySelectorAll('[data-ch]').forEach((b) => {
    b.onclick = () => ctx.navigate(b.dataset.ch ? `/payments?channel=${b.dataset.ch}` : '/payments');
  });
  bindPager(view, (page) => {
    const u = new URLSearchParams(location.hash.split('?')[1] || '');
    u.set('page', page); ctx.navigate(`/payments?${u}`);
  });
  bindRowClick(view, data.items, async (r) => {
    const { payment } = await get(`/api/payments/${r.id}`);
    openModal({
      title: `支付单 ${payment.pay_no}`,
      subtitle: `${payment.channel_name} · ${fmt.dt(payment.paid_at)}`,
      body: `
        <div class="row between mb-16">
          <div><div class="small muted">支付金额</div><div style="font-size:26px;font-weight:650">¥${fmt.money(payment.amount)}</div></div>
          <div style="text-align:right"><div class="small muted">用户</div><b>${esc(payment.customer_name)}</b>
            <div class="small muted mono">${payment.account_no}</div></div>
        </div>
        <h4 style="font-size:13px;margin-bottom:8px">核销明细</h4>
        <div class="table-wrap" style="border:1px solid var(--line);border-radius:10px">
          <table class="tbl"><thead><tr><th>账单号</th><th>账期</th><th class="num">账单金额</th><th class="num">本单核销</th></tr></thead>
          <tbody>${payment.allocations.map((a) => `<tr>
            <td class="mono small">${a.bill_no}</td><td class="mono">${a.period}</td>
            <td class="num">¥${fmt.money(a.total_amount)}</td><td class="num">¥${fmt.money(a.amount)}</td></tr>`).join('')}</tbody></table>
        </div>
        <div class="divider"></div>
        <dl class="dl"><dt>支付渠道</dt><dd>${esc(payment.channel_name)}</dd>
          <dt>网关流水</dt><dd class="mono small">${esc(payment.gateway_txn || '—')}</dd>
          <dt>幂等键</dt><dd class="mono small">${esc(payment.idempotency_key || '—')}</dd>
          <dt>地址</dt><dd>${esc(payment.address || '')}</dd></dl>`,
      footer: `<button class="btn" data-close-modal>关闭</button>`,
    });
  });
}
