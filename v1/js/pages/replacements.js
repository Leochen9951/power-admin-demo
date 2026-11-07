import {
  get, post, fmt, icon, p, esc, table, openModal, field, formGrid,
  formData, toast, notice, confirmDialog,
} from '../core.js';

const TABS = [
  ['', '全部'], ['reported', '待派单'], ['processing', '处理中'], ['completed', '已完成'],
];

export default async function render(view, ctx) {
  const status = ctx.query.status || '';
  const data = await get(`/api/replacements${status ? `?status=${status}` : ''}`);
  const counts = { reported: 0, processing: 0, completed: 0 };
  data.items.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });

  view.innerHTML = `
    <div class="page-head">
      <div><h1>换表工单</h1><p>表计故障或通信模块损坏 → 报修 → 审核 → 完工，全程留痕</p></div>
      <div class="page-actions"><button class="btn primary" id="btnNew">${icon('plus')}新建报修</button></div>
    </div>

    <div class="notice mb-16">${icon('alert')}<div>
      <b>换表不会中断计费：</b>完工时登记「拆表止码 + 装表起码」，系统关闭旧安装段、开启新安装段。
      两段之间不参与差值计算，换表当月的电量由两段各自累计后合并出账。
    </div></div>

    <div class="tabs">
      ${TABS.map(([v, l]) => `<button class="tab ${status === v ? 'active' : ''}" data-st="${v}">${l}${v && counts[v] ? ` (${counts[v]})` : ''}</button>`).join('')}
    </div>

    <div class="card">
      ${table({
        columns: [
          { label: '工单号', render: (r) => `<b class="mono">${r.order_no}</b><div class="small muted">${fmt.date(r.reported_at)} 报修</div>` },
          { label: '用户', render: (r) => `<div class="strong">${esc(r.customer_name)}</div><div class="small muted mono">${r.account_no}</div>` },
          { label: '故障', render: (r) => `<div>${esc(r.fault_type || p.reason(r.reason))}</div><div class="small muted" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.symptom || '')}</div>` },
          { label: '处理方案', render: (r) => `<span class="tag">${r.solution === 'replace_module' ? '仅换模块' : '整表更换'}</span>` },
          { label: '表计', render: (r) => `<div class="small mono">旧 ${esc(r.old_asset_no || '—')}</div>${r.new_asset_no ? `<div class="small mono">新 ${esc(r.new_asset_no)}</div>` : ''}` },
          { label: '止码 → 起码', render: (r) => r.old_final_reading !== null && r.old_final_reading !== undefined
            ? `<span class="mono small">${fmt.kwh(r.old_final_reading)} → ${fmt.kwh(r.new_start_reading)}</span>` : '<span class="muted small">待登记</span>' },
          { label: '状态', render: (r) => p.work(r.status) },
          { label: '操作', render: (r) => actions(r) },
        ],
        rows: data.items,
        empty: '暂无工单',
      })}
    </div>`;

  view.querySelectorAll('[data-st]').forEach((b) => {
    b.onclick = () => ctx.navigate(b.dataset.st ? `/replacements?status=${b.dataset.st}` : '/replacements');
  });
  view.querySelector('#btnNew').onclick = () => openCreate(ctx);

  view.querySelectorAll('[data-act]').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const row = data.items.find((x) => String(x.id) === btn.dataset.id);
      if (btn.dataset.act === 'review') await review(row, ctx);
      if (btn.dataset.act === 'complete') await complete(row, ctx);
    };
  });
}

function actions(r) {
  if (r.status === 'reported') {
    return `<div class="row gap-4"><button class="btn sm primary" data-act="review" data-id="${r.id}">审核派单</button>
      <button class="btn sm" data-act="complete" data-id="${r.id}">直接完工</button></div>`;
  }
  if (r.status === 'processing') {
    return `<button class="btn sm primary" data-act="complete" data-id="${r.id}">登记完工</button>`;
  }
  return `<span class="small muted">${fmt.date(r.done_at)}</span>`;
}

async function review(r, ctx) {
  const ok = await confirmDialog('审核换表工单',
    `工单 <b>${r.order_no}</b>（${esc(r.customer_name)}）审核通过后进入处理中，由运维人员上门处理。`, { okText: '审核通过' });
  if (!ok) return;
  try {
    await post(`/api/replacements/${r.id}/review`, { decision: 'approve' });
    toast('已审核通过，工单进入处理中');
    ctx.refresh();
  } catch (e) { toast(e.message, 'err'); }
}

async function complete(r, ctx) {
  const acc = await get(`/api/accounts/${r.account_id}`);
  const lastRead = acc.readings.find((x) => x.segment_id === r.old_segment_id) || acc.readings[0];
  const defaultFinal = lastRead ? lastRead.reading : 0;
  let stock = { items: [] };
  try { stock = await get('/api/devices?status=in_stock&size=100'); } catch { /* ignore */ }

  const isModule = r.solution === 'replace_module';
  openModal({
    title: isModule ? '登记模块更换完工' : '登记换表完工',
    subtitle: `${r.order_no} · ${esc(r.customer_name)} · ${r.account_no}`,
    size: 'wide',
    body: `
      ${notice(isModule
        ? '<b>仅更换通信模块：</b>表体与安装段保持不变，历史读数连续。断档期间的读数请先通过「抄表数据 → 人工补录」补齐，电量不受影响。'
        : '<b>整表更换：</b>系统将以「拆表止码」关闭旧段、以「装表起码」开启新段。两段之间的差额不计入电量，因此不会虚增用量。',
        isModule ? 'ok' : 'warn')}
      <div class="mt-16">
      ${formGrid(`
        ${field({ label: '完工日期', name: 'doneAt', type: 'date', value: fmt.date(new Date().toISOString()) })}
        ${isModule
          ? field({ label: '新模块编号', name: 'moduleNo', placeholder: 'MOD000000', required: true })
          : field({ label: '新表资产编号', name: 'newAssetNo', type: 'select',
              options: [{ value: '', label: '自动创建新资产' }, ...stock.items.map((d) => ({ value: d.asset_no, label: `${d.asset_no} · ${d.vendor || ''} ${d.model || ''}` }))],
              hint: '可先在电表管理新增资产，再从这里选择' })}
        ${isModule ? '' : field({ label: '拆表止码', name: 'oldFinalReading', type: 'number', value: String(defaultFinal), required: true,
            hint: `最后一次远程读数 ${fmt.kwh(defaultFinal)}，现场核对后可修正` })}
        ${isModule ? '' : field({ label: '装表起码', name: 'newStartReading', type: 'number', value: '0', hint: '新表通常为 0，按现场实际填写' })}
        ${isModule ? '' : field({ label: '止码来源', name: 'oldFinalSource', type: 'select', options: [{ value: 'manual', label: '现场人工抄见' }, { value: 'iot', label: '远程最后一次读数' }, { value: 'estimated', label: '按日均估算' }] })}
        ${field({ label: '完工备注', name: 'remark', type: 'textarea', span: 2, placeholder: '旧表去向、现场情况等' })}
      `, 2)}
      </div>`,
    footer: `<button class="btn" data-close-modal>取消</button><button class="btn primary" data-submit>确认完工</button>`,
    onMount(root, close) {
      root.querySelector('[data-submit]').onclick = async () => {
        const body = formData(root);
        if (!body.doneAt) return toast('请填写完工日期', 'err');
        if (!isModule && !body.oldFinalReading) return toast('请填写拆表止码', 'err');
        try {
          await post(`/api/replacements/${r.id}/complete`, body);
          toast('换表完工，新安装段已生效');
          close();
          ctx.refresh();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

function openCreate(ctx, row) {
  if (row) return;
  openModal({
    title: '新建报修工单',
    subtitle: '物联网设备上报故障，或由抄表员现场发现',
    size: 'wide',
    body: formGrid(`
      ${field({ label: '户号', name: 'accountNo', required: true, placeholder: '340102000001' })}
      ${field({ label: '处理方案', name: 'solution', type: 'select', options: [
        { value: 'replace_meter', label: '整表更换（表计损坏）' },
        { value: 'replace_module', label: '仅更换通信模块（模块损坏）' },
      ] })}
      ${field({ label: '故障类型', name: 'faultType', placeholder: '表计故障 / 通信模块故障' })}
      ${field({ label: '计划上门日期', name: 'plannedAt', type: 'date' })}
      ${field({ label: '故障现象', name: 'symptom', type: 'textarea', span: 2, placeholder: '如：连续 14 天无心跳，现场表计走字正常' })}
      ${field({ label: '备注', name: 'remark', type: 'textarea', span: 2 })}
    `),
    footer: `<button class="btn" data-close-modal>取消</button><button class="btn primary" data-submit>创建工单</button>`,
    onMount(root, close) {
      root.querySelector('[data-submit]').onclick = async () => {
        const body = formData(root);
        if (!body.accountNo) return toast('请填写户号', 'err');
        try {
          const res = await post('/api/replacements', body);
          toast(`工单 ${res.orderNo} 已创建`);
          close(); ctx.refresh();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}
