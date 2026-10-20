(function () {
  'use strict';
  const CATS = ['Hosting', 'Database', 'Storage & media', 'Email', 'Monitoring', 'Cache & rate limits', 'Domain & DNS', 'AI', 'Payments', 'Logistics', 'Dev tools', 'Other'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const BILL_LABEL = { MONTHLY: 'Monthly', YEARLY: 'Yearly', USAGE: 'Usage', FREE: 'Free' };
  const ACTION_LABEL = { SETTINGS_FX: 'Changed default rate', SERVICE_CREATED: 'Added service', SERVICE_UPDATED: 'Edited service', SERVICE_DELETED: 'Deleted service', ENTRIES_CREATED: 'Recorded bills', ENTRY_UPDATED: 'Edited bill', ENTRY_DELETED: 'Deleted bill' };
  const state = { services: [], entries: [], fxRate: 1335, me: '', ready: false, year: new Date().getFullYear(), tab: 'ledger' };
  const $ = (id) => document.getElementById(id);
  const ngnFmt = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 });
  const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
  const ngn = (v) => ngnFmt.format(Math.round(v || 0)).replace('NGN', '₦');
  const money = (v, c) => (c === 'USD' ? usdFmt.format(v || 0) : ngn(v));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fx = () => Number(state.fxRate) || 1335;
  const toNgn = (amt, cur, rate) => (cur === 'USD' ? Number(amt || 0) * (Number(rate) || fx()) : Number(amt || 0));
  const monthLabel = (p) => { const [y, m] = p.split('-'); return MONTHS[+m - 1] + ' ' + y; };
  const svcById = (id) => state.services.find((s) => s.id === id);
  const curMonth = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };

  function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2400); }

  async function call(method, path, body) {
    const res = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 && !data.error) { location.reload(); throw new Error('Your sign-in expired.'); }
    if (!res.ok) throw new Error(data.error || 'Could not save. Try again.');
    return data;
  }
  async function load() {
    try {
      const d = await call('GET', '/api/state');
      Object.assign(state, { services: d.services, entries: d.entries, fxRate: d.fxRate, me: d.me, ready: true });
      $('whoami').textContent = 'Signed in as ' + d.me;
      $('notice').hidden = true;
    } catch (e) { $('notice').hidden = false; $('notice').textContent = e.message; }
    render();
  }
  async function loadAudit() {
    try {
      const d = await call('GET', '/api/audit');
      $('auditBody').innerHTML = d.audit.length ? d.audit.map((a) => `<tr><td class="mono">${esc(new Date(a.at).toLocaleString('en-GB', { timeZone: 'Africa/Lagos' }))}</td><td>${esc(a.email)}</td><td>${esc(ACTION_LABEL[a.action] || a.action)}</td><td class="sub">${esc(a.detail)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">No changes yet.</td></tr>';
    } catch (e) { $('auditBody').innerHTML = `<tr><td colspan="4" class="empty">${esc(e.message)}</td></tr>`; }
  }

  function monthlyEquiv(s) {
    if (s.status !== 'ACTIVE' || s.billing === 'FREE') return 0;
    const p = Number(s.price) || 0;
    return toNgn(s.billing === 'YEARLY' ? p / 12 : p, s.currency);
  }

  function render() {
    const years = new Set([new Date().getFullYear(), state.year]);
    state.entries.forEach((e) => years.add(+e.period.slice(0, 4)));
    $('yearSel').innerHTML = [...years].sort((a, b) => b - a).map((y) => `<option ${y === state.year ? 'selected' : ''}>${y}</option>`).join('');
    if (document.activeElement !== $('fxInput')) $('fxInput').value = fx();

    const yE = state.entries.filter((e) => e.period.startsWith(state.year + '-'));
    const total = yE.reduce((a, e) => a + (e.ngn || 0), 0);
    const byMonth = Array(12).fill(0);
    yE.forEach((e) => { byMonth[+e.period.slice(5, 7) - 1] += e.ngn || 0; });
    const recMonths = new Set(yE.map((e) => e.period)).size;
    const run = state.services.reduce((a, s) => a + monthlyEquiv(s), 0);
    const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
    $('kTotalLbl').textContent = 'Total spent in ' + state.year;
    $('kTotal').textContent = ngn(total);
    $('kTotalSub').textContent = plural(yE.length, 'entry', 'entries') + ' across ' + plural(recMonths, 'month', 'months');
    $('kAvg').textContent = ngn(recMonths ? total / recMonths : 0);
    $('kAvgSub').textContent = recMonths ? 'over ' + plural(recMonths, 'recorded month', 'recorded months') : 'nothing recorded yet';
    $('kRun').textContent = ngn(run);
    const usage = state.services.filter((s) => s.status === 'ACTIVE' && s.billing === 'USAGE').length;
    $('kRunSub').textContent = usage ? 'plus ' + plural(usage, 'usage-billed service', 'usage-billed services') : 'from active services';
    $('kYear').textContent = ngn(run * 12);

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

    const sorted = [...yE].sort((a, b) => b.period.localeCompare(a.period) || (svcById(a.serviceId)?.name || '').localeCompare(svcById(b.serviceId)?.name || ''));
    $('ledgerSub').textContent = sorted.length ? `${state.year}: ${plural(sorted.length, 'entry', 'entries')}` : '';
    let html = '', cur = '';
    for (const e of sorted) {
      if (e.period !== cur) { cur = e.period; html += `<tr class="month-row"><td colspan="5">${monthLabel(cur)}</td><td class="num">${ngn(byMonth[+cur.slice(5, 7) - 1])}</td><td></td></tr>`; }
      const s = svcById(e.serviceId);
      html += `<tr><td class="sub">${esc(e.paidOn)}</td><td>${esc(s?.name || 'Removed service')}<div class="sub">${esc(s?.category || '')}</div></td><td class="sub">${esc(e.note)}</td><td class="num">${money(e.amount, e.currency)}</td><td class="num sub">${e.currency === 'USD' ? '₦' + Number(e.fxRate).toLocaleString('en-NG') : '–'}</td><td class="num">${ngn(e.ngn)}</td><td class="nowrap"><button class="ghost" data-edit-entry="${esc(e.id)}">Edit</button><button class="ghost" data-del-entry="${esc(e.id)}">Delete</button></td></tr>`;
    }
    $('ledgerBody').innerHTML = html || `<tr><td colspan="7" class="empty">${state.ready ? `No bills recorded for ${state.year} yet. "Record a month" fills in every active service at once.` : 'Loading records…'}</td></tr>`;

    const svcs = [...state.services].sort((a, b) => (a.status === b.status ? 0 : a.status === 'ACTIVE' ? -1 : 1) || CATS.indexOf(a.category) - CATS.indexOf(b.category) || a.name.localeCompare(b.name));
    $('svcBody').innerHTML = svcs.length ? svcs.map((s) => {
      const cls = s.status !== 'ACTIVE' ? 'off' : s.billing === 'USAGE' ? 'usage' : '';
      return `<tr><td><strong>${esc(s.name)}</strong><div class="sub">${esc(s.category)}</div></td><td>${esc(s.usedFor)}${s.notes ? `<div class="sub">${esc(s.notes)}</div>` : ''}</td><td>${esc(s.plan)}</td><td><span class="pill ${cls}">${s.status !== 'ACTIVE' ? 'Cancelled' : BILL_LABEL[s.billing]}</span>${s.renewsOn ? `<div class="sub">renews ${esc(s.renewsOn)}</div>` : ''}</td><td class="num">${s.billing === 'FREE' || !s.price ? '–' : money(s.price, s.currency)}</td><td class="num">${ngn(monthlyEquiv(s))}</td><td class="sub">${esc(s.nextTier)}</td><td class="nowrap"><button class="ghost" data-edit-svc="${esc(s.id)}">Edit</button><button class="ghost" data-del-svc="${esc(s.id)}">Delete</button></td></tr>`;
    }).join('') : `<tr><td colspan="8" class="empty">${state.ready ? 'No services yet. Add the first one.' : 'Loading services…'}</td></tr>`;
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

  // ---------- dialogs ----------
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $('sCat').innerHTML = CATS.map((c) => `<option>${c}</option>`).join('');
  let editingEntry = null, editingSvc = null;
  const svcOptions = (sel) => [...state.services].sort((a, b) => a.name.localeCompare(b.name)).map((s) => `<option value="${esc(s.id)}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}${s.status !== 'ACTIVE' ? ' (cancelled)' : ''}</option>`).join('');
  function updNgn() { $('eNgn').value = ngn(toNgn($('eAmt').value, $('eCur').value, $('eFx').value)); $('eFx').disabled = $('eCur').value !== 'USD'; }
  ['eAmt', 'eCur', 'eFx'].forEach((id) => $(id).addEventListener('input', updNgn));
  $('eSvc').addEventListener('change', () => {
    if (editingEntry) return;
    const s = svcById($('eSvc').value);
    if (s) { $('eCur').value = s.currency; if (s.billing !== 'USAGE' && s.price) $('eAmt').value = s.price; updNgn(); }
  });
  function openEntry(e) {
    editingEntry = e || null; showErr('entryErr');
    $('entryTitle').textContent = e ? 'Edit entry' : 'Add entry';
    $('eSvc').innerHTML = svcOptions(e?.serviceId);
    $('eMonth').value = e?.period || curMonth(); $('ePaid').value = e?.paidOn || '';
    $('eAmt').value = e?.amount ?? ''; $('eCur').value = e?.currency || svcById($('eSvc').value)?.currency || 'USD';
    $('eFx').value = e?.currency === 'USD' ? e.fxRate : fx(); $('eNote').value = e?.note || '';
    updNgn(); $('entryDlg').showModal();
  }
  $('entryForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = { serviceId: $('eSvc').value, period: $('eMonth').value, paidOn: $('ePaid').value, amount: $('eAmt').value, currency: $('eCur').value, fxRate: $('eFx').value || fx(), note: $('eNote').value };
    try {
      if (editingEntry) await call('PUT', '/api/entries/' + encodeURIComponent(editingEntry.id), body); else await call('POST', '/api/entries', body);
      $('entryDlg').close(); state.year = +body.period.slice(0, 4); toast('Entry saved'); load();
    } catch (e) { showErr('entryErr', e.message); }
  });

  function openSvc(s) {
    editingSvc = s || null; showErr('svcErr');
    $('svcTitle').textContent = s ? 'Edit service' : 'Add service';
    $('sName').value = s?.name || ''; $('sCat').value = s?.category || 'Other'; $('sUse').value = s?.usedFor || ''; $('sPlan').value = s?.plan || '';
    $('sBill').value = s?.billing || 'MONTHLY'; $('sPrice').value = s?.price ?? ''; $('sCur').value = s?.currency || 'USD'; $('sRenew').value = s?.renewsOn || '';
    $('sStatus').value = s?.status || 'ACTIVE'; $('sNext').value = s?.nextTier || ''; $('sNotes').value = s?.notes || '';
    $('svcDlg').showModal();
  }
  $('svcForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = { name: $('sName').value, category: $('sCat').value, usedFor: $('sUse').value, plan: $('sPlan').value, billing: $('sBill').value, price: $('sPrice').value || 0, currency: $('sCur').value, renewsOn: $('sRenew').value, status: $('sStatus').value, nextTier: $('sNext').value, notes: $('sNotes').value };
    try {
      if (editingSvc) await call('PUT', '/api/services/' + encodeURIComponent(editingSvc.id), body); else await call('POST', '/api/services', body);
      $('svcDlg').close(); toast('Service saved'); load();
    } catch (e) { showErr('svcErr', e.message); }
  });

  function fillRec() {
    const p = $('rMonth').value;
    const done = new Set(state.entries.filter((e) => e.period === p).map((e) => e.serviceId));
    const list = state.services.filter((s) => s.status === 'ACTIVE').sort((a, b) => CATS.indexOf(a.category) - CATS.indexOf(b.category) || a.name.localeCompare(b.name));
    $('recList').innerHTML = list.map((s) => {
      const pre = s.billing === 'MONTHLY' && s.price ? s.price : '';
      const hint = s.billing === 'USAGE' ? ' · usage, enter the bill' : s.billing === 'YEARLY' ? ' · yearly, enter only in the month you pay' : '';
      return `<div class="rec-row"><div><strong>${esc(s.name)}</strong> <span class="sub">${esc(s.plan)}${hint}</span>${done.has(s.id) ? '<div class="sub warn-text">Already recorded for this month</div>' : ''}</div><input class="mono" type="number" step="0.01" min="0" data-rec="${esc(s.id)}" value="${done.has(s.id) ? '' : pre}" placeholder="–" aria-label="${esc(s.name)} amount"><span class="sub mono">${esc(s.currency)}</span></div>`;
    }).join('') || '<p class="sub">Add services first.</p>';
  }
  $('recordBtn').addEventListener('click', () => { showErr('recErr'); $('rMonth').value = curMonth(); $('rFx').value = fx(); fillRec(); $('recDlg').showModal(); });
  $('rMonth').addEventListener('change', fillRec);
  $('recForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const p = $('rMonth').value, rate = $('rFx').value || fx();
    const entries = [...$('recList').querySelectorAll('[data-rec]')].filter((i) => i.value !== '').map((i) => { const s = svcById(i.dataset.rec); return { serviceId: s.id, period: p, amount: i.value, currency: s.currency, fxRate: rate }; });
    if (!entries.length) { showErr('recErr', 'Fill in at least one amount.'); return; }
    try {
      const r = await call('POST', '/api/entries', { entries });
      $('recDlg').close(); state.year = +p.slice(0, 4); toast(`${r.count} ${r.count === 1 ? 'entry' : 'entries'} saved for ${monthLabel(p)}`); load();
    } catch (e) { showErr('recErr', e.message); }
  });

  // Row actions. Delete needs a second click within 3 seconds.
  let armed = null;
  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.tab) {
      state.tab = b.dataset.tab;
      document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === b)));
      ['ledger', 'services', 'activity'].forEach((t) => { $('view-' + t).hidden = state.tab !== t; });
      if (state.tab === 'activity') loadAudit();
      return;
    }
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
  let fxTimer;
  $('fxInput').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (!(v > 0)) return;
    state.fxRate = v; render();
    clearTimeout(fxTimer);
    fxTimer = setTimeout(() => call('PUT', '/api/settings', { fxRate: v }).then(() => toast('Default rate saved')).catch((err) => toast(err.message)), 900);
  });

  $('exportBtn').addEventListener('click', () => {
    const rows = [['Month', 'Service', 'Category', 'Paid on', 'Amount', 'Currency', 'NGN per USD', 'Amount (NGN)', 'Note', 'Recorded by']];
    state.entries.filter((e) => e.period.startsWith(state.year + '-')).sort((a, b) => a.period.localeCompare(b.period)).forEach((e) => {
      const s = svcById(e.serviceId);
      rows.push([e.period, s?.name || '', s?.category || '', e.paidOn, e.amount, e.currency, e.currency === 'USD' ? e.fxRate : '', e.ngn, e.note, e.createdBy]);
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
