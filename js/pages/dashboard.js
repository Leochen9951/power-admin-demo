import { get, fmt, icon, p, esc, setTopNote } from '../core.js';
import { comboChart, donut, legend, hbars, PALETTE } from '../charts.js';

export default async function render(view, ctx) {
  const period = ctx.query.period || '';
  const d = await get(`/api/dashboard${period ? `?period=${period}` : ''}`);
  const meta = ctx.meta || { periods: [] };
  const periods = (meta.periods || []).map((x) => x.period);
  if (period && !periods.includes(period)) periods.unshift(period);
  const k = d.kpi;
  setTopNote(`数据截止 ${fmt.dt(d.asOf)} · 账期 ${d.period}`);

  const trend = d.trend || [];
  const lastIdx = trend.length - 1;
  const mom = lastIdx > 0 && trend[lastIdx - 1].kwh
    ? ((trend[lastIdx].kwh - trend[lastIdx - 1].kwh) / trend[lastIdx - 1].kwh) * 100
    : 0;

  const kpiCard = ({ label, value, unit, iconName, tone = '', foot, extra = '' }) => `
    <div class="card kpi">
      <div class="kpi-top">
        <span class="kpi-label">${label}</span>
        <span class="kpi-ico ${tone}">${icon(iconName)}</span>
      </div>
      <div class="kpi-value">${value}${unit ? `<small>${unit}</small>` : ''}</div>
      <div class="kpi-foot">${foot}</div>
      ${extra}
    </div>`;

  const deltaTag = (v, invert = false) => {
    const up = v >= 0;
    const cls = up ? (invert ? 'up' : 'down') : (invert ? 'down' : 'up');
    return `<span class="delta ${invert ? (up ? 'up' : 'down') : ''}" style="color:${up ? 'var(--danger)' : 'var(--ok)'}">
      ${icon(up ? 'up' : 'down')}${Math.abs(v).toFixed(1)}%</span>`;
  };

  const channels = (d.channels || []).map((c, i) => ({ label: c.label, value: c.amount, color: PALETTE[i % PALETTE.length] }));
  const channelTotal = channels.reduce((s, c) => s + c.value, 0);

  const propertyItems = (d.property || []).map((x, i) => ({
    label: `${x.type}（${x.cnt} 户）`, value: x.kwh,
    text: `${fmt.kwh(x.kwh)} kWh`, color: PALETTE[i % PALETTE.length],
  }));

  const warnings = (d.alerts?.top || []).slice(0, 4);

  html(view, `
    <div class="page-head">
      <div>
        <h1>运营概览</h1>
        <p>${fmt.period(d.period)} · 数据截止 ${fmt.dt(d.asOf)}</p>
      </div>
      <div class="page-actions">
        <select class="select" id="periodSel">
          ${periods.map((x) => `<option value="${x}" ${x === d.period ? 'selected' : ''}>${fmt.period(x)}</option>`).join('')}
        </select>
        <a class="btn" href="/api/export/bills?period=${d.period}">${icon('down')}导出账单</a>
        <button class="btn primary" id="goBills">${icon('bill')}查看账单</button>
      </div>
    </div>

    <div class="grid g-4">
      ${kpiCard({
        label: '账期用电量', value: fmt.kwh(k.usage), unit: 'kWh', iconName: 'bolt', tone: '',
        foot: `${deltaTag(mom)} <span>较上期</span> <span class="muted">· ${k.bills} 张账单</span>`,
      })}
      ${kpiCard({
        label: '应收电费', value: `¥${fmt.money(k.billed)}`, iconName: 'bill', tone: 'amber',
        foot: `<span>账期 ${fmt.period(d.period)}</span><span class="muted">· 平均 ¥${fmt.money(k.billed / Math.max(1, k.accounts))}/户</span>`,
      })}
      ${kpiCard({
        label: '实收 / 收缴率', value: fmt.pct(k.collectionRate), iconName: 'pay', tone: 'blue',
        foot: `<span>已收 ¥${fmt.money(k.paid)}</span>`,
        extra: `<div class="bar mt-12"><i style="width:${Math.min(100, k.collectionRate)}%"></i></div>`,
      })}
      ${kpiCard({
        label: '欠费金额', value: `¥${fmt.money(k.arrearsAmount)}`, iconName: 'alert', tone: 'red',
        foot: `<span class="pill danger nodot">${k.arrearsAccounts} 户欠费</span><span class="muted">逾期将影响信用评级</span>`,
      })}
    </div>

    <div class="grid g-2-1 mt-16">
      <div class="card">
        <div class="card-head">
          <div><h3>近 12 个月用电与电费</h3><div class="sub">柱：用电量 kWh &nbsp;·&nbsp; 线：电费 元</div></div>
          <div class="legend"><span><i style="background:#1fbd8b"></i>用电量</span><span><i style="background:#dd7d0a"></i>电费</span></div>
        </div>
        <div class="card-body chart">
          ${trend.length ? comboChart({
            labels: trend.map((t) => `${Number(t.period.slice(5))}月`),
            bars: trend.map((t) => t.kwh),
            line: trend.map((t) => t.amount),
          }) : '<div class="empty">暂无数据</div>'}
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div><h3>缴费渠道构成</h3><div class="sub">累计收款 ¥${fmt.money(channelTotal)}</div></div>
        </div>
        <div class="card-body">
          <div class="row" style="justify-content:center;padding:6px 0 14px">
            ${donut(channels, { centerLabel: '累计收款', centerValue: fmtShortMoney(channelTotal) })}
          </div>
          ${legend(channels.map((c) => ({ ...c, text: `¥${fmt.money(c.value, 0)}` })))}
        </div>
      </div>
    </div>

    <div class="grid g-1-1-1 mt-16">
      <div class="card">
        <div class="card-head"><h3>用电结构</h3><span class="sub">${fmt.period(d.period)}</span></div>
        <div class="card-body">
          ${propertyItems.length ? `
            ${hbars(propertyItems)}
            <div class="divider"></div>
            <table class="tbl" style="font-size:12.3px">
              <thead><tr><th>性质</th><th class="num">计费户数</th><th class="num">用电量</th><th class="num">电费</th></tr></thead>
              <tbody>${d.property.map((x, i) => `<tr>
                <td><i style="display:inline-block;width:8px;height:8px;border-radius:3px;margin-right:6px;background:${PALETTE[i % PALETTE.length]}"></i>${x.type}</td>
                <td class="num">${x.cnt}</td>
                <td class="num">${fmt.kwh(x.kwh)}</td>
                <td class="num">¥${fmt.money(x.amount, 0)}</td>
              </tr>`).join('')}
              <tr><td class="strong">合计</td><td class="num strong">${d.property.reduce((s, x) => s + x.cnt, 0)}</td>
                <td class="num strong">${fmt.kwh(k.usage)}</td><td class="num strong">¥${fmt.money(k.billed, 0)}</td></tr>
              </tbody>
            </table>` : '<div class="empty">暂无</div>'}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>用电量 TOP</h3><span class="sub">本账期</span></div>
        <div class="card-body" style="padding-top:0">
          <div class="list">
            ${(d.topUsage || []).slice(0, 6).map((t, i) => `
              <div class="list-item" data-account="${t.id}" style="cursor:pointer">
                <span class="tag" style="background:${i < 3 ? 'var(--primary-50)' : 'var(--bg-2)'};color:${i < 3 ? 'var(--primary)' : 'var(--muted)'}">${i + 1}</span>
                <div class="li-main"><b>${esc(t.customer_name)} <span class="muted small">${t.account_no}</span></b>
                  <span>${esc(t.address || '')}</span></div>
                <div class="li-val">${fmt.kwh(t.usage_kwh)}<span class="muted small"> kWh</span></div>
              </div>`).join('') || '<div class="empty">暂无</div>'}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>欠费 TOP</h3><span class="sub">全部账期</span></div>
        <div class="card-body" style="padding-top:0">
          <div class="list">
            ${(d.arrearsTop || []).slice(0, 6).map((t) => `
              <div class="list-item" data-account="${t.id}" style="cursor:pointer">
                <div class="li-main"><b>${esc(t.customer_name)} <span class="muted small">${t.account_no}</span></b>
                  <span>${esc(t.phone || '')} · ${t.bills_cnt} 张账单</span></div>
                <div class="li-val" style="color:var(--danger)">¥${fmt.money(t.outstanding)}</div>
              </div>`).join('') || '<div class="empty">暂无欠费</div>'}
          </div>
        </div>
      </div>
    </div>

    <div class="grid g-1-1-1 mt-16">
      <div class="card">
        <div class="card-head"><h3>设备运行</h3><span class="sub">共 ${k.devices} 台</span></div>
        <div class="card-body">
          <div class="stat-row">
            <div><b style="color:var(--primary)">${k.inService}</b><span>在运</span></div>
            <div><b style="color:var(--danger)">${k.fault}</b><span>故障</span></div>
            <div><b style="color:var(--accent)">${k.offline}</b><span>离线</span></div>
            <div><b>${k.inStock}</b><span>库存</span></div>
          </div>
          <div class="row between small mt-12"><span class="muted">设备在线率</span>
            <b>${k.devices ? (((k.devices - k.offline - k.fault - k.inStock) / Math.max(1, k.devices - k.inStock)) * 100).toFixed(1) : 0}%</b></div>
          <div class="bar mt-8"><i style="width:${k.devices ? ((k.inService / Math.max(1, k.devices)) * 100) : 0}%"></i></div>
          ${(d.faultDevices || []).length ? `<div class="divider"></div>
            <div class="small muted mb-8">异常设备</div>
            ${d.faultDevices.map((x) => `<div class="row between" style="padding:4px 0">
              <span class="mono small">${esc(x.asset_no)}</span>
              <span class="small muted">${esc(x.account_no || '未绑定')}</span>
              ${x.offline_since ? `<span class="pill danger">${fmt.date(x.offline_since)}</span>` : '<span class="pill warn">返厂</span>'}
            </div>`).join('')}` : ''}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>换表工单</h3><a class="btn link sm" href="#/replacements">全部 →</a></div>
        <div class="card-body" style="padding-top:0">
          <div class="list">
            ${(d.replacements?.recent || []).map((r) => `
              <div class="list-item">
                <div class="li-main"><b>${esc(r.account_no)} · ${esc(r.customer_name)}</b>
                  <span>${r.order_no} · ${p.reason(r.reason)}</span></div>
                ${p.work(r.status)}
              </div>`).join('') || '<div class="empty">暂无工单</div>'}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>异常提醒</h3>
          <span class="pill ${d.alerts.high ? 'danger' : 'ok'} nodot">${d.alerts.high} 项高优先</span></div>
        <div class="card-body" style="padding-top:0">
          <div class="list">
            ${warnings.map((a) => `
              <div class="list-item" data-account="${a.accountId}" style="cursor:pointer">
                <span class="kpi-ico ${a.severity === 'high' ? 'red' : 'amber'}" style="width:26px;height:26px">
                  ${icon(a.type === 'offline' ? 'plug' : a.type === 'arrears' ? 'bill' : a.type === 'suspect' ? 'alert' : 'clock')}</span>
                <div class="li-main"><b>${esc(a.title)}</b><span>${esc(a.accountNo || '')} ${esc(a.detail || '')}</span></div>
              </div>`).join('') || '<div class="empty">一切正常</div>'}
          </div>
        </div>
      </div>
    </div>
  `);

  view.querySelector('#periodSel').onchange = (e) => ctx.navigate(`/dashboard?period=${e.target.value}`);
  view.querySelector('#goBills').onclick = () => ctx.navigate(`/bills?period=${d.period}`);
  view.querySelectorAll('[data-account]').forEach((el) => {
    el.addEventListener('click', () => ctx.navigate(`/accounts?id=${el.dataset.account}`));
  });
}

function fmtShortMoney(v) {
  if (v >= 10000) return `¥${(v / 10000).toFixed(1)}万`;
  return `¥${Math.round(v).toLocaleString()}`;
}

function html(el, content) {
  el.innerHTML = content;
}
