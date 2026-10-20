(function () {
  'use strict';
  const CATS = ['Hosting', 'Database', 'Storage & media', 'Email', 'Monitoring', 'Cache & rate limits', 'Domain & DNS', 'AI', 'Payments', 'Logistics', 'Dev tools', 'Other'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const BILL_LABEL = { MONTHLY: 'Monthly', YEARLY: 'Yearly', USAGE: 'Usage', FREE: 'Free' };
  const PRIO = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  const PRIO_LABEL = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };
  const ACTION_LABEL = { SETTINGS_FX: 'Changed default rate', SERVICE_CREATED: 'Added service', SERVICE_UPDATED: 'Edited service', SERVICE_DELETED: 'Deleted service', ENTRIES_CREATED: 'Recorded bills', ENTRY_UPDATED: 'Edited bill', ENTRY_DELETED: 'Deleted bill', ATTACHMENT_ADDED: 'Added screenshot', ATTACHMENT_DELETED: 'Deleted screenshot' };
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  const MAX_BYTES = 5 * 1024 * 1024;
  const state = { services: [], entries: [], attachments: [], uploadsEnabled: false, fxRate: 1335, me: '', ready: false, year: new Date().getFullYear(), tab: 'ledger', prio: '', status: '' };
  const $ = (id) => document.getElementById(id);
  const ngnFmt = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 });
  const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
  const ngn = (v) => ngnFmt.format(Math.round(v || 0)).replace('NGN', '₦');
  // Ledger rows and their totals show kobo too, so adding up the column gives exactly the total shown.
  const ngnExactFmt = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ngnExact = (v) => ngnExactFmt.format(Math.round((v || 0) * 100) / 100).replace('NGN', '₦');
  const sumKobo = (list) => list.reduce((a, e) => a + Math.round((e.ngn || 0) * 100), 0) / 100;
  // Bill amounts: dollars and naira both to 2 decimal places with thousands commas ($1,234.50, ₦15,000.00).
  const money = (v, c) => (c === 'USD' ? usdFmt.format(v || 0) : ngnExact(v));
  const sym = (c) => (c === 'USD' ? '$' : '₦');

  // Money boxes are plain text so they can show commas while you type; these read and fill them.
  const plain = (v) => String(v ?? '').replace(/,/g, '').trim();
  function groupDigits(raw) {
    let [int, dec] = plain(raw).replace(/[^\d.]/g, '').split(/\.(.*)/s);
    int = (int || '').replace(/^0+(?=\d)/, '');
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return dec !== undefined ? `${grouped || '0'}.${dec.replace(/\./g, '').slice(0, 2)}` : grouped;
  }
  const numOf = (el) => plain(el.value);
  function setMoney(el, v) { el.value = v === '' || v === null || v === undefined ? '' : groupDigits(Number(v).toFixed(2).replace(/\.00$/, '')); }
  // Reformat as you type and keep the cursor next to the same digit.
  document.addEventListener('input', (ev) => {
    const el = ev.target;
    if (!el.classList || !el.classList.contains('money')) return;
    const caret = el.selectionStart ?? el.value.length;
    const significant = el.value.slice(0, caret).replace(/[^\d.]/g, '').length;
    const next = groupDigits(el.value);
    if (next === el.value) return;
    el.value = next;
    let seen = 0, pos = 0;
    while (pos < next.length && seen < significant) { if (/[\d.]/.test(next[pos])) seen++; pos++; }
    el.setSelectionRange(pos, pos);
  }, true);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fx = () => Number(state.fxRate) || 1335;
  const toNgn = (amt, cur, rate) => (cur === 'USD' ? Number(amt || 0) * (Number(rate) || fx()) : Number(amt || 0));
  const monthLabel = (p) => { const [y, m] = p.split('-'); return MONTHS[+m - 1] + ' ' + y; };
  const svcById = (id) => state.services.find((s) => s.id === id);
  const curMonth = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
  const prioRank = (p) => { const i = PRIO.indexOf(p); return i < 0 ? 2 : i; };
  const prioPill = (p) => `<span class="prio prio-${esc(p)}">${esc(PRIO_LABEL[p] || p)}</span>`;
  const filesOf = (type, id) => state.attachments.filter((a) => a.ownerType === type && a.ownerId === id);
  const fileUrl = (id) => '/api/attachments/' + encodeURIComponent(id);
  // Links are checked as https:// on the server; this is a second guard before they become an href.
  const safeLink = (u) => (/^https:\/\//i.test(u || '') ? u : '');

  function toast(msg) { document.querySelectorAll('.toast').forEach((x) => x.remove()); const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); }

  async function call(method, path, body, raw) {
    let res;
    try {
      res = await fetch(path, raw
        ? { method, credentials: 'same-origin', headers: raw.headers, body: raw.body }
        : { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    } catch {
      // Cloudflare Access redirects to its sign-in page once the session ends, which fetch can't follow.
      throw new Error('Your sign-in may have expired. Reload the page to sign in again.');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 && !data.error) { location.reload(); throw new Error('Your sign-in expired.'); }
    if (!res.ok) throw new Error(data.error || 'Could not save. Try again.');
    return data;
  }
  async function load() {
    try {
      const d = await call('GET', '/api/state');
      Object.assign(state, { services: d.services, entries: d.entries, attachments: d.attachments || [], uploadsEnabled: !!d.uploadsEnabled, fxRate: d.fxRate, me: d.me, ready: true });
      $('whoami').textContent = 'Signed in as ' + d.me;
      $('notice').hidden = true;
    } catch (e) { $('notice').hidden = false; $('notice').textContent = e.message; }
    render();
  }
  // Activity details are stored as plain numbers ("25782.17 NGN"); show them as money.
  function prettyDetail(a) {
    if (a.action === 'SETTINGS_FX' && /^\d+(\.\d+)?$/.test(a.detail)) return `${ngnExact(Number(a.detail))} per $1`;
    return String(a.detail || '').replace(/(-?\d+(?:\.\d+)?) NGN/g, (_, n) => ngnExact(Number(n)));
  }
  // Activity is fetched one page at a time; moving between pages only swaps the table rows.
  const audit = { page: 1, size: 10, pages: 1, total: 0, req: 0 };
  try { const saved = Number(localStorage.getItem('zc-audit-size')); if ([10, 20, 50, 100].includes(saved)) audit.size = saved; } catch { /* storage blocked */ }
  async function loadAudit(page = audit.page) {
    const id = ++audit.req;
    $('auditTable').classList.add('loading');
    try {
      const d = await call('GET', `/api/audit?page=${page}&size=${audit.size}`);
      if (id !== audit.req) return; // a newer page was asked for meanwhile
      // If the last page emptied (e.g. after changing the page size), step back to the real last page.
      if (!d.audit.length && d.total && d.page > d.pages) return loadAudit(d.pages);
      Object.assign(audit, { page: d.page, pages: d.pages, total: d.total });
      $('auditBody').innerHTML = d.audit.length ? d.audit.map((a) => `<tr><td class="mono">${esc(new Date(a.at).toLocaleString('en-GB', { timeZone: 'Africa/Lagos' }))}</td><td>${esc(a.email)}</td><td>${esc(ACTION_LABEL[a.action] || a.action)}</td><td class="sub">${esc(prettyDetail(a))}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">No changes yet.</td></tr>';
      const from = d.total ? (d.page - 1) * d.size + 1 : 0, to = Math.min(d.total, d.page * d.size);
      $('auditRange').textContent = d.total ? `Showing ${from.toLocaleString('en-NG')}–${to.toLocaleString('en-NG')} of ${d.total.toLocaleString('en-NG')} changes` : '';
      $('auditPageLbl').textContent = `Page ${d.page} of ${d.pages}`;
      $('auditFirst').disabled = $('auditPrev').disabled = d.page <= 1;
      $('auditNext').disabled = $('auditLast').disabled = d.page >= d.pages;
    } catch (e) {
      if (id === audit.req) $('auditBody').innerHTML = `<tr><td colspan="4" class="empty">${esc(e.message)}</td></tr>`;
    } finally {
      if (id === audit.req) $('auditTable').classList.remove('loading');
    }
  }
  $('auditSize').value = String(audit.size);
  $('auditSize').addEventListener('change', (e) => {
    const first = (audit.page - 1) * audit.size; // keep the same rows in view
    audit.size = Number(e.target.value);
    try { localStorage.setItem('zc-audit-size', String(audit.size)); } catch { /* storage blocked */ }
    loadAudit(Math.floor(first / audit.size) + 1);
  });
  $('auditFirst').addEventListener('click', () => loadAudit(1));
  $('auditPrev').addEventListener('click', () => loadAudit(Math.max(1, audit.page - 1)));
  $('auditNext').addEventListener('click', () => loadAudit(Math.min(audit.pages, audit.page + 1)));
  $('auditLast').addEventListener('click', () => loadAudit(audit.pages));


  // A yearly service switched to "once a year" stays out of the monthly figures entirely.
  const notSpread = (s) => s.billing === 'YEARLY' && s.spreadMonthly === false;
  const yearlyOnce = (s) => (s.status === 'ACTIVE' && notSpread(s) ? toNgn(Number(s.price) || 0, s.currency) : 0);
  function monthlyEquiv(s) {
    if (notSpread(s)) return 0;
    if (s.status !== 'ACTIVE' || s.billing === 'FREE') return 0;
    const p = Number(s.price) || 0;
    return toNgn(s.billing === 'YEARLY' ? p / 12 : p, s.currency);
  }

  // Screenshots count + payment link, shared by the ledger, services table and due list.
  // Small clickable previews. Each strip registers its images as a group the lightbox can page through.
  const lbGroups = {};
  function thumbStrip(key, title, list, max = 3) {
    if (!list.length) return '';
    lbGroups[key] = { title, items: list.map((a) => ({ src: fileUrl(a.id), caption: a.filename, meta: `added by ${a.createdBy} · ${new Date(a.createdAt).toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos' })}` })) };
    const shown = list.slice(0, max).map((a, i) => `<button type="button" class="mini" data-lb="${esc(key)}" data-i="${i}" aria-label="View ${esc(a.filename)}"><img src="${fileUrl(a.id)}" alt="" loading="lazy"></button>`).join('');
    const more = list.length > max ? `<button type="button" class="mini more" data-lb="${esc(key)}" data-i="${max}" aria-label="View all ${list.length} screenshots">+${list.length - max}</button>` : '';
    return `<div class="minis">${shown}${more}</div>`;
  }
  // Long text is cut to two lines with a "Read more" toggle; which cells are open survives re-renders.
  const expanded = new Set();
  const clamp = (html, key) => (html ? `<div class="clamp${expanded.has(key) ? ' open' : ''}" data-key="${esc(key)}"><div class="clamp-text">${html}</div><button type="button" class="linkish more-btn" data-more="${esc(key)}" hidden>${expanded.has(key) ? 'Show less' : 'Read more'}</button></div>` : '');
  // Only offer "Read more" where the text really is cut off.
  function markClamps() {
    document.querySelectorAll('.clamp').forEach((c) => {
      const t = c.querySelector('.clamp-text');
      c.querySelector('.more-btn').hidden = !c.classList.contains('open') && t.scrollHeight <= t.clientHeight + 1;
    });
  }
  window.addEventListener('resize', () => requestAnimationFrame(markClamps));
  function filesCell(type, item, linkUrl, title) {
    const strip = thumbStrip(`${type}:${item.id}`, title, filesOf(type, item.id));
    const link = safeLink(linkUrl);
    const parts = [];
    if (strip) parts.push(strip);
    if (link) parts.push(`<a class="linkish" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Payment page</a>`);
    return parts.length ? `<div class="files">${parts.join('')}</div>` : '<span class="sub">–</span>';
  }

  function render() {
    const years = new Set([new Date().getFullYear(), state.year]);
    state.entries.forEach((e) => years.add(+e.period.slice(0, 4)));
    $('yearSel').innerHTML = [...years].sort((a, b) => b - a).map((y) => `<option ${y === state.year ? 'selected' : ''}>${y}</option>`).join('');
    if (document.activeElement !== $('fxInput')) setMoney($('fxInput'), fx());

    // Every bill in the year (the ledger shows them all), and the ones that count towards totals.
    const yAll = state.entries.filter((e) => e.period.startsWith(state.year + '-'));
    const yE = yAll.filter((e) => e.counted !== false);
    const left = yAll.length - yE.length;
    const total = sumKobo(yE);
    const byMonth = Array(12).fill(0);
    yE.forEach((e) => { byMonth[+e.period.slice(5, 7) - 1] += e.ngn || 0; });
    const recMonths = new Set(yE.map((e) => e.period)).size;
    const run = state.services.reduce((a, s) => a + monthlyEquiv(s), 0);
    const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
    const dueTotal = sumKobo(yE.filter((e) => e.status === 'DUE'));
    $('kTotalLbl').textContent = 'Total costs in ' + state.year;
    $('kTotal').textContent = ngn(total);
    $('kTotalSub').textContent = dueTotal
      ? `${ngn(total - dueTotal)} paid + ${ngn(dueTotal)} still due`
      : plural(yE.length, 'bill', 'bills') + ' across ' + plural(recMonths, 'month', 'months') + (left ? `, ${left} not counted` : '');
    $('kAvg').textContent = ngn(recMonths ? total / recMonths : 0);
    $('kAvgSub').textContent = recMonths ? 'over ' + plural(recMonths, 'recorded month', 'recorded months') : 'nothing recorded yet';
    $('kRun').textContent = ngn(run);
    const usage = state.services.filter((s) => s.status === 'ACTIVE' && s.billing === 'USAGE').length;
    $('kRunSub').textContent = usage ? 'plus ' + plural(usage, 'usage-billed service', 'usage-billed services') : 'from active services';
    const once = state.services.reduce((a, s) => a + yearlyOnce(s), 0);
    const onceCount = state.services.filter((s) => s.status === 'ACTIVE' && notSpread(s)).length;
    $('kYear').textContent = ngn(run * 12 + once);
    $('kYearSub').textContent = once ? `run-rate × 12 + ${ngn(once)} paid once a year` : 'run-rate × 12';
    if (onceCount) $('kRunSub').textContent += `${$('kRunSub').textContent.startsWith('plus') ? ',' : ';'} ${plural(onceCount, 'yearly payment', 'yearly payments')} not spread`;

    // Due to pay: every unpaid bill, any year, most urgent first.
    const due = state.entries.filter((e) => e.status === 'DUE' && e.counted !== false).sort((a, b) => prioRank(a.priority) - prioRank(b.priority) || a.period.localeCompare(b.period));
    $('duePanel').hidden = !due.length;
    if (!due.length) $('dueList').innerHTML = '';
    if (due.length) {
      $('dueSub').textContent = `${plural(due.length, 'bill', 'bills')} · ${ngnExact(sumKobo(due))}${due.some((e) => !e.period.startsWith(state.year + '-')) ? ' (all years)' : ''}`;
      $('dueList').innerHTML = due.map((e) => {
        const s = svcById(e.serviceId);
        const link = safeLink(e.paymentUrl || s?.paymentUrl);
        const strip = thumbStrip(`due:${e.id}`, `${s?.name || 'Bill'}, ${monthLabel(e.period)}`, filesOf('entry', e.id).concat(filesOf('service', e.serviceId)), 2);
        return `<li class="due-item">${prioPill(e.priority)}<div><strong>${esc(s?.name || 'Removed service')}</strong> <span class="sub">${monthLabel(e.period)}${e.note ? ' · ' + esc(e.note) : ''}</span></div><span class="num">${money(e.amount, e.currency)}${e.currency === 'USD' ? ` <span class="sub">${ngnExact(e.ngn)}</span>` : ''}</span><div class="due-actions">${strip}${link ? `<a class="btn" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open payment page</a>` : ''}<button class="primary" data-mark-paid="${esc(e.id)}">Mark paid</button></div></li>`;
      }).join('');
    }

    drawChart(byMonth);

    const cats = {};
    yE.forEach((e) => { const c = svcById(e.serviceId)?.category || 'Other'; cats[c] = (cats[c] || 0) + (e.ngn || 0); });
    const cl = Object.entries(cats).sort((a, b) => b[1] - a[1]);
    const cmax = cl[0]?.[1] || 1;
    $('catSub').textContent = state.year;
    $('catList').innerHTML = cl.length
      ? cl.map(([c, v]) => `<li class="cat-row"><span>${esc(c)}</span><span class="num">${ngn(v)} <span class="sub">${total ? Math.round((v / total) * 100) : 0}%</span></span><div class="cat-track"><div class="cat-fill" data-w="${Math.max(2, (v / cmax) * 100)}"></div></div></li>`).join('')
      : `<li class="sub">No spend recorded for ${state.year}. Use "Record a month" to add the first bills.</li>`;
    document.querySelectorAll('.cat-fill').forEach((el) => { el.style.width = el.dataset.w + '%'; });

    // Ledger: newest month first; inside a month, most urgent first.
    const matchStatus = (e) => !state.status || (state.status === 'OFF' ? e.counted === false : e.status === state.status);
    const shown = yAll.filter((e) => (!state.prio || e.priority === state.prio) && matchStatus(e));
    const shownCounted = shown.filter((e) => e.counted !== false);
    const shownLeft = shown.filter((e) => e.counted === false);
    const sorted = [...shown].sort((a, b) => b.period.localeCompare(a.period) || prioRank(a.priority) - prioRank(b.priority) || (svcById(a.serviceId)?.name || '').localeCompare(svcById(b.serviceId)?.name || ''));
    const filtered = state.prio || state.status;
    $('ledgerSub').textContent = yAll.length ? `${state.year}: ${plural(yAll.length, 'entry', 'entries')}${filtered ? `, ${shown.length} shown` : ''}` : '';
    const shownByMonth = {};
    shownCounted.forEach((e) => { shownByMonth[e.period] = Math.round(((shownByMonth[e.period] || 0) + e.ngn) * 100) / 100; });
    let html = '', cur = '';
    for (const e of sorted) {
      if (e.period !== cur) { cur = e.period; html += `<tr class="month-row"><td colspan="6">${monthLabel(cur)}</td><td class="num">${ngnExact(shownByMonth[cur] || 0)}</td><td colspan="2"></td></tr>`; }
      const s = svcById(e.serviceId);
      const off = e.counted === false;
      html += `<tr class="${off ? 'uncounted' : ''}"><td>${esc(s?.name || 'Removed service')}<div class="sub">${esc(s?.category || '')}</div></td><td>${prioPill(e.priority)}</td><td><span class="st-${esc(e.status)}">${e.status === 'DUE' ? 'Due' : 'Paid'}</span>${e.paidOn ? `<div class="sub">${esc(e.paidOn)}</div>` : ''}${off ? '<div><span class="pill off">Not counted</span></div>' : ''}</td><td class="sub">${esc(e.note)}</td><td class="num">${money(e.amount, e.currency)}</td><td class="num sub">${e.currency === 'USD' ? ngnExact(e.fxRate) : '–'}</td><td class="num">${ngnExact(e.ngn)}</td><td>${filesCell('entry', e, e.paymentUrl, `${s?.name || 'Bill'}, ${monthLabel(e.period)}`)}</td><td class="nowrap"><button class="ghost" data-count="${esc(e.id)}" title="${off ? 'Add this bill back into the totals' : 'Keep this bill in the ledger but leave it out of the totals'}">${off ? 'Count it' : "Don't count"}</button><button class="ghost" data-edit-entry="${esc(e.id)}">Edit</button><button class="ghost" data-del-entry="${esc(e.id)}">Delete</button></td></tr>`;
    }
    const emptyMsg = !state.ready ? 'Loading records…' : filtered && yAll.length ? 'No bills match these filters.' : `No bills recorded for ${state.year} yet. "Record a month" fills in every active service at once.`;
    $('ledgerBody').innerHTML = html || `<tr><td colspan="9" class="empty">${emptyMsg}</td></tr>`;
    const shownTotal = sumKobo(shownCounted), shownDue = sumKobo(shownCounted.filter((e) => e.status === 'DUE'));
    const usd = shownCounted.filter((e) => e.currency === 'USD').length;
    const leftNote = shownLeft.length ? `<div class="sub">${plural(shownLeft.length, 'bill', 'bills')} not counted (${ngnExact(sumKobo(shownLeft))}) left out</div>` : '';
    $('ledgerFoot').innerHTML = shown.length ? `<tr class="total-row"><td colspan="6">Total, ${plural(shownCounted.length, 'bill', 'bills')}${filtered ? ' shown' : ` in ${state.year}`}${shownDue ? `<div class="sub">${ngnExact(shownTotal - shownDue)} paid + ${ngnExact(shownDue)} due</div>` : ''}${leftNote}</td><td class="num">${ngnExact(shownTotal)}</td><td colspan="2"></td></tr>
      <tr><td colspan="9" class="sub how">How it adds up: the total is the "In naira" column added together, paid and due bills both${shownLeft.length ? ', except bills marked "Not counted"' : ''}. ${usd ? `Dollar bills are converted at the rate saved on each bill (the Rate column), not today's rate, so a dollar amount times the default rate at the top won't match.` : ''}</td></tr>` : '';

    const svcs = [...state.services].sort((a, b) => (a.status === b.status ? 0 : a.status === 'ACTIVE' ? -1 : 1) || prioRank(a.priority) - prioRank(b.priority) || CATS.indexOf(a.category) - CATS.indexOf(b.category) || a.name.localeCompare(b.name));
    $('svcBody').innerHTML = svcs.length ? svcs.map((s) => {
      const cls = s.status !== 'ACTIVE' ? 'off' : s.billing === 'USAGE' ? 'usage' : '';
      return `<tr><td><strong>${esc(s.name)}</strong><div class="sub">${esc(s.category)}</div></td><td>${prioPill(s.priority)}</td><td>${clamp(`${esc(s.usedFor)}${s.notes ? `<div class="sub">${esc(s.notes)}</div>` : ''}`, `use:${s.id}`)}</td><td>${esc(s.plan)}</td><td><span class="pill ${cls}">${s.status !== 'ACTIVE' ? 'Cancelled' : BILL_LABEL[s.billing]}</span>${s.renewsOn ? `<div class="sub">renews ${esc(s.renewsOn)}</div>` : ''}</td><td class="num">${s.billing === 'FREE' || !s.price ? '–' : money(s.price, s.currency)}</td><td class="num">${notSpread(s) ? '–<div class="sub">once a year</div>' : ngn(monthlyEquiv(s))}${s.billing === 'YEARLY' && s.status === 'ACTIVE' ? `<div><button class="linkish" data-spread="${esc(s.id)}">${notSpread(s) ? 'Spread monthly' : "Don't spread"}</button></div>` : ''}</td><td class="sub">${clamp(esc(s.nextTier), `next:${s.id}`)}</td><td>${filesCell('service', s, s.paymentUrl, s.name)}</td><td class="nowrap"><button class="ghost" data-edit-svc="${esc(s.id)}">Edit</button><button class="ghost" data-del-svc="${esc(s.id)}">Delete</button></td></tr>`;
    }).join('') : `<tr><td colspan="10" class="empty">${state.ready ? 'No services yet. Add the first one.' : 'Loading services…'}</td></tr>`;
    requestAnimationFrame(markClamps);
  }

  function drawChart(byMonth) {
    const W = 640, H = 230, L = 58, R = 8, T = 12, B = 26, ch = H - T - B, cw = W - L - R;
    const max = Math.max(...byMonth, 0);
    const step = niceStep(max / 4 || 1);
    const top = Math.max(step * 4, step * Math.ceil(max / step));
    const nowY = new Date().getFullYear(), nowM = new Date().getMonth();
    let s = '';
    for (let v = 0; v <= top + 1e-6; v += step) { const y = T + ch - (v / top) * ch; s += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="1"/><text x="${L - 6}" y="${y + 4}" text-anchor="end">${short(v)}</text>`; }
    const bw = cw / 12;
    byMonth.forEach((v, i) => {
      const h = top ? (v / top) * ch : 0, x = L + i * bw + bw * 0.18;
      const future = state.year > nowY || (state.year === nowY && i > nowM);
      s += `<rect x="${x}" y="${T + ch - h}" width="${bw * 0.64}" height="${Math.max(h, 0)}" rx="2" fill="var(--bar)"><title>${MONTHS[i]} ${state.year}: ${ngn(v)}</title></rect>`;
      if (!v && !future) s += `<rect x="${x}" y="${T + ch - 2}" width="${bw * 0.64}" height="2" fill="var(--bar-dim)"/>`;
      s += `<text x="${L + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle"${future ? ' opacity=".5"' : ''}>${MONTHS[i]}</text>`;
    });
    $('chart').innerHTML = s;
    $('chartSub').textContent = state.year + ' · naira';
  }
  function niceStep(x) { const p = Math.pow(10, Math.floor(Math.log10(x))); const n = x / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
  function short(v) { if (v >= 1e6) return '₦' + (v / 1e6).toFixed(v % 1e6 ? 1 : 0) + 'm'; if (v >= 1e3) return '₦' + (v / 1e3).toFixed(v % 1e3 ? 1 : 0) + 'k'; return '₦' + Math.round(v); }

  function showErr(id, msg) { $(id).textContent = msg || ''; $(id).hidden = !msg; }

  // ---------- screenshots in the edit forms ----------
  // Each form keeps the files picked or pasted so far; they upload after the service or bill is saved.
  const pending = { e: [], s: [] };
  const removed = { e: [], s: [] };
  let previewUrls = [];

  function addFiles(pre, files, errId) {
    for (const f of files) {
      if (!IMAGE_TYPES.includes(f.type)) { showErr(errId, `${f.name || 'That file'} isn't a PNG, JPEG, WebP or GIF image.`); continue; }
      if (f.size > MAX_BYTES) { showErr(errId, `${f.name || 'That image'} is over 5 MB. Crop it or save it as JPEG.`); continue; }
      pending[pre].push(f);
    }
    drawThumbs(pre);
  }
  function drawThumbs(pre) {
    const editing = pre === 'e' ? editingEntry : editingSvc;
    const saved = editing ? filesOf(pre === 'e' ? 'entry' : 'service', editing.id).filter((a) => !removed[pre].includes(a.id)) : [];
    previewUrls.forEach((u) => URL.revokeObjectURL(u));
    previewUrls = [];
    const items = [];
    const html = saved.map((a) => { const i = items.push({ src: fileUrl(a.id), caption: a.filename, meta: 'saved' }) - 1; return `<div class="thumb"><img src="${fileUrl(a.id)}" alt="${esc(a.filename)}" data-lb="form:${pre}" data-i="${i}"><button type="button" class="x" data-unsave="${pre}:${esc(a.id)}" aria-label="Remove ${esc(a.filename)}">×</button></div>`; })
      .concat(pending[pre].map((f, j) => { const u = URL.createObjectURL(f); previewUrls.push(u); const i = items.push({ src: u, caption: f.name, meta: 'uploads when you save' }) - 1; return `<div class="thumb pending" title="Uploads when you save"><img src="${u}" alt="${esc(f.name)}" data-lb="form:${pre}" data-i="${i}"><button type="button" class="x" data-unpend="${pre}:${j}" aria-label="Remove ${esc(f.name)}">×</button></div>`; }));
    lbGroups['form:' + pre] = { title: 'Screenshots', items };
    $(pre + 'Thumbs').innerHTML = html.join('');
    $(pre + 'Shots').hidden = !state.uploadsEnabled;
  }
  async function syncFiles(pre, ownerType, ownerId) {
    for (const id of removed[pre]) await call('DELETE', fileUrl(id));
    for (const f of pending[pre]) {
      await call('POST', `/api/attachments?ownerType=${ownerType}&ownerId=${encodeURIComponent(ownerId)}`, null,
        { headers: { 'Content-Type': f.type, 'X-Filename': encodeURIComponent(f.name || 'screenshot') }, body: f });
    }
    pending[pre] = []; removed[pre] = [];
  }
  ['e', 's'].forEach((pre) => {
    const errId = pre === 'e' ? 'entryErr' : 'svcErr';
    $(pre + 'Files').addEventListener('change', (ev) => { showErr(errId); addFiles(pre, [...ev.target.files], errId); ev.target.value = ''; });
    // Paste a screenshot straight from the clipboard while the form is open.
    $(pre === 'e' ? 'entryDlg' : 'svcDlg').addEventListener('paste', (ev) => {
      if (!state.uploadsEnabled) return;
      const imgs = [...(ev.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (!imgs.length) return;
      ev.preventDefault(); showErr(errId);
      addFiles(pre, imgs.map((f, i) => new File([f], f.name && f.name !== 'image.png' ? f.name : `pasted-${Date.now()}-${i}.png`, { type: f.type })), errId);
    });
    $(pre === 'e' ? 'entryDlg' : 'svcDlg').addEventListener('close', () => { pending[pre] = []; removed[pre] = []; previewUrls.forEach((u) => URL.revokeObjectURL(u)); previewUrls = []; });
  });

  // Lightbox: one image at a time, with previous/next, arrow keys, Esc or a click outside to close.
  const lb = { items: [], i: 0, title: '' };
  function showLb() {
    const it = lb.items[lb.i];
    $('lbImg').src = it.src; $('lbImg').alt = it.caption;
    $('lbTitle').textContent = lb.title;
    $('lbCaption').textContent = it.caption + (it.meta ? ' · ' + it.meta : '');
    $('lbCount').textContent = lb.items.length > 1 ? `${lb.i + 1} of ${lb.items.length}` : '';
    $('lbPrev').hidden = $('lbNext').hidden = lb.items.length < 2;
    $('lbOpen').href = it.src; $('lbOpen').hidden = it.src.startsWith('blob:');
  }
  function openLightbox(key, i) {
    const g = lbGroups[key];
    if (!g || !g.items.length) return;
    Object.assign(lb, { items: g.items, i: Math.min(+i || 0, g.items.length - 1), title: g.title });
    showLb();
    if (!$('lightbox').open) $('lightbox').showModal();
  }
  const stepLb = (d) => { lb.i = (lb.i + d + lb.items.length) % lb.items.length; showLb(); };
  $('lbPrev').addEventListener('click', () => stepLb(-1));
  $('lbNext').addEventListener('click', () => stepLb(1));
  $('lightbox').addEventListener('keydown', (ev) => { if (ev.key === 'ArrowLeft') stepLb(-1); if (ev.key === 'ArrowRight') stepLb(1); });
  // A click on the dark area around the image (the dialog itself) closes it.
  $('lightbox').addEventListener('click', (ev) => { if (ev.target === $('lightbox') || ev.target.classList.contains('lb-stage')) $('lightbox').close(); });
  $('lightbox').addEventListener('close', () => { $('lbImg').removeAttribute('src'); });

  // ---------- dialogs ----------
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $('sCat').innerHTML = CATS.map((c) => `<option>${c}</option>`).join('');
  let editingEntry = null, editingSvc = null;
  const svcOptions = (sel) => [...state.services].sort((a, b) => a.name.localeCompare(b.name)).map((s) => `<option value="${esc(s.id)}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}${s.status !== 'ACTIVE' ? ' (cancelled)' : ''}</option>`).join('');
  function updNgn() { $('eNgn').value = ngnExact(toNgn(numOf($('eAmt')), $('eCur').value, numOf($('eFx')))); $('eFx').disabled = $('eCur').value !== 'USD'; $('eAmtSym').textContent = sym($('eCur').value); }
  ['eAmt', 'eCur', 'eFx'].forEach((id) => $(id).addEventListener('input', updNgn));
  $('sCur').addEventListener('change', () => { $('sPriceSym').textContent = sym($('sCur').value); syncSpread(); });
  // The "spread over 12 months" choice only applies to yearly services.
  function syncSpread() {
    const yearly = $('sBill').value === 'YEARLY';
    $('sSpreadField').hidden = !yearly;
    const p = Number(numOf($('sPrice'))) || 0;
    $('sSpreadHint').textContent = yearly && p ? `(${money(p / 12, $('sCur').value)} a month in the run-rate)` : '';
  }
  $('sBill').addEventListener('change', syncSpread);
  $('sPrice').addEventListener('input', syncSpread);
  $('eSvc').addEventListener('change', () => {
    if (editingEntry) return;
    const s = svcById($('eSvc').value);
    if (s) { $('eCur').value = s.currency; if (s.billing !== 'USAGE' && s.price) setMoney($('eAmt'), s.price); $('ePrio').value = s.priority || 'MEDIUM'; $('eLink').value = s.paymentUrl || ''; updNgn(); }
  });
  function openEntry(e, preset) {
    editingEntry = e || null; showErr('entryErr'); pending.e = []; removed.e = [];
    $('entryTitle').textContent = e ? 'Edit entry' : 'Add entry';
    $('eSvc').innerHTML = svcOptions(e?.serviceId);
    const s = svcById($('eSvc').value);
    $('eMonth').value = e?.period || curMonth(); $('ePaid').value = e?.paidOn || '';
    setMoney($('eAmt'), e?.amount ?? ''); $('eCur').value = e?.currency || s?.currency || 'USD';
    setMoney($('eFx'), e?.currency === 'USD' ? e.fxRate : fx()); $('eNote').value = e?.note || '';
    $('ePrio').value = e?.priority || s?.priority || 'MEDIUM';
    $('eStatus').value = e?.status || preset?.status || 'PAID';
    $('eLink').value = e ? e.paymentUrl || '' : s?.paymentUrl || '';
    $('eCounted').checked = e ? e.counted !== false : true;
    updNgn(); drawThumbs('e'); $('entryDlg').showModal();
  }
  $('entryForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = { serviceId: $('eSvc').value, period: $('eMonth').value, paidOn: $('ePaid').value, amount: numOf($('eAmt')), currency: $('eCur').value, fxRate: numOf($('eFx')) || fx(), note: $('eNote').value, priority: $('ePrio').value, status: $('eStatus').value, paymentUrl: $('eLink').value, counted: $('eCounted').checked };
    let id = editingEntry?.id;
    try {
      if (editingEntry) await call('PUT', '/api/entries/' + encodeURIComponent(id), body);
      else id = (await call('POST', '/api/entries', body)).ids[0];
    } catch (e) { showErr('entryErr', e.message); return; }
    try { await syncFiles('e', 'entry', id); } catch (e) { toast('Entry saved, but a screenshot failed: ' + e.message); }
    $('entryDlg').close(); state.year = +body.period.slice(0, 4); toast('Entry saved'); load();
  });

  function openSvc(s) {
    editingSvc = s || null; showErr('svcErr'); pending.s = []; removed.s = [];
    $('svcTitle').textContent = s ? 'Edit service' : 'Add service';
    $('sName').value = s?.name || ''; $('sCat').value = s?.category || 'Other'; $('sUse').value = s?.usedFor || ''; $('sPlan').value = s?.plan || '';
    $('sBill').value = s?.billing || 'MONTHLY'; setMoney($('sPrice'), s?.price ?? ''); $('sCur').value = s?.currency || 'USD'; $('sRenew').value = s?.renewsOn || '';
    $('sStatus').value = s?.status || 'ACTIVE'; $('sNext').value = s?.nextTier || ''; $('sNotes').value = s?.notes || '';
    $('sSpread').checked = s ? s.spreadMonthly !== false : true; syncSpread();
    $('sPrio').value = s?.priority || 'MEDIUM'; $('sLink').value = s?.paymentUrl || '';
    $('sPriceSym').textContent = sym($('sCur').value);
    drawThumbs('s'); $('svcDlg').showModal();
  }
  $('svcForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = { name: $('sName').value, category: $('sCat').value, usedFor: $('sUse').value, plan: $('sPlan').value, billing: $('sBill').value, price: numOf($('sPrice')) || 0, currency: $('sCur').value, renewsOn: $('sRenew').value, status: $('sStatus').value, nextTier: $('sNext').value, notes: $('sNotes').value, priority: $('sPrio').value, paymentUrl: $('sLink').value, spreadMonthly: $('sSpread').checked };
    let id = editingSvc?.id;
    try {
      if (editingSvc) await call('PUT', '/api/services/' + encodeURIComponent(id), body);
      else id = (await call('POST', '/api/services', body)).id;
    } catch (e) { showErr('svcErr', e.message); return; }
    try { await syncFiles('s', 'service', id); } catch (e) { toast('Service saved, but a screenshot failed: ' + e.message); }
    $('svcDlg').close(); toast('Service saved'); load();
  });

  function fillRec() {
    const p = $('rMonth').value;
    const done = new Set(state.entries.filter((e) => e.period === p).map((e) => e.serviceId));
    const list = state.services.filter((s) => s.status === 'ACTIVE').sort((a, b) => prioRank(a.priority) - prioRank(b.priority) || CATS.indexOf(a.category) - CATS.indexOf(b.category) || a.name.localeCompare(b.name));
    $('recList').innerHTML = list.map((s) => {
      const pre = s.billing === 'MONTHLY' && s.price ? s.price : '';
      const hint = s.billing === 'USAGE' ? ' · usage, enter the bill' : s.billing === 'YEARLY' ? ' · yearly, enter only in the month you pay' : '';
      return `<div class="rec-row"><div>${prioPill(s.priority)} <strong>${esc(s.name)}</strong> <span class="sub">${esc(s.plan)}${hint}</span>${done.has(s.id) ? '<div class="sub warn-text">Already recorded for this month</div>' : ''}</div><span class="money-field"><span class="cur">${sym(s.currency)}</span><input class="mono money" type="text" inputmode="decimal" autocomplete="off" data-rec="${esc(s.id)}" value="${done.has(s.id) || pre === '' ? '' : groupDigits(String(pre))}" placeholder="–" aria-label="${esc(s.name)} amount in ${esc(s.currency)}"></span><span class="sub mono">${esc(s.currency)}</span></div>`;
    }).join('') || '<p class="sub">Add services first.</p>';
  }
  $('recordBtn').addEventListener('click', () => { showErr('recErr'); $('rMonth').value = curMonth(); setMoney($('rFx'), fx()); $('rStatus').value = 'PAID'; fillRec(); $('recDlg').showModal(); });
  $('rMonth').addEventListener('change', fillRec);
  $('recForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const p = $('rMonth').value, rate = numOf($('rFx')) || fx(), status = $('rStatus').value;
    // Each bill starts with its service's priority and payment page.
    const entries = [...$('recList').querySelectorAll('[data-rec]')].filter((i) => numOf(i) !== '').map((i) => { const s = svcById(i.dataset.rec); return { serviceId: s.id, period: p, amount: numOf(i), currency: s.currency, fxRate: rate, priority: s.priority, paymentUrl: s.paymentUrl, status }; });
    if (!entries.length) { showErr('recErr', 'Fill in at least one amount.'); return; }
    try {
      const r = await call('POST', '/api/entries', { entries });
      $('recDlg').close(); state.year = +p.slice(0, 4); toast(`${r.count} ${r.count === 1 ? 'entry' : 'entries'} saved for ${monthLabel(p)}`); load();
    } catch (e) { showErr('recErr', e.message); }
  });

  async function toggleSpread(id) {
    const s = svcById(id);
    if (!s) return;
    const next = s.spreadMonthly === false;
    try {
      await call('PUT', '/api/services/' + encodeURIComponent(id), { ...s, spreadMonthly: next });
      toast(next ? `${s.name} spread over 12 months again` : `${s.name} left out of the monthly run-rate`); load();
    } catch (err) { toast(err.message); }
  }
  async function toggleCounted(id) {
    const e = state.entries.find((x) => x.id === id);
    if (!e) return;
    const next = e.counted === false;
    try {
      await call('PUT', '/api/entries/' + encodeURIComponent(id), { ...e, counted: next });
      toast(next ? 'Bill counted in totals again' : 'Bill left out of totals'); load();
    } catch (err) { toast(err.message); }
  }
  async function markPaid(id) {
    const e = state.entries.find((x) => x.id === id);
    if (!e) return;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
    try {
      await call('PUT', '/api/entries/' + encodeURIComponent(id), { ...e, status: 'PAID', paidOn: e.paidOn || today });
      toast('Marked as paid'); load();
    } catch (err) { toast(err.message); }
  }

  // Row actions. Delete needs a second click within 3 seconds.
  let armed = null;
  document.addEventListener('click', async (ev) => {
    const lbEl = ev.target.closest('[data-lb]');
    if (lbEl) { ev.preventDefault(); openLightbox(lbEl.dataset.lb, lbEl.dataset.i); return; }
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.tab) {
      state.tab = b.dataset.tab;
      document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === b)));
      ['ledger', 'services', 'activity'].forEach((t) => { $('view-' + t).hidden = state.tab !== t; });
      if (state.tab === 'activity') loadAudit();
      if (state.tab === 'services') requestAnimationFrame(markClamps);
      return;
    }
    if (b.dataset.unpend) { const [pre, i] = b.dataset.unpend.split(':'); pending[pre].splice(+i, 1); drawThumbs(pre); return; }
    if (b.dataset.unsave) { const [pre, id] = b.dataset.unsave.split(':'); removed[pre].push(id); drawThumbs(pre); return; }
    if (b.dataset.more) {
      const key = b.dataset.more, box = b.closest('.clamp');
      if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
      box.classList.toggle('open', expanded.has(key));
      b.textContent = expanded.has(key) ? 'Show less' : 'Read more';
      return;
    }
    if (b.dataset.markPaid) return markPaid(b.dataset.markPaid);
    if (b.dataset.count) return toggleCounted(b.dataset.count);
    if (b.dataset.spread) return toggleSpread(b.dataset.spread);
    if (b.dataset.editEntry) return openEntry(state.entries.find((e) => e.id === b.dataset.editEntry));
    if (b.dataset.editSvc) return openSvc(svcById(b.dataset.editSvc));
    const del = b.dataset.delEntry ? ['entries', b.dataset.delEntry] : b.dataset.delSvc ? ['services', b.dataset.delSvc] : null;
    if (!del) return;
    if (armed !== b) {
      if (armed) armed.textContent = 'Delete';
      armed = b; b.textContent = 'Confirm';
      setTimeout(() => { if (armed === b) { b.textContent = 'Delete'; armed = null; } }, 3000);
      return;
    }
    armed = null;
    try { await call('DELETE', `/api/${del[0]}/${encodeURIComponent(del[1])}`); toast('Deleted'); load(); } catch (e) { toast(e.message); b.textContent = 'Delete'; }
  });
  $('addEntryBtn').addEventListener('click', () => openEntry());
  $('addSvcBtn').addEventListener('click', () => openSvc());
  $('yearSel').addEventListener('change', (e) => { state.year = +e.target.value; render(); });
  $('prioFilter').addEventListener('change', (e) => { state.prio = e.target.value; render(); });
  $('statusFilter').addEventListener('change', (e) => { state.status = e.target.value; render(); });
  let fxTimer;
  $('fxInput').addEventListener('input', (e) => {
    const v = Number(numOf(e.target));
    if (!(v > 0)) return;
    state.fxRate = v; render();
    clearTimeout(fxTimer);
    fxTimer = setTimeout(() => call('PUT', '/api/settings', { fxRate: v }).then(() => toast('Default rate saved')).catch((err) => toast(err.message)), 900);
  });

  $('exportBtn').addEventListener('click', () => {
    const rows = [['Month', 'Service', 'Category', 'Priority', 'Status', 'Paid on', 'Amount', 'Currency', 'NGN per USD', 'Amount (NGN)', 'Note', 'Payment link', 'Screenshots', 'Counted in totals', 'Recorded by']];
    state.entries.filter((e) => e.period.startsWith(state.year + '-')).sort((a, b) => a.period.localeCompare(b.period)).forEach((e) => {
      const s = svcById(e.serviceId);
      rows.push([e.period, s?.name || '', s?.category || '', PRIO_LABEL[e.priority] || e.priority, e.status === 'DUE' ? 'Due' : 'Paid', e.paidOn, e.amount, e.currency, e.currency === 'USD' ? e.fxRate : '', e.ngn, e.note, e.paymentUrl, filesOf('entry', e.id).length, e.counted === false ? 'No' : 'Yes', e.createdBy]);
    });
    // Leading =, +, - or @ would run as a formula in Excel; prefix those with a quote.
    const cell = (c) => { c = String(c ?? ''); if (/^[=+\-@]/.test(c) && isNaN(Number(c))) c = "'" + c; return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; };
    const csv = rows.map((r) => r.map(cell).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `zyria-infra-costs-${state.year}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  render();
  load();
})();
