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
  const money = (v, c) => (c === 'USD' ? usdFmt.format(v || 0) : ngn(v));
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

  function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); }

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

  // Screenshots count + payment link, shared by the ledger, services table and due list.
  function filesCell(type, item, linkUrl) {
    const n = filesOf(type, item.id).length;
    const link = safeLink(linkUrl);
    const parts = [];
    if (n) parts.push(`<button class="linkish" data-view="${type}:${esc(item.id)}">${n} screenshot${n === 1 ? '' : 's'}</button>`);
    if (link) parts.push(`<a class="linkish" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Payment page</a>`);
    return parts.length ? `<div class="files">${parts.join('<span class="sub">·</span>')}</div>` : '<span class="sub">–</span>';
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
    const dueTotal = yE.filter((e) => e.status === 'DUE').reduce((a, e) => a + (e.ngn || 0), 0);
    $('kTotalLbl').textContent = 'Total costs in ' + state.year;
    $('kTotal').textContent = ngn(total);
    $('kTotalSub').textContent = dueTotal ? `${ngn(dueTotal)} of it still due` : plural(yE.length, 'entry', 'entries') + ' across ' + plural(recMonths, 'month', 'months');
    $('kAvg').textContent = ngn(recMonths ? total / recMonths : 0);
    $('kAvgSub').textContent = recMonths ? 'over ' + plural(recMonths, 'recorded month', 'recorded months') : 'nothing recorded yet';
    $('kRun').textContent = ngn(run);
    const usage = state.services.filter((s) => s.status === 'ACTIVE' && s.billing === 'USAGE').length;
    $('kRunSub').textContent = usage ? 'plus ' + plural(usage, 'usage-billed service', 'usage-billed services') : 'from active services';
    $('kYear').textContent = ngn(run * 12);

    // Due to pay: every unpaid bill, any year, most urgent first.
    const due = state.entries.filter((e) => e.status === 'DUE').sort((a, b) => prioRank(a.priority) - prioRank(b.priority) || a.period.localeCompare(b.period));
    $('duePanel').hidden = !due.length;
    if (due.length) {
      $('dueSub').textContent = `${plural(due.length, 'bill', 'bills')} · ${ngn(due.reduce((a, e) => a + e.ngn, 0))}`;
      $('dueList').innerHTML = due.map((e) => {
        const s = svcById(e.serviceId);
        const link = safeLink(e.paymentUrl || s?.paymentUrl);
        const shots = filesOf('entry', e.id).length + filesOf('service', e.serviceId).length;
        return `<li class="due-item">${prioPill(e.priority)}<div><strong>${esc(s?.name || 'Removed service')}</strong> <span class="sub">${monthLabel(e.period)}${e.note ? ' · ' + esc(e.note) : ''}</span></div><span class="num">${money(e.amount, e.currency)}${e.currency === 'USD' ? ` <span class="sub">${ngn(e.ngn)}</span>` : ''}</span><div class="due-actions">${shots ? `<button data-view-due="${esc(e.id)}">Screenshots</button>` : ''}${link ? `<a class="btn" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open payment page</a>` : ''}<button class="primary" data-mark-paid="${esc(e.id)}">Mark paid</button></div></li>`;
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
    const shown = yE.filter((e) => (!state.prio || e.priority === state.prio) && (!state.status || e.status === state.status));
    const sorted = [...shown].sort((a, b) => b.period.localeCompare(a.period) || prioRank(a.priority) - prioRank(b.priority) || (svcById(a.serviceId)?.name || '').localeCompare(svcById(b.serviceId)?.name || ''));
    const filtered = state.prio || state.status;
    $('ledgerSub').textContent = yE.length ? `${state.year}: ${plural(yE.length, 'entry', 'entries')}${filtered ? `, ${shown.length} shown` : ''}` : '';
    const shownByMonth = {};
    shown.forEach((e) => { shownByMonth[e.period] = (shownByMonth[e.period] || 0) + e.ngn; });
    let html = '', cur = '';
    for (const e of sorted) {
      if (e.period !== cur) { cur = e.period; html += `<tr class="month-row"><td colspan="6">${monthLabel(cur)}</td><td class="num">${ngn(shownByMonth[cur])}</td><td colspan="2"></td></tr>`; }
      const s = svcById(e.serviceId);
      html += `<tr><td>${esc(s?.name || 'Removed service')}<div class="sub">${esc(s?.category || '')}</div></td><td>${prioPill(e.priority)}</td><td><span class="st-${esc(e.status)}">${e.status === 'DUE' ? 'Due' : 'Paid'}</span>${e.paidOn ? `<div class="sub">${esc(e.paidOn)}</div>` : ''}</td><td class="sub">${esc(e.note)}</td><td class="num">${money(e.amount, e.currency)}</td><td class="num sub">${e.currency === 'USD' ? '₦' + Number(e.fxRate).toLocaleString('en-NG') : '–'}</td><td class="num">${ngn(e.ngn)}</td><td>${filesCell('entry', e, e.paymentUrl)}</td><td class="nowrap"><button class="ghost" data-edit-entry="${esc(e.id)}">Edit</button><button class="ghost" data-del-entry="${esc(e.id)}">Delete</button></td></tr>`;
    }
    const emptyMsg = !state.ready ? 'Loading records…' : filtered && yE.length ? 'No bills match these filters.' : `No bills recorded for ${state.year} yet. "Record a month" fills in every active service at once.`;
    $('ledgerBody').innerHTML = html || `<tr><td colspan="9" class="empty">${emptyMsg}</td></tr>`;

    const svcs = [...state.services].sort((a, b) => (a.status === b.status ? 0 : a.status === 'ACTIVE' ? -1 : 1) || prioRank(a.priority) - prioRank(b.priority) || CATS.indexOf(a.category) - CATS.indexOf(b.category) || a.name.localeCompare(b.name));
    $('svcBody').innerHTML = svcs.length ? svcs.map((s) => {
      const cls = s.status !== 'ACTIVE' ? 'off' : s.billing === 'USAGE' ? 'usage' : '';
      return `<tr><td><strong>${esc(s.name)}</strong><div class="sub">${esc(s.category)}</div></td><td>${prioPill(s.priority)}</td><td>${esc(s.usedFor)}${s.notes ? `<div class="sub">${esc(s.notes)}</div>` : ''}</td><td>${esc(s.plan)}</td><td><span class="pill ${cls}">${s.status !== 'ACTIVE' ? 'Cancelled' : BILL_LABEL[s.billing]}</span>${s.renewsOn ? `<div class="sub">renews ${esc(s.renewsOn)}</div>` : ''}</td><td class="num">${s.billing === 'FREE' || !s.price ? '–' : money(s.price, s.currency)}</td><td class="num">${ngn(monthlyEquiv(s))}</td><td class="sub">${esc(s.nextTier)}</td><td>${filesCell('service', s, s.paymentUrl)}</td><td class="nowrap"><button class="ghost" data-edit-svc="${esc(s.id)}">Edit</button><button class="ghost" data-del-svc="${esc(s.id)}">Delete</button></td></tr>`;
    }).join('') : `<tr><td colspan="10" class="empty">${state.ready ? 'No services yet. Add the first one.' : 'Loading services…'}</td></tr>`;
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
    const html = saved.map((a) => `<div class="thumb"><img src="${fileUrl(a.id)}" alt="${esc(a.filename)}" data-open="${esc(a.id)}"><button type="button" class="x" data-unsave="${pre}:${esc(a.id)}" aria-label="Remove ${esc(a.filename)}">×</button></div>`)
      .concat(pending[pre].map((f, i) => { const u = URL.createObjectURL(f); previewUrls.push(u); return `<div class="thumb pending" title="Uploads when you save"><img src="${u}" alt="${esc(f.name)}"><button type="button" class="x" data-unpend="${pre}:${i}" aria-label="Remove ${esc(f.name)}">×</button></div>`; }));
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

  function openViewer(title, list) {
    $('viewTitle').textContent = title;
    $('viewer').innerHTML = list.length ? list.map((a) => `<figure><a href="${fileUrl(a.id)}" target="_blank" rel="noopener"><img src="${fileUrl(a.id)}" alt="${esc(a.filename)}" loading="lazy"></a><figcaption class="sub">${esc(a.filename)} · added by ${esc(a.createdBy)} · ${esc(new Date(a.createdAt).toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos' }))}</figcaption></figure>`).join('') : '<p class="sub">No screenshots yet.</p>';
    $('viewDlg').showModal();
  }

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
    if (s) { $('eCur').value = s.currency; if (s.billing !== 'USAGE' && s.price) $('eAmt').value = s.price; $('ePrio').value = s.priority || 'MEDIUM'; $('eLink').value = s.paymentUrl || ''; updNgn(); }
  });
  function openEntry(e, preset) {
    editingEntry = e || null; showErr('entryErr'); pending.e = []; removed.e = [];
    $('entryTitle').textContent = e ? 'Edit entry' : 'Add entry';
    $('eSvc').innerHTML = svcOptions(e?.serviceId);
    const s = svcById($('eSvc').value);
    $('eMonth').value = e?.period || curMonth(); $('ePaid').value = e?.paidOn || '';
    $('eAmt').value = e?.amount ?? ''; $('eCur').value = e?.currency || s?.currency || 'USD';
    $('eFx').value = e?.currency === 'USD' ? e.fxRate : fx(); $('eNote').value = e?.note || '';
    $('ePrio').value = e?.priority || s?.priority || 'MEDIUM';
    $('eStatus').value = e?.status || preset?.status || 'PAID';
    $('eLink').value = e ? e.paymentUrl || '' : s?.paymentUrl || '';
    updNgn(); drawThumbs('e'); $('entryDlg').showModal();
  }
  $('entryForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = { serviceId: $('eSvc').value, period: $('eMonth').value, paidOn: $('ePaid').value, amount: $('eAmt').value, currency: $('eCur').value, fxRate: $('eFx').value || fx(), note: $('eNote').value, priority: $('ePrio').value, status: $('eStatus').value, paymentUrl: $('eLink').value };
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
    $('sBill').value = s?.billing || 'MONTHLY'; $('sPrice').value = s?.price ?? ''; $('sCur').value = s?.currency || 'USD'; $('sRenew').value = s?.renewsOn || '';
    $('sStatus').value = s?.status || 'ACTIVE'; $('sNext').value = s?.nextTier || ''; $('sNotes').value = s?.notes || '';
    $('sPrio').value = s?.priority || 'MEDIUM'; $('sLink').value = s?.paymentUrl || '';
    drawThumbs('s'); $('svcDlg').showModal();
  }
  $('svcForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = { name: $('sName').value, category: $('sCat').value, usedFor: $('sUse').value, plan: $('sPlan').value, billing: $('sBill').value, price: $('sPrice').value || 0, currency: $('sCur').value, renewsOn: $('sRenew').value, status: $('sStatus').value, nextTier: $('sNext').value, notes: $('sNotes').value, priority: $('sPrio').value, paymentUrl: $('sLink').value };
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
      return `<div class="rec-row"><div>${prioPill(s.priority)} <strong>${esc(s.name)}</strong> <span class="sub">${esc(s.plan)}${hint}</span>${done.has(s.id) ? '<div class="sub warn-text">Already recorded for this month</div>' : ''}</div><input class="mono" type="number" step="0.01" min="0" data-rec="${esc(s.id)}" value="${done.has(s.id) ? '' : pre}" placeholder="–" aria-label="${esc(s.name)} amount"><span class="sub mono">${esc(s.currency)}</span></div>`;
    }).join('') || '<p class="sub">Add services first.</p>';
  }
  $('recordBtn').addEventListener('click', () => { showErr('recErr'); $('rMonth').value = curMonth(); $('rFx').value = fx(); $('rStatus').value = 'PAID'; fillRec(); $('recDlg').showModal(); });
  $('rMonth').addEventListener('change', fillRec);
  $('recForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const p = $('rMonth').value, rate = $('rFx').value || fx(), status = $('rStatus').value;
    // Each bill starts with its service's priority and payment page.
    const entries = [...$('recList').querySelectorAll('[data-rec]')].filter((i) => i.value !== '').map((i) => { const s = svcById(i.dataset.rec); return { serviceId: s.id, period: p, amount: i.value, currency: s.currency, fxRate: rate, priority: s.priority, paymentUrl: s.paymentUrl, status }; });
    if (!entries.length) { showErr('recErr', 'Fill in at least one amount.'); return; }
    try {
      const r = await call('POST', '/api/entries', { entries });
      $('recDlg').close(); state.year = +p.slice(0, 4); toast(`${r.count} ${r.count === 1 ? 'entry' : 'entries'} saved for ${monthLabel(p)}`); load();
    } catch (e) { showErr('recErr', e.message); }
  });

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
    const img = ev.target.closest('img[data-open]');
    if (img) { window.open(fileUrl(img.dataset.open), '_blank', 'noopener'); return; }
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.tab) {
      state.tab = b.dataset.tab;
      document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === b)));
      ['ledger', 'services', 'activity'].forEach((t) => { $('view-' + t).hidden = state.tab !== t; });
      if (state.tab === 'activity') loadAudit();
      return;
    }
    if (b.dataset.unpend) { const [pre, i] = b.dataset.unpend.split(':'); pending[pre].splice(+i, 1); drawThumbs(pre); return; }
    if (b.dataset.unsave) { const [pre, id] = b.dataset.unsave.split(':'); removed[pre].push(id); drawThumbs(pre); return; }
    if (b.dataset.view) {
      const [type, id] = b.dataset.view.split(':');
      const owner = type === 'entry' ? state.entries.find((e) => e.id === id) : svcById(id);
      const name = type === 'entry' ? `${svcById(owner?.serviceId)?.name || 'Bill'}, ${owner ? monthLabel(owner.period) : ''}` : owner?.name || 'Service';
      return openViewer(name, filesOf(type, id));
    }
    if (b.dataset.viewDue) {
      const e = state.entries.find((x) => x.id === b.dataset.viewDue);
      return openViewer(`${svcById(e.serviceId)?.name || 'Bill'}, ${monthLabel(e.period)}`, filesOf('entry', e.id).concat(filesOf('service', e.serviceId)));
    }
    if (b.dataset.markPaid) return markPaid(b.dataset.markPaid);
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
    const v = Number(e.target.value);
    if (!(v > 0)) return;
    state.fxRate = v; render();
    clearTimeout(fxTimer);
    fxTimer = setTimeout(() => call('PUT', '/api/settings', { fxRate: v }).then(() => toast('Default rate saved')).catch((err) => toast(err.message)), 900);
  });

  $('exportBtn').addEventListener('click', () => {
    const rows = [['Month', 'Service', 'Category', 'Priority', 'Status', 'Paid on', 'Amount', 'Currency', 'NGN per USD', 'Amount (NGN)', 'Note', 'Payment link', 'Screenshots', 'Recorded by']];
    state.entries.filter((e) => e.period.startsWith(state.year + '-')).sort((a, b) => a.period.localeCompare(b.period)).forEach((e) => {
      const s = svcById(e.serviceId);
      rows.push([e.period, s?.name || '', s?.category || '', PRIO_LABEL[e.priority] || e.priority, e.status === 'DUE' ? 'Due' : 'Paid', e.paidOn, e.amount, e.currency, e.currency === 'USD' ? e.fxRate : '', e.ngn, e.note, e.paymentUrl, filesOf('entry', e.id).length, e.createdBy]);
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
