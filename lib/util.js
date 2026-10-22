const pad = (n) => String(n).padStart(2, '0');

export function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function ymdhm(d) {
  return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function parseDate(s) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
export function addMonths(d, n) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}
export function monthStart(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
export function monthEnd(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}
export function periodOf(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
export function periodEnd(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(y, m, 0);
}
export function periodStart(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(y, m - 1, 1);
}
export function prevPeriod(period, n = 1) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y, m - 1 - n, 1);
  return periodOf(d);
}
export function nextPeriod(period) {
  return prevPeriod(period, -1);
}
export function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}
export function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}
export function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
export function fmtMoney(n, digits = 2) {
  return Number(n || 0).toFixed(digits);
}
export function nowStr() {
  return ymdhm(new Date());
}
export function todayStr() {
  return ymd(new Date());
}
export function seq(n, width = 4) {
  return String(n).padStart(width, '0');
}
export function nonEmpty(v) {
  return v === undefined || v === null || v === '' ? null : v;
}
export function randomId(prefix, len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return prefix + s;
}
export function maskName(name) {
  if (!name) return '—';
  if (name.length <= 1) return name;
  if (name.length === 2) return name[0] + '*';
  return name[0] + '*'.repeat(name.length - 2) + name[name.length - 1];
}
export function maskPhone(p) {
  if (!p) return '—';
  return String(p).replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
}
export function maskIdNo(s) {
  if (!s) return '—';
  return String(s).replace(/^(.{4}).*(.{3})$/, '$1***********$2');
}
