import { fmt, icon, esc } from '../core.js';

const LOG = [
  {
    version: 'v1.1.0',
    date: '2026-11-07',
    title: '一户多表',
    summary: '一个户号可以挂多块表，账单按表列示；同时修掉两个月初会误报的问题。',
    compare: [
      ['一个户挂多块表', '不支持，一户一表', '支持（住宅+车库、住宅+商铺、多层分表）'],
      ['计量点独立电价', '跟随户的电价', '每个计量点可单独设置电价与用电性质'],
      ['分表不计费', '不支持', '支持「不计费」计量点，只留档不进账单'],
      ['账单计费明细', '单一用量', '按表分行列示，再展开阶梯档位'],
      ['新增计量点', '无入口', '户档「计量与设备」内可直接新增'],
      ['装表指定表位', '自动装到第一个表位', '可指定计量点，或空表位不足时自动新建'],
      ['抄表列表', '只显示表号', '显示表号 + 计量点名称'],
      ['旧数据库升级', '—', '启动时自动补字段，无需重建'],
    ],
    sections: [
      {
        type: '新增',
        items: [
          '户档支持多个计量点，每块表有独立的编号、电价、用电性质和计费开关',
          '「新增计量点」：可同时从库存选表安装，也可先建点后装表',
          '新增电表时可指定装到哪个计量点；没有空表位时可自动新建',
          '账单计费明细按表拆分，合计行标注「N 块表」',
        ],
      },
      {
        type: '变更',
        items: [
          '出账规则：同一电价的多块表合并计算阶梯；不同电价按分组分别计价，分行列示',
          '用户列表在表号后显示「共 N 表」，户档头部显示「共 N 块表」',
          '收费、欠费、催收仍按户号一个口径，一张账单',
        ],
      },
      {
        type: '修复',
        items: [
          '月初数据不足时，告警误报「用电量骤降」（改为按已过天数折算成整月再比较）',
          '新建用户与批量导入时，计量点未写入用电性质和电价',
        ],
      },
    ],
  },
  {
    version: 'v1.0.0',
    date: '2026-10-22',
    title: '首个可演示版本',
    summary: '跑通「建户 → 抄表 → 出账 → 缴费 → 换表」的完整闭环，并上线静态演示站。',
    compare: null,
    sections: [
      {
        type: '包含',
        items: [
          '户 / 计量点 / 安装段 / 设备四层模型，换表跨段不计电量',
          '设备上报、人工补录、断档识别、异常读数挂起',
          '阶梯电价出账、调整项追补、支付与账单多对多核销',
          '管理后台 9 个模块 + 移动端缴费 H5',
          '一键生成演示数据、模拟推进账期、模拟设备故障',
          'GitHub Pages 静态演示与 Render 部署配置',
        ],
      },
    ],
  },
];

export default async function render(view, ctx) {
  const current = LOG[0];
  const isStatic = typeof window !== 'undefined' && window.__STATIC_DEMO__;
  const archiveHref = isStatic ? './v1/' : null;
  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>更新日志</h1>
        <p>当前版本 ${current.version} · ${current.date} · 共 ${LOG.length} 个版本</p>
      </div>
      <div class="page-actions">
        ${archiveHref
          ? `<a class="btn" href="${archiveHref}" target="_blank">${icon('eye')}查看 v1.0 归档</a>`
          : '<span class="pill gray">归档版本部署在静态演示站的 /v1/</span>'}
      </div>
    </div>

    <div class="card mb-16">
      <div class="card-head">
        <div><h3>${current.version} 改了什么</h3><div class="sub">${esc(current.summary)}</div></div>
        <span class="pill ok">当前版本</span>
      </div>
      <div class="card-body">
        <div class="table-wrap" style="border:1px solid var(--line);border-radius:12px">
          <table class="tbl">
            <thead><tr><th style="width:26%">能力</th><th style="width:30%">v1.0</th><th>v1.1</th></tr></thead>
            <tbody>
              ${current.compare.map(([k, a, b]) => `<tr>
                <td>${esc(k)}</td>
                <td class="muted">${esc(a)}</td>
                <td><b>${esc(b)}</b></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    ${LOG.map((v, i) => `
      <div class="card mb-16">
        <div class="card-head">
          <div>
            <h3>${v.version} <span class="muted" style="font-weight:400;font-size:12px">· ${v.date} · ${esc(v.title)}</span></h3>
            <div class="sub">${esc(v.summary)}</div>
          </div>
          ${i === 0 ? '<span class="pill ok">当前版本</span>' : '<span class="pill gray">归档</span>'}
        </div>
        <div class="card-body">
          ${v.sections.map((s) => `
            <div class="mb-12">
              <div class="row gap-8" style="margin-bottom:6px">
                <span class="pill ${s.type === '新增' ? 'info' : s.type === '变更' ? 'warn' : s.type === '修复' ? 'ok' : 'gray'} nodot">${s.type}</span>
              </div>
              <ul style="margin:0;padding-left:18px;font-size:12.8px;line-height:1.9;color:var(--ink-2)">
                ${s.items.map((t) => `<li>${esc(t)}</li>`).join('')}
              </ul>
            </div>`).join('')}
          ${i > 0 && archiveHref ? `<div class="notice">${icon('eye')}<div>该版本的静态演示仍保留在 <a href="${archiveHref}" target="_blank">/v1/</a>，可随时对照查看。</div></div>` : ''}
        </div>
      </div>`).join('')}

    <div class="card">
      <div class="card-head"><h3>版本对照入口</h3></div>
      <div class="card-body">
        <div class="grid g-2" style="gap:12px">
          <a class="card" href="${archiveHref || '#'}" ${archiveHref ? 'target="_blank"' : 'style="opacity:.6;pointer-events:none"'} style="box-shadow:none;padding:16px;text-decoration:none;color:inherit">
            <div class="row between"><b>v1.0 归档版</b><span class="pill gray">只读快照</span></div>
            <div class="small muted mt-8">一户一表，账单只有一条用量；用于对比改动前后的差异。</div>
            <div class="small mono mt-8" style="color:var(--primary)">${archiveHref ? '打开 /v1/ →' : '仅在静态演示站提供'}</div>
          </a>
          <a class="card" href="./" style="box-shadow:none;padding:16px;text-decoration:none;color:inherit">
            <div class="row between"><b>v1.1 当前版</b><span class="pill ok">最新</span></div>
            <div class="small muted mt-8">一户多表，账单按表分行；支持独立电价与不计费分表。</div>
            <div class="small mono mt-8" style="color:var(--primary)">返回首页 →</div>
          </a>
        </div>
      </div>
    </div>
  `;
}
