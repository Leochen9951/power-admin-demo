import {
  get, post, fmt, icon, p, esc, table, bindRowClick, pager, bindPager,
  openModal, field, formGrid, formData, toast,
} from '../core.js';

const PAGE_SIZE = 12;

export default async function render(view, ctx) {
  const q = { page: 1, ...ctx.query };
  const qs = new URLSearchParams();
  if (q.q) qs.set('q', q.q);
  if (q.status) qs.set('status', q.status);
  qs.set('page', q.page); qs.set('size', PAGE_SIZE);
  const data = await get(`/api/devices?${qs}`);

  view.innerHTML = `
    <div class="page-head">
      <div><h1>电表管理</h1><p>共 ${data.total} 台 · 设备资产与户号解耦，换表只影响安装段</p></div>
      <div class="page-actions"><button class="btn primary" id="btnNew">${icon('plus')}新增电表</button></div>
    </div>
    <div class="toolbar">
      <div class="search">${icon('search')}<input class="input" id="fq" placeholder="资产编号 / IMEI / 型号" value="${esc(q.q || '')}"/></div>
      <select class="select" id="fstatus">
        <option value="">全部状态</option>
        ${Object.entries({ in_service: '在运', in_stock: '库存', fault: '故障', returned: '返厂', scrapped: '报废' })
          .map(([v, l]) => `<option value="${v}" ${q.status === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <div class="spacer"></div>
      <span class="small muted">设备在线状态以最后一次上报时间判定</span>
    </div>
    <div class="card">
      ${table({
        columns: [
          { label: '资产编号', render: (r) => `<b class="mono">${r.asset_no}</b><div class="small muted">${esc(r.serial_no || '')}</div>` },
          { label: '型号 / 厂商', render: (r) => `<div>${esc(r.model || '—')}</div><div class="small muted">${esc(r.vendor || '')}</div>` },
          { label: '规约 / 相别', render: (r) => `<div class="small">${esc(r.protocol || '—')}</div><div class="small muted">${esc(r.phase || '')} ${esc(r.voltage || '')}</div>` },
          { label: '倍率', align: 'right', render: (r) => `<span class="mono">×${r.ratio}</span>` },
          { label: 'IMEI', render: (r) => `<span class="mono small">${esc(r.imei || '—')}</span>` },
          { label: '绑定户', render: (r) => r.account_no
            ? `<div class="mono small">${r.account_no}</div><div class="small muted">${esc(r.customer_name || '')}</div>`
            : '<span class="pill gray">未绑定</span>' },
          { label: '最后上报', render: (r) => `<span class="small mono">${fmt.dt(r.last_seen_at) || '—'}</span>` },
          { label: '状态', render: (r) => p.device(r.status) },
        ],
        rows: data.items,
        empty: '暂无电表',
      })}
      ${data.total ? pager({ page: data.page, pages: data.pages, total: data.total, size: data.size }) : ''}
    </div>`;

  bindPager(view, (page) => {
    const u = new URLSearchParams(location.hash.split('?')[1] || '');
    u.set('page', page); ctx.navigate(`/devices?${u}`);
  });
  bindRowClick(view, data.items, (r) => openDevice(r.id));
  view.querySelector('#fq').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ctx.navigate(`/devices?q=${encodeURIComponent(e.target.value)}`);
  });
  view.querySelector('#fstatus').onchange = (e) => ctx.navigate(`/devices?status=${e.target.value}`);
  view.querySelector('#btnNew').onclick = () => openCreate(ctx);
}

async function openDevice(id) {
  const d = await get(`/api/devices/${id}`);
  const v = d.device;
  openModal({
    title: `${v.asset_no}`,
    subtitle: `${esc(v.vendor || '')} ${esc(v.model || '')} · ${esc(v.protocol || '')}`,
    size: 'wide',
    body: `
      <div class="row wrap gap-8 mb-16">${p.device(v.status)}
        <span class="tag">倍率 ×${v.ratio}</span><span class="tag">${esc(v.phase || '')}</span>
        <span class="tag">${esc(v.voltage || '')}</span><span class="tag">精度 ${esc(v.accuracy || '')}</span>
        <span class="tag">固件 ${esc(v.firmware || '—')}</span></div>
      <dl class="dl" style="grid-template-columns:96px 1fr 96px 1fr">
        <dt>IMEI</dt><dd class="mono">${esc(v.imei || '—')}</dd>
        <dt>模块号</dt><dd class="mono">${esc(v.module_no || '—')}</dd>
        <dt>SIM 卡</dt><dd class="mono">${esc(v.sim_no || '—')}</dd>
        <dt>出厂编号</dt><dd class="mono">${esc(v.serial_no || '—')}</dd>
        <dt>生产日期</dt><dd>${fmt.date(v.manufacture_date)}</dd>
        <dt>安装日期</dt><dd>${fmt.date(v.installed_at)}</dd>
        <dt>最后上报</dt><dd>${fmt.dt(v.last_seen_at)}</dd>
        <dt>拆除日期</dt><dd>${fmt.date(v.removed_at)}</dd>
      </dl>
      <div class="divider"></div>
      <h4 style="font-size:13px;margin-bottom:10px">安装历史</h4>
      <div class="timeline">
        ${d.segments.map((s) => `<div class="tl-item ${s.status === 'active' ? '' : 'gray'}">
          <b>${esc(s.account_no)} · ${esc(s.customer_name)}</b>
          <span>${esc(s.address || '')}</span>
          <div class="small muted" style="margin-top:4px">${fmt.date(s.start_date)} 安装 · 起码 ${fmt.kwh(s.start_reading)}
            ${s.end_date ? ` · ${fmt.date(s.end_date)} 拆除 · 止码 ${fmt.kwh(s.end_reading)}` : ' · 在运中'}</div>
        </div>`).join('') || '<div class="empty">未安装</div>'}
      </div>
      <div class="divider"></div>
      <h4 style="font-size:13px;margin-bottom:10px">最近上报</h4>
      <div class="table-wrap" style="border:1px solid var(--line);border-radius:10px;max-height:240px;overflow:auto">
        <table class="tbl"><thead><tr><th>时间</th><th class="num">示数</th><th>来源</th><th>质量</th></tr></thead>
        <tbody>${d.readings.map((r) => `<tr><td class="mono small">${fmt.dt(r.read_at)}</td>
          <td class="num">${fmt.kwh(r.reading)}</td><td>${p.source(r.source)}</td><td>${p.quality(r.quality)}</td></tr>`).join('')}</tbody></table>
      </div>`,
    footer: `<button class="btn" data-close-modal>关闭</button>`,
  });
}

async function openCreate(ctx) {
  const meta = await get('/api/meta');
  openModal({
    title: '新增电表',
    subtitle: '先登记资产，再绑定到户；已装表的户请走换表工单',
    size: 'wide',
    body: formGrid(`
      ${field({ label: '资产编号', name: 'assetNo', required: true, placeholder: 'MT3401020099', hint: '现场资产条码，全局唯一' })}
      ${field({ label: '出厂编号', name: 'serialNo' })}
      ${field({ label: '厂商', name: 'vendor', placeholder: '威胜集团' })}
      ${field({ label: '型号', name: 'model', placeholder: 'DDZY102-Z' })}
      ${field({ label: '通信规约', name: 'protocol', type: 'select', options: ['DL/T645-2007', 'DL/T698.45', 'Modbus'].map((v) => ({ value: v, label: v })) })}
      ${field({ label: '相别', name: 'phase', type: 'select', options: ['单相', '三相'].map((v) => ({ value: v, label: v })) })}
      ${field({ label: '电压', name: 'voltage', value: '220V' })}
      ${field({ label: '倍率', name: 'ratio', type: 'number', value: '1', hint: 'CT 变比，实际电量 = 表码增量 × 倍率' })}
      ${field({ label: '通信模组 IMEI', name: 'imei' })}
      ${field({ label: 'SIM 卡号', name: 'simNo' })}
      ${field({ label: '绑定户号（可选）', name: 'accountNo', placeholder: '留空则进库存', hint: '该户必须尚未安装电表' })}
      ${field({ label: '安装日期', name: 'installDate', type: 'date', value: meta.today })}
    `),
    footer: `<button class="btn" data-close-modal>取消</button><button class="btn primary" data-submit>保存</button>`,
    onMount(root, close) {
      root.querySelector('[data-submit]').onclick = async () => {
        try {
          const body = formData(root);
          const res = await post('/api/devices', body);
          toast(`已新增电表 ${res.assetNo}`);
          close(); ctx.refresh();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}
