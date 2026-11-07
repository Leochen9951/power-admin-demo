import {
  get, post, fmt, icon, p, esc, table, bindRowClick, pager, bindPager, openModal,
  field, formGrid, formData, toast, notice,
} from '../core.js';

const SIZE = 20;

export default async function render(view, ctx) {
  const q = { page: 1, ...ctx.query };
  const qs = new URLSearchParams();
  if (q.accountNo) qs.set('accountNo', q.accountNo);
  if (q.from) qs.set('from', q.from);
  if (q.to) qs.set('to', q.to);
  if (q.quality) qs.set('quality', q.quality);
  qs.set('page', q.page); qs.set('size', SIZE);

  const [data, gaps] = await Promise.all([
    get(`/api/readings?${qs}`),
    get('/api/readings/gaps'),
  ]);

  view.innerHTML = `
    <div class="page-head">
      <div><h1>抄表数据</h1><p>设备上报为主，人工补录为辅；异常数据只挂起、不覆盖</p></div>
      <div class="page-actions">
        <button class="btn" id="btnPush">${icon('plug')}模拟设备上报</button>
        <button class="btn primary" id="btnManual">${icon('plus')}人工补录</button>
      </div>
    </div>

    ${gaps.current.length ? `
      <div class="card mb-16" style="border-color:#f3ddc0;background:#fffdf9">
        <div class="card-head"><div><h3 style="color:#a86407">待补录断档 ${gaps.current.length} 台</h3>
          <div class="sub">设备离线超过 2 天，出账前需现场抄见或在系统内估抄</div></div></div>
        <div class="card-body">
          <div class="grid g-3" style="gap:10px">
            ${gaps.current.map((g) => `<div class="card" style="box-shadow:none;padding:12px">
              <div class="row between"><b class="mono small">${g.account_no}</b>
                <span class="pill ${g.days >= 7 ? 'danger' : 'warn'}">${g.days} 天</span></div>
              <div class="small">${esc(g.customer_name)} · ${esc(g.asset_no)}</div>
              <div class="small muted">最后上报 ${fmt.dt(g.last_at)}</div>
              <button class="btn sm mt-8" data-fill="${g.account_no}">补录读数</button>
            </div>`).join('')}
          </div>
        </div>
      </div>` : ''}

    <div class="toolbar">
      <div class="search">${icon('search')}<input class="input" id="fq" placeholder="户号精确查询" value="${esc(q.accountNo || '')}"/></div>
      <input class="input" type="date" id="ffrom" value="${esc(q.from || '')}" title="开始日期"/>
      <span class="muted small">至</span>
      <input class="input" type="date" id="fto" value="${esc(q.to || '')}" title="结束日期"/>
      <select class="select" id="fq2">
        <option value="">全部质量</option>
        <option value="valid" ${q.quality === 'valid' ? 'selected' : ''}>正常</option>
        <option value="suspect" ${q.quality === 'suspect' ? 'selected' : ''}>异常（倒走/跳变）</option>
      </select>
      <button class="btn" id="fapply">${icon('filter')}筛选</button>
      <div class="spacer"></div>
      <span class="small muted">共 ${data.total} 条记录</span>
    </div>

    <div class="card">
      ${table({
        columns: [
          { label: '抄表时间', render: (r) => `<span class="mono">${fmt.dt(r.read_at)}</span>` },
          { label: '用户', render: (r) => `<div class="strong">${esc(r.customer_name)}</div><div class="small muted mono">${r.account_no}</div>` },
          { label: '表号', render: (r) => `<span class="mono small">${esc(r.asset_no)}</span><div class="small muted">第 ${r.seg_seq} 安装段</div>` },
          { label: '示数', align: 'right', render: (r) => `<b class="mono">${fmt.kwh(r.reading)}</b>` },
          { label: '来源', render: (r) => p.source(r.source) },
          { label: '质量', render: (r) => p.quality(r.quality) },
          { label: '备注', render: (r) => `<span class="small muted">${esc(r.note || '')}</span>` },
        ],
        rows: data.items,
        empty: '没有抄表记录',
      })}
      ${data.total ? pager({ page: data.page, pages: data.pages, total: data.total, size: data.size }) : ''}
    </div>

    ${gaps.history.length ? `<div class="card mt-16">
      <div class="card-head"><div><h3>历史断档</h3><div class="sub">相邻读数间隔超过 5 天的记录，可用于追补核算</div></div></div>
      <div class="card-body" style="padding-top:0">
        <div class="list">${gaps.history.slice(0, 8).map((g) => `
          <div class="list-item"><div class="li-main">
            <b>${esc(g.customer_name)} <span class="muted mono small">${g.account_no}</span></b>
            <span>${fmt.date(g.prev_at)} → ${fmt.date(g.read_at)}</span></div>
            <span class="pill warn">${g.days} 天</span></div>`).join('')}</div>
      </div></div>` : ''}
  `;

  bindPager(view, (page) => {
    const u = new URLSearchParams(location.hash.split('?')[1] || '');
    u.set('page', page); ctx.navigate(`/readings?${u}`);
  });
  const apply = () => {
    const u = new URLSearchParams();
    const acc = view.querySelector('#fq').value.trim();
    const from = view.querySelector('#ffrom').value;
    const to = view.querySelector('#fto').value;
    const qual = view.querySelector('#fq2').value;
    if (acc) u.set('accountNo', acc);
    if (from) u.set('from', from);
    if (to) u.set('to', to);
    if (qual) u.set('quality', qual);
    ctx.navigate(`/readings?${u}`);
  };
  view.querySelector('#fapply').onclick = apply;
  view.querySelector('#fq').addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });

  view.querySelectorAll('[data-fill]').forEach((b) => {
    b.onclick = () => openManual(ctx, b.dataset.fill);
  });
  view.querySelector('#btnManual').onclick = () => openManual(ctx, q.accountNo || '');
  view.querySelector('#btnPush').onclick = () => openPush(ctx);
}

function openManual(ctx, accountNo = '') {
  openModal({
    title: '人工补录读数',
    subtitle: '用于设备离线期间的现场抄见；补录后按实际读数计算电量',
    size: '',
    body: `
      ${notice('补录不会覆盖任何历史数据，系统保留每一次录入的时间、来源与操作人。若示数小于上一条记录，会自动标记为「异常」等待核查，不参与计费。', 'warn')}
      <div class="mt-16">
      ${formGrid(`
        ${field({ label: '户号', name: 'accountNo', value: accountNo, required: true })}
        ${field({ label: '抄表日期', name: 'readAt', type: 'date', value: new Date().toISOString().slice(0, 10) })}
        ${field({ label: '时间', name: 'time', type: 'time', value: '12:00' })}
        ${field({ label: '电表示数 (kWh)', name: 'reading', type: 'number', required: true, placeholder: '如 6422.8' })}
        ${field({ label: '备注', name: 'note', span: 2, placeholder: '如：模块故障期间现场抄见' })}
      `)}</div>`,
    footer: `<button class="btn" data-close-modal>取消</button><button class="btn primary" data-submit>保存补录</button>`,
    onMount(root, close) {
      root.querySelector('[data-submit]').onclick = async () => {
        const body = formData(root);
        if (!body.reading) return toast('请填写示数', 'err');
        try {
          const res = await post('/api/readings', body);
          if (res.quality === 'suspect') toast('已保存，但示数倒走被标记为异常', 'err');
          else toast('补录成功');
          close(); ctx.refresh();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

function openPush(ctx) {
  openModal({
    title: '模拟物联网设备上报',
    subtitle: '模拟电表通过 NB-IoT / 4G 主动上送冻结数据',
    size: '',
    body: formGrid(`
      ${field({ label: '电表资产编号', name: 'assetNo', required: true, placeholder: 'MT3401020001' })}
      ${field({ label: '上报示数 (kWh)', name: 'reading', type: 'number', required: true })}
    `),
    footer: `<button class="btn" data-close-modal>取消</button><button class="btn primary" data-submit>模拟上报</button>`,
    onMount(root, close) {
      root.querySelector('[data-submit]').onclick = async () => {
        const body = formData(root);
        try {
          const res = await post('/api/mock/iot/push', body);
          toast(`上报成功，示数 ${res.reading}（${res.quality === 'valid' ? '正常' : '异常'}）`);
          close(); ctx.refresh();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}
