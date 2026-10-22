import {
  get, post, put, fmt, icon, p, esc, table, bindRowClick, pager, bindPager,
  openModal, openDrawer, confirmDialog, field, formGrid, formData, toast, state,
} from '../core.js';

const PAGE_SIZE = 12;

export default async function render(view, ctx) {
  const qs = new URLSearchParams();
  const q = { page: 1, ...ctx.query };
  if (q.q) qs.set('q', q.q);
  if (q.status) qs.set('status', q.status);
  if (q.area) qs.set('area', q.area);
  if (q.property) qs.set('property', q.property);
  if (q.arrears) qs.set('arrears', q.arrears);
  qs.set('page', q.page);
  qs.set('size', PAGE_SIZE);

  const data = await get(`/api/accounts?${qs}`);
  const areas = ctx.meta?.areas || [];

  view.innerHTML = `
    <div class="page-head">
      <div><h1>用户档案</h1><p>共 ${data.total} 户 · 户号由国家分配，作为缴费与档案的唯一标识</p></div>
      <div class="page-actions">
        <button class="btn" id="btnImport">${icon('up')}批量导入</button>
        <button class="btn primary" id="btnCreate">${icon('plus')}新增用户</button>
      </div>
    </div>

    <div class="toolbar">
      <div class="search">${icon('search')}<input class="input" id="fq" placeholder="户号 / 姓名 / 户主 / 手机 / 地址" value="${esc(q.q || '')}"/></div>
      <select class="select" id="fstatus">
        <option value="">全部状态</option>
        ${['active', 'suspended', 'closed'].map((s) => `<option value="${s}" ${q.status === s ? 'selected' : ''}>${{ active: '正常', suspended: '暂停', closed: '销户' }[s]}</option>`).join('')}
      </select>
      <select class="select" id="farea">
        <option value="">全部供电所</option>
        ${areas.map((a) => `<option value="${a.id}" ${String(q.area) === String(a.id) ? 'selected' : ''}>${a.name}</option>`).join('')}
      </select>
      <select class="select" id="fprop">
        <option value="">全部用电性质</option>
        ${['居民', '商业', '农业'].map((s) => `<option value="${s}" ${q.property === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
      <button class="btn ${q.arrears ? 'primary' : ''}" id="farr">${icon('alert')}仅看欠费</button>
      <div class="spacer"></div>
      <a class="btn ghost" href="/api/export/bills">${icon('down')}导出账单</a>
    </div>

    <div class="card">
      ${table({
        columns: [
          { label: '户号', render: (r) => `<span class="strong mono">${r.account_no}</span>` },
          { label: '用户 / 户主', render: (r) => `<div class="strong">${esc(r.customer_name)}</div>
              <div class="small muted">户主：${esc(r.owner_name || '—')}${r.relation && r.relation !== '本人' ? ` · ${r.relation}` : ''}</div>` },
          { label: '联系方式', render: (r) => `<span class="mono">${esc(r.phone || '—')}</span>` },
          { label: '地址', render: (r) => `<div style="max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.address || '—')}</div>` },
          { label: '性质', render: (r) => `<span class="tag">${r.property_type}</span>` },
          { label: '电表', render: (r) => `<div class="mono small">${esc(r.asset_no || '未装表')}</div><div>${p.device(r.device_status)}</div>` },
          { label: '最近账期', render: (r) => r.last_period
            ? `<div class="mono">${fmt.period(r.last_period)}</div><div>${p.bill(r.last_status)} <span class="muted small">¥${fmt.money(r.last_amount)}</span></div>`
            : '<span class="muted">—</span>' },
          { label: '欠费', align: 'right', render: (r) => Number(r.outstanding) > 0
            ? `<b style="color:var(--danger)">¥${fmt.money(r.outstanding)}</b>` : '<span class="muted">0.00</span>' },
          { label: '状态', render: (r) => p.account(r.status) },
        ],
        rows: data.items,
        empty: '没有符合条件的用户',
      })}
      ${data.total ? pager({ page: data.page, pages: data.pages, total: data.total, size: data.size }) : ''}
    </div>`;

  bindPager(view, (page) => {
    const u = new URLSearchParams(location.hash.split('?')[1] || '');
    u.set('page', page);
    ctx.navigate(`/accounts?${u.toString()}`);
  });

  bindRowClick(view, data.items, (row) => openDetail(row.id, ctx));

  const apply = (patch) => {
    const u = new URLSearchParams();
    const next = { q: q.q || '', status: q.status || '', area: q.area || '', property: q.property || '', arrears: q.arrears || '', ...patch };
    Object.entries(next).forEach(([k, v]) => { if (v) u.set(k, v); });
    ctx.navigate(`/accounts?${u.toString()}`);
  };
  view.querySelector('#fq').addEventListener('keydown', (e) => { if (e.key === 'Enter') apply({ q: e.target.value }); });
  view.querySelector('#fstatus').onchange = (e) => apply({ status: e.target.value });
  view.querySelector('#farea').onchange = (e) => apply({ area: e.target.value });
  view.querySelector('#fprop').onchange = (e) => apply({ property: e.target.value });
  view.querySelector('#farr').onclick = () => apply({ arrears: q.arrears ? '' : '1' });
  view.querySelector('#btnCreate').onclick = () => openCreate(ctx);
  view.querySelector('#btnImport').onclick = () => openImport(ctx);

  if (ctx.query.id) openDetail(Number(ctx.query.id), ctx);
}

/* ------------------------------------------------------------------ */
/* 详情抽屉                                                            */
/* ------------------------------------------------------------------ */

export async function openDetail(id, ctx) {
  const data = await get(`/api/accounts/${id}`);
  const a = data.account;
  const drawer = openDrawer({
    title: `${esc(a.customer_name)} <span class="mono" style="font-size:12px;color:var(--muted);font-weight:400">${a.account_no}</span>`,
    subtitle: `${esc(a.address || '')} · ${a.property_type} · ${esc(a.area_name || '')}`,
    headExtra: `<div class="row wrap gap-8 mt-12">
        ${p.account(a.status)}
        ${p.device(a.device_status)}
        ${Number(a.outstanding) > 0 ? `<span class="pill danger">欠费 ¥${fmt.money(a.outstanding)}</span>` : '<span class="pill ok">无欠费</span>'}
        <span class="tag">${esc(a.phone || '')}</span>
        <span class="spacer f1"></span>
        <button class="btn sm" data-edit>${icon('edit')}编辑档案</button>
      </div>
      <div class="tabs" data-tabs>
        ${[['profile', '档案信息'], ['meter', '计量与设备'], ['bills', '账单记录'], ['reads', '抄表记录'], ['repl', '换表记录']]
          .map(([k, l], i) => `<button class="tab ${i === 0 ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}
      </div>`,
    body: `<div data-panel="profile">${profilePanel(a, data)}</div>
           <div data-panel="meter" hidden>${meterPanel(data)}</div>
           <div data-panel="bills" hidden>${billsPanel(data)}</div>
           <div data-panel="reads" hidden>${readsPanel(data)}</div>
           <div data-panel="repl" hidden>${replPanel(data)}</div>`,
    onMount(root) {
      root.querySelectorAll('[data-tab]').forEach((t) => {
        t.onclick = () => {
          root.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === t));
          root.querySelectorAll('[data-panel]').forEach((pn) => { pn.hidden = pn.dataset.panel !== t.dataset.tab; });
        };
      });
      root.querySelector('[data-edit]').onclick = () => openEdit(a, ctx, () => { drawer.close(); openDetail(id, ctx); });
      root.querySelectorAll('[data-bill]').forEach((el) => el.addEventListener('click', async (e) => {
        e.stopPropagation();
        const { bill } = await get(`/api/bills/${el.dataset.bill}`);
        openBillModal(bill);
      }));
      root.querySelectorAll('[data-point]').forEach(() => {});
    },
  });
  return drawer;
}

function profilePanel(a, data) {
  const rows = [
    ['户号', `<b class="mono">${a.account_no}</b>`],
    ['用户姓名', esc(a.customer_name)],
    ['户主', `${esc(a.owner_name || '—')} ${a.relation ? `<span class="tag">${a.relation}</span>` : ''}`],
    ['证件', `${a.id_type || '身份证'} ${maskId(a.id_no)}`],
    ['联系方式', `${esc(a.phone || '—')}${a.phone_alt ? ` / ${esc(a.phone_alt)}` : ''}`],
    ['供电所 / 小区', `${esc(a.area_name || '—')} · ${esc(a.community_name || '—')}`],
    ['家庭地址', esc(a.address || '—')],
    ['用电性质', `${a.property_type} · 合同容量 ${a.contract_capacity || '—'} kW`],
    ['开户日期', fmt.date(a.open_date)],
    ['缴费方式', `${a.payment_method === 'bank' ? '银行代扣' : a.payment_method === 'alipay' ? '支付宝' : '微信'}${a.auto_debit ? ' · 已签约自动扣费' : ''}`],
    ['信用等级', `<span class="pill ${a.credit_level === 'A' ? 'ok' : a.credit_level === 'C' ? 'warn' : 'info'}">${a.credit_level || '—'}</span>`],
    ['备注', esc(a.remark || '—')],
  ];
  return `<dl class="dl" style="grid-template-columns:110px 1fr">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    <div class="divider"></div>
    <div class="notice ok">${icon('check')}<div>档案与计量点、设备分离维护：更换电表不会影响户号、账单和历史用电数据。</div></div>`;
}

function maskId(v) {
  if (!v) return '—';
  return String(v).replace(/^(.{4}).*(.{3})$/, '$1***********$2');
}

function meterPanel(data) {
  const segs = data.segments || [];
  const points = data.points || [];
  if (!segs.length) return '<div class="empty">尚未安装电表</div>';
  return points.map((pt) => {
    const list = segs.filter((s) => s.point_id === pt.id);
    return `<div class="card" style="box-shadow:none;margin-bottom:14px">
      <div class="card-head"><div><h3>${esc(pt.name || '计量点')}</h3>
        <div class="sub mono">${pt.point_no} · ${esc(pt.location || '')}</div></div>
        <span class="pill ${pt.status === 'active' ? 'ok' : 'gray'}">${list.length} 段安装记录</span></div>
      <div class="card-body">
        <div class="timeline">
          ${list.slice().reverse().map((s) => `
            <div class="tl-item ${s.status === 'active' ? '' : 'gray'}">
              <b>${s.status === 'active' ? '在运' : '已拆除'} · ${esc(s.asset_no)}</b>
              <span>${esc(s.vendor || '')} ${esc(s.model || '')} · 倍率 ${s.ratio} · ${esc(s.phase || '')}</span>
              <div class="row wrap gap-8 small" style="margin-top:6px">
                <span class="tag">安装 ${fmt.date(s.start_date)}</span>
                <span class="tag">起码 ${fmt.kwh(s.start_reading)}</span>
                ${s.end_date ? `<span class="tag">拆除 ${fmt.date(s.end_date)}</span><span class="tag">止码 ${fmt.kwh(s.end_reading)}</span>` : ''}
                ${s.work_order_no ? `<span class="tag">${s.work_order_no}</span>` : ''}
                <span class="tag">IMEI ${esc(s.imei || '—')}</span>
              </div>
            </div>`).join('')}
        </div>
        ${list.length > 1 ? `<div class="notice warn">${icon('alert')}<div><b>跨段不计电量：</b>换表时旧表止码与新表起码之间不做差值，只累计各段内部增量，因此换表不会产生虚增电量。</div></div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function billsPanel(data) {
  if (!data.bills?.length) return '<div class="empty">暂无账单</div>';
  return `<div class="table-wrap"><table class="tbl">
    <thead><tr><th>账期</th><th class="num">用电量</th><th class="num">应收</th><th class="num">实收</th><th>状态</th><th>到期日</th><th></th></tr></thead>
    <tbody>${data.bills.map((b) => `<tr>
      <td class="mono">${b.period}</td>
      <td class="num">${fmt.kwh(b.usage_kwh)}</td>
      <td class="num">¥${fmt.money(b.total_amount)}</td>
      <td class="num">¥${fmt.money(b.paid_amount)}</td>
      <td>${p.bill(b.status)}</td>
      <td class="mono small">${fmt.date(b.due_date)}</td>
      <td class="right"><button class="btn link sm" data-bill="${b.id}">明细</button></td>
    </tr>`).join('')}</tbody></table></div>`;
}

function readsPanel(data) {
  if (!data.readings?.length) return '<div class="empty">暂无抄表数据</div>';
  return `<div class="table-wrap"><table class="tbl">
    <thead><tr><th>时间</th><th class="num">示数</th><th>来源</th><th>质量</th><th>表号</th><th>备注</th></tr></thead>
    <tbody>${data.readings.map((r) => `<tr>
      <td class="mono small">${fmt.dt(r.read_at)}</td>
      <td class="num"><b>${fmt.kwh(r.reading)}</b></td>
      <td>${p.source(r.source)}</td>
      <td>${p.quality(r.quality)}</td>
      <td class="mono small">${esc(r.asset_no || '')}</td>
      <td class="small muted">${esc(r.note || '')}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

function replPanel(data) {
  if (!data.replacements?.length) return '<div class="empty">该户无换表记录</div>';
  return `<div class="timeline">${data.replacements.map((r) => `
    <div class="tl-item ${r.status === 'completed' ? '' : 'gray'}">
      <b>${r.order_no} · ${p.reason(r.reason)}</b>
      <span>${p.work(r.status)} ${r.done_at ? `· 完工 ${fmt.date(r.done_at)}` : ''}</span>
      <div class="small muted" style="margin-top:4px">${esc(r.symptom || '')}</div>
      ${r.old_final_reading !== null ? `<div class="row wrap gap-8 small" style="margin-top:6px">
        <span class="tag">拆表止码 ${fmt.kwh(r.old_final_reading)}</span>
        <span class="tag">装表起码 ${fmt.kwh(r.new_start_reading)}</span>
        <span class="tag">${r.solution === 'replace_module' ? '仅换模块' : '整表更换'}</span></div>` : ''}
    </div>`).join('')}</div>`;
}

const CHANNEL_ZH = { wechat: '微信支付', alipay: '支付宝', bank: '银行代扣', cash: '营业厅现金', mock: '模拟网关' };

export function openBillModal(bill) {
  const calc = bill.calc || {};
  openModal({
    title: `账单 ${bill.bill_no}`,
    subtitle: `${bill.period} 账期 · ${esc(bill.customer_name)} ${bill.account_no}`,
    size: 'wide',
    body: `
      <div class="grid g-3" style="gap:12px;margin-bottom:16px">
        <div class="card" style="box-shadow:none"><div class="card-body" style="padding:14px">
          <div class="small muted">用电量</div><div style="font-size:20px;font-weight:650">${fmt.kwh(bill.usage_kwh)} <span class="small muted">kWh</span></div>
        </div></div>
        <div class="card" style="box-shadow:none"><div class="card-body" style="padding:14px">
          <div class="small muted">应收金额</div><div style="font-size:20px;font-weight:650">¥${fmt.money(bill.total_amount)}</div>
        </div></div>
        <div class="card" style="box-shadow:none"><div class="card-body" style="padding:14px">
          <div class="small muted">待缴 / 状态</div><div style="font-size:20px;font-weight:650">¥${fmt.money(bill.outstanding)} ${p.bill(bill.status)}</div>
        </div></div>
      </div>

      <h4 style="font-size:13px;margin-bottom:8px">计费明细</h4>
      <div class="table-wrap" style="border:1px solid var(--line);border-radius:10px">
        <table class="tbl">
          <thead><tr><th>项目</th><th>计算方式</th><th class="num">金额</th></tr></thead>
          <tbody>
            ${(calc.tiers || []).map((t, i) => `<tr>
              <td>电度电费${(calc.tiers || []).length > 1 ? `（第 ${i + 1} 档）` : ''}</td>
              <td class="small muted">${t.kwh} kWh × ¥${t.price}</td>
              <td class="num">¥${fmt.money(t.amount)}</td></tr>`).join('')}
            ${calc.baseFee ? `<tr><td>基本电费</td><td class="small muted">固定</td><td class="num">¥${fmt.money(calc.baseFee)}</td></tr>` : ''}
            ${Number(bill.adjustment) ? `<tr><td>调整项</td><td class="small muted">追补 / 退补</td><td class="num">¥${fmt.money(bill.adjustment)}</td></tr>` : ''}
            <tr><td class="strong">合计</td><td class="small muted">${esc(calc.tariff || '')}${calc.estimatedDays ? ` · 含 ${calc.estimatedDays} 条估抄记录` : ''}</td>
              <td class="num strong">¥${fmt.money(bill.total_amount)}</td></tr>
          </tbody>
        </table>
      </div>

      ${bill.adjustments?.length ? `<h4 style="font-size:13px;margin:16px 0 8px">并入本单的调整项</h4>
        ${bill.adjustments.map((a) => `<div class="row between small" style="padding:6px 0;border-bottom:1px dashed var(--line-2)">
          <span>${esc(a.reason || a.type)}</span><b>¥${fmt.money(a.amount)}</b></div>`).join('')}` : ''}

      <h4 style="font-size:13px;margin:16px 0 8px">缴费记录</h4>
      ${bill.allocations?.length ? bill.allocations.map((x) => `<div class="row between small" style="padding:6px 0;border-bottom:1px dashed var(--line-2)">
        <span class="mono">${x.pay_no}</span><span>${esc(CHANNEL_ZH[x.channel] || x.channel)}</span><span class="muted">${fmt.dt(x.paid_at)}</span><b>¥${fmt.money(x.amount)}</b></div>`).join('')
        : '<div class="small muted">暂无缴费记录</div>'}
    `,
    footer: `<button class="btn" data-close-modal>关闭</button>`,
  });
}

/* ------------------------------------------------------------------ */
/* 新增 / 编辑                                                         */
/* ------------------------------------------------------------------ */

async function openCreate(ctx) {
  const meta = await get('/api/meta');
  let stock = { items: [] };
  try { stock = await get('/api/devices?status=in_stock&size=100'); } catch { /* ignore */ }

  const m = openModal({
    title: '新增用户档案',
    subtitle: '户号可按国家编码规则自动生成，也可手工填写',
    size: 'wide',
    body: formGrid(`
      ${field({ label: '户号', name: 'accountNo', placeholder: '留空则自动生成', hint: '国家分配的户号，缴费与对账的唯一标识' })}
      ${field({ label: '用户姓名', name: 'customerName', required: true })}
      ${field({ label: '户主', name: 'ownerName', placeholder: '默认与用户姓名相同' })}
      ${field({ label: '与户主关系', name: 'relation', type: 'select', options: ['本人', '亲属', '租户', '其他'].map((v) => ({ value: v, label: v })) })}
      ${field({ label: '联系方式', name: 'phone', required: true, placeholder: '11 位手机号' })}
      ${field({ label: '备用电话', name: 'phoneAlt' })}
      ${field({ label: '供电所', name: 'areaId', type: 'select', options: meta.areas.map((a) => ({ value: a.id, label: a.name })) })}
      ${field({ label: '小区', name: 'communityId', type: 'select', options: [{ value: '', label: '不指定' }, ...meta.communities.map((c) => ({ value: c.id, label: c.name }))] })}
      ${field({ label: '楼栋', name: 'building', placeholder: '第 1 栋' })}
      ${field({ label: '单元', name: 'unit', placeholder: '1 单元' })}
      ${field({ label: '房号', name: 'room', placeholder: '101' })}
      ${field({ label: '用电性质', name: 'propertyType', type: 'select', options: ['居民', '商业', '农业'].map((v) => ({ value: v, label: v })) })}
      ${field({ label: '开户日期', name: 'openDate', type: 'date', value: meta.today })}
      ${field({ label: '合同容量 (kW)', name: 'contractCapacity', type: 'number', placeholder: '8' })}
      ${field({ label: '绑定电表', name: 'assetNo', type: 'select', options: [{ value: '', label: '暂不绑定（仅建档）' }, ...stock.items.map((d) => ({ value: d.asset_no, label: `${d.asset_no} · ${d.vendor || ''} ${d.model || ''}` }))] })}
      ${field({ label: '装表起码', name: 'startReading', type: 'number', placeholder: '0' })}
      ${field({ label: '详细地址', name: 'address', span: 2, placeholder: '用于现场核对与缴费展示，留空则按小区+楼栋拼接' })}
      ${field({ label: '备注', name: 'remark', type: 'textarea', span: 2 })}
    `, 2),
    footer: `<button class="btn" data-close-modal>取消</button><button class="btn primary" data-submit>创建档案</button>`,
    onMount(root, close) {
      root.querySelector('[data-submit]').onclick = async () => {
        const body = formData(root);
        try {
          const res = await post('/api/accounts', body);
          toast(`已创建用户 ${res.accountNo}`);
          close();
          ctx.refresh();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
  return m;
}

function openEdit(a, ctx, done) {
  const m = openModal({
    title: '编辑档案',
    subtitle: `${a.account_no} · ${a.customer_name}`,
    size: 'wide',
    body: formGrid(`
      ${field({ label: '用户姓名', name: 'customerName', value: a.customer_name, required: true })}
      ${field({ label: '户主', name: 'ownerName', value: a.owner_name })}
      ${field({ label: '与户主关系', name: 'relation', type: 'select', value: a.relation, options: ['本人', '亲属', '租户', '其他'].map((v) => ({ value: v, label: v })) })}
      ${field({ label: '联系方式', name: 'phone', value: a.phone })}
      ${field({ label: '备用电话', name: 'phoneAlt', value: a.phone_alt })}
      ${field({ label: '家庭地址', name: 'address', value: a.address, span: 2 })}
      ${field({ label: '用电性质', name: 'propertyType', type: 'select', value: a.property_type, options: ['居民', '商业', '农业'].map((v) => ({ value: v, label: v })) })}
      ${field({ label: '合同容量 (kW)', name: 'contractCapacity', type: 'number', value: a.contract_capacity })}
      ${field({ label: '信用等级', name: 'creditLevel', type: 'select', value: a.credit_level, options: ['A', 'B', 'C'].map((v) => ({ value: v, label: v })) })}
      ${field({ label: '户状态', name: 'status', type: 'select', value: a.status, options: [{ value: 'active', label: '正常' }, { value: 'suspended', label: '暂停' }, { value: 'closed', label: '销户' }] })}
      ${field({ label: '备注', name: 'remark', type: 'textarea', value: a.remark, span: 2 })}
    `),
    footer: `<button class="btn" data-close-modal>取消</button><button class="btn primary" data-submit>保存</button>`,
    onMount(root, close) {
      root.querySelector('[data-submit]').onclick = async () => {
        try {
          await put(`/api/accounts/${a.id}`, formData(root));
          toast('档案已更新');
          close();
          done();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
  return m;
}

/* ------------------------------------------------------------------ */
/* 批量导入                                                            */
/* ------------------------------------------------------------------ */

function openImport(ctx) {
  const m = openModal({
    title: '批量导入用户',
    subtitle: '支持 CSV / TSV，首行为表头；导入前会逐行校验',
    size: 'xwide',
    body: `
      <div class="notice">${icon('check')}<div>必填列：<b>用户姓名、联系方式</b>。可选：户号（留空自动生成）、户主、小区、楼栋、单元、房号、用电性质、表号、开户日期。
      表号必须已存在于设备库且未在运。</div></div>
      <div class="row gap-8 mt-12">
        <a class="btn sm" href="/api/accounts/import/template">${icon('down')}下载模板</a>
        <button class="btn sm" id="fillSample">填入示例</button>
        <span class="small muted">支持从 Excel 直接复制粘贴</span>
      </div>
      <textarea class="textarea" id="csvText" style="margin-top:12px;min-height:130px;font-family:ui-monospace,Menlo,monospace;font-size:12px"
        placeholder="户号,用户姓名,户主,联系方式,小区,楼栋,单元,房号,用电性质,表号,开户日期"></textarea>
      <div class="dropzone mt-12" id="dropzone">${icon('up')} 点击选择 .csv 文件，或拖拽到此处</div>
      <input type="file" id="fileInput" accept=".csv,text/csv" hidden />
      <div id="previewArea" class="mt-16"></div>`,
    footer: `<button class="btn" data-close-modal>取消</button>
             <button class="btn" id="btnPreview">解析预览</button>
             <button class="btn primary" id="btnCommit" disabled>确认导入</button>`,
    onMount(root, close) {
      const ta = root.querySelector('#csvText');
      const area = root.querySelector('#previewArea');
      const commitBtn = root.querySelector('#btnCommit');
      let parsed = null;

      root.querySelector('#fillSample').onclick = () => {
        ta.value = `户号,用户姓名,户主,联系方式,小区,楼栋,单元,房号,用电性质,表号,开户日期\n,陈演示,陈演示,13700001111,锦绣家园,第 9 栋,2 单元,902,居民,,2026-10-01\n,林样例,林样例,13700002222,阳光新城,第 3 栋,1 单元,501,居民,,2026-10-01`;
      };
      const dz = root.querySelector('#dropzone');
      const fi = root.querySelector('#fileInput');
      dz.onclick = () => fi.click();
      dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
      dz.ondragleave = () => dz.classList.remove('over');
      dz.ondrop = (e) => {
        e.preventDefault(); dz.classList.remove('over');
        const f = e.dataTransfer.files[0];
        if (f) readFile(f);
      };
      fi.onchange = () => { if (fi.files[0]) readFile(fi.files[0]); };
      function readFile(f) {
        const rd = new FileReader();
        rd.onload = () => { ta.value = rd.result; toast(`已读取 ${f.name}`); };
        rd.readAsText(f, 'utf-8');
      }

      root.querySelector('#btnPreview').onclick = async () => {
        if (!ta.value.trim()) return toast('请先粘贴或上传数据', 'err');
        try {
          area.innerHTML = '<div class="empty">解析中…</div>';
          parsed = await post('/api/accounts/import/preview', { csv: ta.value });
          area.innerHTML = `
            <div class="row between mb-8">
              <b style="font-size:13px">解析结果</b>
              <div class="row gap-8 small">
                <span class="pill ok">可导入 ${parsed.valid}</span>
                <span class="pill danger">有问题 ${parsed.invalid}</span>
              </div>
            </div>
            <div class="table-wrap" style="border:1px solid var(--line);border-radius:10px;max-height:320px;overflow:auto">
              <table class="tbl"><thead><tr><th>行</th><th>户号</th><th>姓名</th><th>电话</th><th>地址</th><th>校验</th></tr></thead>
              <tbody>${parsed.rows.map((r) => `<tr>
                <td class="mono small">${r.line}</td>
                <td class="mono small">${esc(r.accountNo || '自动')}</td>
                <td>${esc(r.customerName)}</td>
                <td class="mono small">${esc(r.phone)}</td>
                <td class="small">${esc([r.communityName, r.building, r.unit, r.room].filter(Boolean).join(' ') || r.address || '—')}</td>
                <td>${r.errors.length ? `<span class="pill danger">${r.errors.map(esc).join('；')}</span>` : r.warnings.length ? `<span class="pill warn">${r.warnings.map(esc).join('；')}</span>` : '<span class="pill ok">通过</span>'}</td>
              </tr>`).join('')}</tbody></table>
            </div>`;
          commitBtn.disabled = parsed.valid === 0;
        } catch (e) {
          area.innerHTML = '';
          toast(e.message, 'err');
        }
      };

      commitBtn.onclick = async () => {
        if (!parsed) return;
        commitBtn.disabled = true;
        try {
          const rows = parsed.rows.filter((r) => r._ok);
          const res = await post('/api/accounts/import/commit', { rows });
          toast(`成功导入 ${res.created} 户`);
          close();
          ctx.refresh();
        } catch (e) { toast(e.message, 'err'); commitBtn.disabled = false; }
      };
    },
  });
  return m;
}
