import { get, post, fmt, icon, esc, table, toast, confirmDialog, openModal, field, formGrid, formData, notice } from '../core.js';

export default async function render(view, ctx) {
  const info = await get('/api/system/info');
  const c = info.counts;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>系统与模拟</h1><p>演示环境：数据可按月推进、可模拟设备上报与故障</p></div>
      <div class="page-actions">
        <span class="pill info">演示版本 1.0</span>
      </div>
    </div>

    <div class="grid g-4 mb-16">
      <div class="card kpi"><div class="kpi-label">用户档案</div><div class="kpi-value">${c.accounts}</div><div class="kpi-foot">户号唯一</div></div>
      <div class="card kpi"><div class="kpi-label">电表资产</div><div class="kpi-value">${c.devices}</div><div class="kpi-foot">含库存与返厂</div></div>
      <div class="card kpi"><div class="kpi-label">抄表记录</div><div class="kpi-value">${fmt.int(c.readings)}</div><div class="kpi-foot">日冻结读数</div></div>
      <div class="card kpi"><div class="kpi-label">账单 / 支付</div><div class="kpi-value">${c.bills}<span class="muted" style="font-size:16px"> / ${c.payments}</span></div><div class="kpi-foot">账期 ${info.lastPeriod || '—'}</div></div>
    </div>

    <div class="grid g-2-1">
      <div class="card">
        <div class="card-head"><div><h3>模拟器</h3><div class="sub">用于演示完整的月度闭环，不影响真实逻辑</div></div></div>
        <div class="card-body">
          <div class="grid g-2" style="gap:12px">
            <div class="card" style="box-shadow:none;padding:16px">
              <b>推进一个账期</b>
              <p class="small muted mt-8">为所有在运表生成一个月的日冻结读数，随后自动出账（含阶梯电价与待处理调整项）。</p>
              <button class="btn primary mt-12" id="advance">${icon('refresh')}模拟推进一个月</button>
            </div>
            <div class="card" style="box-shadow:none;padding:16px">
              <b>模拟设备故障</b>
              <p class="small muted mt-8">把指定户的电表置为故障并自动生成报修工单，用于演示换表流程。</p>
              <div class="row gap-8 mt-12">
                <input class="input" id="faultAcc" placeholder="户号，如 340102000031" style="flex:1"/>
                <button class="btn" id="faultBtn">触发</button>
              </div>
            </div>
            <div class="card" style="box-shadow:none;padding:16px">
              <b>模拟设备上报</b>
              <p class="small muted mt-8">以 IoT 网关身份向平台推送一条示数，验证上报链路。</p>
              <div class="row gap-8 mt-12">
                <input class="input" id="pushAsset" placeholder="资产编号" style="flex:1"/>
                <input class="input" id="pushVal" type="number" placeholder="示数" style="width:100px"/>
                <button class="btn" id="pushBtn">上报</button>
              </div>
            </div>
            <div class="card" style="box-shadow:none;padding:16px">
              <b style="color:var(--danger)">重置演示数据</b>
              <p class="small muted mt-8">清空并重建 60 户、13 个账期的演示数据（含换表/断档/欠费案例）。</p>
              <button class="btn danger mt-12" id="reset">${icon('refresh')}重置数据</button>
            </div>
          </div>

          <div class="divider"></div>
          <div class="notice">${icon('check')}<div>
            <b>更换电表时数据为何不会断：</b>系统把「户 → 计量点 → 安装段 → 设备」分层。
            读数归属于计量点，设备只是某个时间段内的计量工具；换表只关闭旧段、开启新段，
            两段之间的止码差不进入电量计算，因此历史账单与累计用电都不会被改写。
          </div></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>账期运行记录</h3><div class="sub">最近出账</div></div></div>
        <div class="card-body" style="padding-top:0">
          <div class="list">
            ${info.runs.map((r) => `<div class="list-item">
              <div class="li-main"><b>${r.period}</b><span>${fmt.dt(r.ran_at)} · ${r.accounts_cnt} 户</span></div>
              <div class="li-val">¥${fmt.money(r.amount)}<div class="small muted" style="font-weight:400">${fmt.kwh(r.kwh)} kWh</div></div>
            </div>`).join('') || '<div class="empty">尚无出账记录</div>'}
          </div>
        </div>
      </div>
    </div>

    <div class="card mt-16">
      <div class="card-head"><div><h3>数据模型速览</h3><div class="sub">这套结构是「换表不丢数据」的关键</div></div></div>
      <div class="card-body">
        <div class="grid g-4" style="gap:12px">
          ${[
            ['用电户 Account', '户号（国家分配）', '账单、缴费、档案的唯一主体，永不随设备变化'],
            ['计量点 MeteringPoint', '户内表位', '一个户可有多块表（分表/三相），表位不变'],
            ['安装段 Segment', '设备 + 起止日期 + 止码/起码 + 倍率', '换表时关闭旧段、开启新段'],
            ['读数 Reading', '时间 + 示数 + 来源 + 质量', '只追加不覆盖，修订用 superseded_by'],
          ].map(([t, s, d]) => `<div class="card" style="box-shadow:none;padding:14px;background:#fbfcfb">
            <b style="font-size:12.5px">${t}</b>
            <div class="small mono" style="color:var(--primary);margin:4px 0">${s}</div>
            <div class="small muted">${d}</div></div>`).join('')}
        </div>
      </div>
    </div>
  `;

  view.querySelector('#advance').onclick = async () => {
    const ok = await confirmDialog('推进一个账期', '将为所有在运电表生成一个月的日冻结读数并自动出账。此操作会写入演示数据，可随时重置。', { okText: '开始推进' });
    if (!ok) return;
    try {
      const res = await post('/api/system/advance-month');
      toast(`${res.period} 已生成：${res.readings} 条读数，${res.accounts} 户账单，¥${fmt.money(res.amount)}`);
      ctx.refresh();
    } catch (e) { toast(e.message, 'err'); }
  };

  view.querySelector('#faultBtn').onclick = async () => {
    const acc = view.querySelector('#faultAcc').value.trim();
    if (!acc) return toast('请输入户号', 'err');
    try {
      const res = await post('/api/mock/fault', { accountNo: acc });
      toast(`已模拟故障，工单 ${res.orderNo}`);
      ctx.refresh();
    } catch (e) { toast(e.message, 'err'); }
  };

  view.querySelector('#pushBtn').onclick = async () => {
    const assetNo = view.querySelector('#pushAsset').value.trim();
    const reading = view.querySelector('#pushVal').value;
    if (!assetNo || !reading) return toast('请填写资产编号与示数', 'err');
    try {
      const res = await post('/api/mock/iot/push', { assetNo, reading });
      toast(`上报成功：${res.reading} kWh`);
    } catch (e) { toast(e.message, 'err'); }
  };

  view.querySelector('#reset').onclick = async () => {
    const ok = await confirmDialog('重置演示数据', '将清空当前所有数据并重新生成种子数据，登录状态保持不变。', { danger: true, okText: '确认重置' });
    if (!ok) return;
    try {
      await post('/api/system/reset');
      toast('演示数据已重置');
      ctx.refresh();
    } catch (e) { toast(e.message, 'err'); }
  };
}
