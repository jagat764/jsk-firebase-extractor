/*!
 * LinkScope UI — v1.2.0
 * Depends on decoder.js (window.LinkScopeDecoder).
 * All processing is local; no fetch/XHR/WebSocket calls are made.
 */
(function () {
  'use strict';

  var D = window.LinkScopeDecoder;
  var $ = function (id) { return document.getElementById(id); };

  var SAMPLE_LINKS = [
    'https://badgxarmy.netlify.app/?s=aHR0cHM6Ly9hbWFuZ2FuZHUtODg2OTctZGVmYXVsdC1ydGRiLmZpcmViYXNlaW8uY29tfHx8Vnx8fDE3OTMxMDU1MTUwMTU=',
    'https://badgxarmy.netlify.app/?s=aHR0cHM6Ly9jYWxsbWUyLTY4NmM4LWRlZmF1bHQtcnRkYi5maXJlYmFzZWlvLmNvbXx8fEdnfHx8MTc5MzEwNTQ4MjY2NA==',
    'https://badgxarmy.netlify.app/?s=aHR0cHM6Ly9zYW1wbGUtcGlwZS1kZWZhdWx0LXJ0ZGIuZmlyZWJhc2Vpby5jb218S0VZMTIzNDU2fDE3OTMxMDU1MTUwMTV8ZGV2aWNlLTEyMw==',
    'https://vantagepanel.netlify.app/?s=DUMbVltFDQQVHhZWWR4xNRtYAzFVBWNTFCpVAz5CRzpHByQWHz1DPwAkRhYoXxcVDgNWTUUOUltMJCAweBECJGY9EWJVYhUdbg5UEVkEJlYAMl0ddh14B2cPQzw',
    'https://vantagepanel.netlify.app/?m=JTVCJTdCJTIydXJsJTIyJTNBJTIyaHR0cHMlM0ElMkYlMkZtZXJnZWQtYWxwaGEtZGVmYXVsdC1ydGRiLmZpcmViYXNlaW8uY29tJTIyJTJDJTIya2V5JTIyJTNBJTIyS0VZQUxQSEElMjIlN0QlMkMlN0IlMjJ1cmwlMjIlM0ElMjJodHRwcyUzQSUyRiUyRm1lcmdlZC1iZXRhLWRlZmF1bHQtcnRkYi5maXJlYmFzZWlvLmNvbSUyMiUyQyUyMmtleSUyMiUzQSUyMktFWUJFVEElMjIlN0QlNUQ'
  ];

  var MAX_INPUT_CHARS = 1500000;
  var MAX_CANDIDATES = 20000;
  var PAGE_SIZE = 60;

  var STATUS_STYLES = {
    VALID: {
      pill: 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30',
      dot: 'bg-emerald-400',
      icon: 'check',
      iconClass: 'bg-emerald-400/10 text-emerald-300 ring-emerald-400/20'
    },
    EXPIRED: {
      pill: 'bg-rose-500/15 text-rose-300 ring-rose-400/30',
      dot: 'bg-rose-400',
      icon: 'clock',
      iconClass: 'bg-rose-400/10 text-rose-300 ring-rose-400/20'
    },
    NO_FIREBASE: {
      pill: 'bg-amber-500/15 text-amber-300 ring-amber-400/30',
      dot: 'bg-amber-400',
      icon: 'alert',
      iconClass: 'bg-amber-400/10 text-amber-300 ring-amber-400/20'
    },
    INVALID: {
      pill: 'bg-slate-500/15 text-slate-300 ring-slate-400/30',
      dot: 'bg-slate-400',
      icon: 'x',
      iconClass: 'bg-slate-400/10 text-slate-300 ring-slate-400/20'
    }
  };

  var FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'valid', label: 'Valid' },
    { id: 'expired', label: 'Expired' },
    { id: 'issues', label: 'Issues' },
    { id: 'duplicates', label: 'Duplicates' },
    { id: 'no-firebase', label: 'No Firebase' }
  ];

  var state = {
    mode: 'single',
    singleResult: null,
    singleCopyData: {},
    segmentCopyData: [],
    fbCopyData: [],
    bulk: null,
    filter: 'all',
    search: '',
    dedupe: true,
    revealCredential: false,
    visibleCount: PAGE_SIZE
  };

  var singleTimer = null;
  var toastTimer = null;

  function icon(name, cls) {
    return '<svg class="' + (cls || 'h-4 w-4') + '" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function truncate(value, max) {
    var s = String(value == null ? '' : value);
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  async function copyText(text) {
    var value = String(text == null ? '' : text);
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (e) { /* fallback below */ }
    try {
      var ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e2) {
      return false;
    }
  }

  function showToast(message, type) {
    type = type || 'success';
    var toast = $('toast');
    var iconEl = $('toast-icon');
    var map = {
      success: { name: 'check', cls: 'h-4 w-4 text-emerald-300' },
      error: { name: 'alert', cls: 'h-4 w-4 text-rose-300' },
      info: { name: 'info', cls: 'h-4 w-4 text-amber-300' }
    };
    var cfg = map[type] || map.success;
    iconEl.setAttribute('class', cfg.cls);
    iconEl.innerHTML = '<use href="#i-' + cfg.name + '"></use>';
    $('toast-text').textContent = message;
    toast.classList.remove('hidden');
    toast.classList.add('flex');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.classList.add('hidden');
      toast.classList.remove('flex');
    }, 2400);
  }

  function downloadFile(filename, content, mime) {
    try {
      var blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      return true;
    } catch (e) {
      showToast('Download failed in this browser', 'error');
      return false;
    }
  }

  function statusStyle(status) {
    return STATUS_STYLES[status] || STATUS_STYLES.INVALID;
  }

  function setMode(mode) {
    state.mode = mode;
    var singleActive = mode === 'single';
    $('tab-single').className = 'segment-btn ' + (singleActive ? 'segment-active' : '');
    $('tab-bulk').className = 'segment-btn ' + (!singleActive ? 'segment-active' : '');
    $('tab-single').setAttribute('aria-selected', String(singleActive));
    $('tab-bulk').setAttribute('aria-selected', String(!singleActive));
    $('panel-single').classList.toggle('hidden', !singleActive);
    $('panel-bulk').classList.toggle('hidden', singleActive);
    $('bottom-action-label').textContent = singleActive ? 'Decode link' : 'Check all links';

    if (singleActive) {
      $('bulk-result').classList.add('hidden');
      if (state.singleResult) {
        $('single-result').classList.remove('hidden');
        renderSingle();
      }
    } else {
      $('single-result').classList.add('hidden');
      if (state.bulk) {
        $('bulk-result').classList.remove('hidden');
        renderBulk();
      }
    }
  }

  function singleCardHtml(opts) {
    var copyBtn = opts.copyType
      ? '<button type="button" data-copy-single="' + opts.copyType + '" class="mini-btn">' + icon('copy', 'h-3.5 w-3.5') + ' Copy</button>'
      : '';
    var extra = opts.actions || '';
    return '' +
      '<article class="glass-soft p-3.5 sm:p-4">' +
        '<div class="flex items-start justify-between gap-2">' +
          '<div class="flex min-w-0 items-center gap-2">' +
            '<span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset ' + opts.iconClass + '">' + icon(opts.iconName, 'h-4 w-4') + '</span>' +
            '<span class="label mb-0 truncate">' + opts.label + '</span>' +
          '</div>' +
        '</div>' +
        '<p class="mt-3 break-words ' + (opts.mono ? 'break-all font-mono text-[13px] leading-5' : 'text-sm font-semibold') + ' text-slate-100">' + opts.value + '</p>' +
        (opts.sub ? '<p class="mt-1 text-[11px] leading-4 text-slate-500">' + opts.sub + '</p>' : '') +
        ((copyBtn || extra) ? '<div class="mt-3 flex flex-wrap gap-2">' + extra + copyBtn + '</div>' : '') +
      '</article>';
  }

  function segmentRowHtml(seg, index) {
    var value = state.revealCredential ? seg.value : (seg.sensitive ? D.maskSecret(seg.value) : seg.value);
    var secretBadge = seg.sensitive
      ? '<span class="rounded bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-300">secret</span>'
      : '';
    return '' +
      '<div class="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:gap-4">' +
        '<div class="flex min-w-0 items-center gap-2 sm:w-44 sm:shrink-0">' +
          '<span class="font-mono text-[10px] text-slate-600">' + String(index + 1).padStart(2, '0') + '</span>' +
          '<span class="truncate text-xs font-semibold text-slate-300">' + escapeHtml(seg.label) + '</span>' +
          secretBadge +
        '</div>' +
        '<div class="min-w-0 flex-1">' +
          '<p class="break-all font-mono text-[12px] leading-5 ' + (seg.sensitive && !state.revealCredential ? 'text-amber-200' : 'text-slate-200') + '">' + escapeHtml(value) + '</p>' +
          '<p class="mt-0.5 text-[10px] uppercase tracking-wider text-slate-600">' + escapeHtml(seg.kind) + '</p>' +
        '</div>' +
        '<button type="button" data-copy-segment="' + index + '" class="mini-btn self-start">' + icon('copy', 'h-3.5 w-3.5') + ' Copy</button>' +
      '</div>';
  }

  function warningBlockHtml(warnings) {
    if (!warnings.length) return '';
    return '' +
      '<div class="mt-4 rounded-2xl border border-amber-400/15 bg-amber-400/[0.06] p-3">' +
        '<h4 class="flex items-center gap-1.5 text-xs font-bold text-amber-200">' + icon('alert', 'h-3.5 w-3.5') + ' Warnings</h4>' +
        '<ul class="mt-2 space-y-1 text-[11px] leading-5 text-amber-100/80">' +
          warnings.map(function (w) { return '<li>• ' + escapeHtml(w) + '</li>'; }).join('') +
        '</ul>' +
      '</div>';
  }

  function renderSingle() {
    var r = state.singleResult;
    if (!r) return;
    var style = statusStyle(r.status);

    state.singleCopyData = {
      url: r.primaryUrl ? r.primaryUrl.url : '',
      payload: r.resolvedPayload || r.payload || '',
      json: JSON.stringify(r, null, 2),
      credential: r.credential ? r.credential.value : '',
      source: r.source || ''
    };
    state.segmentCopyData = r.segments.map(function (s) { return s.value; });
    state.fbCopyData = r.firebaseUrls.map(function (u) { return u.url; });

    $('single-result').classList.remove('hidden');
    $('single-status-dot').className = 'h-2.5 w-2.5 rounded-full ' + style.dot;
    $('single-status-pill').className = 'rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ring-inset ' + style.pill;
    $('single-status-pill').textContent = r.statusLabel;
    $('single-description').textContent = r.statusDescription;
    $('single-timing').textContent = r.durationMs.toFixed(1) + ' ms · ' + r.sourceTypeLabel;

    var revealBtn = '<button type="button" data-action="reveal-credential" class="mini-btn" aria-label="Toggle credential visibility">' +
      icon(state.revealCredential ? 'eye-off' : 'eye', 'h-3.5 w-3.5') +
      (state.revealCredential ? ' Hide' : ' Reveal') + '</button>';

    var cards = [];
    cards.push(singleCardHtml({
      label: 'Firebase URL',
      value: r.primaryUrl ? escapeHtml(r.primaryUrl.url) : '<span class="text-slate-400">No Firebase URL found</span>',
      sub: r.primaryUrl ? escapeHtml(r.primaryUrl.type + ' · ' + r.primaryUrl.host) : 'Try a full ?s= link, raw Base64, or decoded payload.',
      iconName: 'database',
      iconClass: style.iconClass,
      copyType: r.primaryUrl ? 'url' : null,
      mono: true
    }));
    cards.push(singleCardHtml({
      label: 'Project ID',
      value: escapeHtml(r.projectId || '—'),
      sub: r.primaryUrl ? escapeHtml('Region: ' + r.primaryUrl.region + ' · ' + r.primaryUrl.protocol.toUpperCase()) : 'Extracted from the hostname.',
      iconName: 'layers',
      iconClass: 'bg-indigo-400/10 text-indigo-300 ring-indigo-400/20',
      mono: !!r.projectId
    }));
    cards.push(singleCardHtml({
      label: 'Credential',
      value: r.credential
        ? escapeHtml(state.revealCredential ? r.credential.value : r.credential.masked)
        : '<span class="text-slate-400">Not present</span>',
      sub: r.credential ? escapeHtml(r.credential.type + ' · from ' + r.credential.source) : 'No key or secret field detected.',
      iconName: 'key',
      iconClass: 'bg-amber-400/10 text-amber-300 ring-amber-400/20',
      copyType: r.credential ? 'credential' : null,
      actions: r.credential ? revealBtn : '',
      mono: !!r.credential
    }));
    cards.push(singleCardHtml({
      label: 'Expiry',
      value: r.expiresAt ? escapeHtml(r.expiresAt.local) : '<span class="text-slate-400">No expiry field</span>',
      sub: r.expiresAt ? escapeHtml(r.expiresAt.relative + ' · ' + r.expiresAt.iso) : 'This link may never expire.',
      iconName: 'clock',
      iconClass: r.expiresAt && r.expiresAt.expired ? 'bg-rose-400/10 text-rose-300 ring-rose-400/20' : 'bg-emerald-400/10 text-emerald-300 ring-emerald-400/20'
    }));
    cards.push(singleCardHtml({
      label: 'Device / reference',
      value: escapeHtml(r.deviceId || '—'),
      sub: r.deviceId ? 'Optional field 4 or detected ID.' : 'No device reference found.',
      iconName: 'link',
      iconClass: 'bg-sky-400/10 text-sky-300 ring-sky-400/20',
      mono: !!r.deviceId
    }));
    cards.push(singleCardHtml({
      label: 'Source & encoding',
      value: escapeHtml(r.sourceTypeLabel),
      sub: escapeHtml(r.encoding + ' · ' + plural(r.decodeCount, 'decode layer')),
      iconName: 'bolt',
      iconClass: 'bg-orange-400/10 text-orange-300 ring-orange-400/20'
    }));
    $('single-cards').innerHTML = cards.join('');

    var allUrlsHtml = '';
    if (r.firebaseUrls.length > 1) {
      allUrlsHtml = '' +
        '<div class="mt-4">' +
          '<h4 class="text-xs font-bold text-slate-300">All Firebase endpoints (' + r.firebaseUrls.length + ')</h4>' +
          '<div class="mt-2 space-y-2">' +
            r.firebaseUrls.map(function (u, i) {
              return '<div class="flex items-center gap-2 rounded-xl border border-white/10 bg-slate-950/50 p-2.5">' +
                '<p class="min-w-0 flex-1 break-all font-mono text-[11px] text-slate-300">' + escapeHtml(u.url) + '</p>' +
                '<button type="button" data-copy-fb="' + i + '" class="mini-btn shrink-0">' + icon('copy', 'h-3.5 w-3.5') + '</button>' +
              '</div>';
            }).join('') +
          '</div>' +
        '</div>';
    }

    var messagesHtml = '' +
      '<details class="mt-4">' +
        '<summary class="cursor-pointer list-none text-xs font-semibold text-slate-400 hover:text-slate-200">Inspection notes (' + r.messages.length + ')</summary>' +
        '<ul class="mt-2 space-y-1 text-[11px] leading-5 text-slate-500">' +
          r.messages.map(function (m) { return '<li>• ' + escapeHtml(m) + '</li>'; }).join('') +
        '</ul>' +
      '</details>';

    $('single-breakdown').innerHTML = '' +
      '<div class="flex flex-wrap items-center justify-between gap-2">' +
        '<h3 class="flex items-center gap-2 text-sm font-bold text-white">' + icon('layers', 'h-4 w-4 text-amber-300') + ' Payload breakdown</h3>' +
        '<span class="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-bold text-slate-400">' + plural(r.segments.length, 'field') + '</span>' +
      '</div>' +
      '<div class="mt-3 divide-y divide-white/5 overflow-hidden rounded-2xl border border-white/10 bg-slate-950/40">' +
        (r.segments.length ? r.segments.map(segmentRowHtml).join('') : '<p class="p-4 text-xs text-slate-500">No fields were decoded.</p>') +
      '</div>' +
      allUrlsHtml +
      warningBlockHtml(r.warnings) +
      messagesHtml;

    $('single-raw').innerHTML = '' +
      '<div class="flex flex-wrap items-center justify-between gap-2">' +
        '<h3 class="flex items-center gap-2 text-sm font-bold text-white">' + icon('file', 'h-4 w-4 text-amber-300') + ' Raw decoded payload</h3>' +
        '<div class="flex flex-wrap gap-2">' +
          '<button type="button" data-copy-single="payload" class="mini-btn">' + icon('copy', 'h-3.5 w-3.5') + ' Payload</button>' +
          '<button type="button" data-copy-single="json" class="mini-btn">' + icon('copy', 'h-3.5 w-3.5') + ' JSON</button>' +
          '<button type="button" data-copy-single="source" class="mini-btn">' + icon('copy', 'h-3.5 w-3.5') + ' Source</button>' +
        '</div>' +
      '</div>' +
      '<pre class="code-block mt-3 whitespace-pre-wrap break-all">' + escapeHtml(r.resolvedPayload || '—') + '</pre>' +
      '<div class="mt-3 grid gap-1 text-[11px] text-slate-500 sm:grid-cols-3">' +
        '<p><strong class="text-slate-400">Encoding:</strong> ' + escapeHtml(r.encoding) + '</p>' +
        '<p><strong class="text-slate-400">Layers:</strong> ' + r.decodeCount + '</p>' +
        '<p><strong class="text-slate-400">Checked:</strong> ' + escapeHtml(new Date(r.checkedAt).toLocaleString()) + '</p>' +
      '</div>';
  }

  function clearSingleResult() {
    state.singleResult = null;
    $('single-result').classList.add('hidden');
  }

  function runSingle(opts) {
    var silent = opts && opts.silent;
    var raw = $('single-input').value.trim();
    if (!raw) {
      clearSingleResult();
      if (!silent) showToast('Paste a link first', 'error');
      return;
    }
    try {
      var candidates = D.extractCandidates(raw, { maxChars: MAX_INPUT_CHARS, maxCandidates: MAX_CANDIDATES }).candidates;
      if (candidates.length > 1) {
        $('bulk-input').value = raw;
        updateBulkCount();
        setMode('bulk');
        runBulk();
        if (!silent) showToast('Multiple links detected — switched to Bulk', 'info');
        return;
      }
      var r = D.inspect(raw);
      state.singleResult = r;
      state.revealCredential = false;
      updateRevealButton();
      renderSingle();
      if (!silent) {
        if (r.status === 'VALID') showToast('Link decoded successfully', 'success');
        else if (r.status === 'INVALID') showToast('Could not decode this input', 'error');
        else showToast('Decoded with notes', 'info');
      }
    } catch (e) {
      console.error(e);
      if (!silent) showToast('Decoder error — check the input', 'error');
    }
  }

  function scheduleSingleDecode() {
    clearTimeout(singleTimer);
    singleTimer = setTimeout(function () {
      var raw = $('single-input').value.trim();
      if (raw.length >= 8) runSingle({ silent: true });
    }, 550);
  }

  function updateBulkCount() {
    var value = $('bulk-input').value;
    var lines = value.split(/\r?\n/).filter(function (l) { return l.trim(); }).length;
    var size = 0;
    try { size = new Blob([value]).size; } catch (e) { size = value.length; }
    $('bulk-count').textContent = plural(lines, 'line') + ' · ' + formatBytes(size);
  }

  function matchesFilter(r, filter) {
    switch (filter) {
      case 'valid': return r.status === 'VALID';
      case 'expired': return r.status === 'EXPIRED';
      case 'issues': return r.status === 'EXPIRED' || r.status === 'INVALID' || r.status === 'NO_FIREBASE';
      case 'duplicates': return !!r.duplicate;
      case 'no-firebase': return r.status === 'NO_FIREBASE';
      default: return true;
    }
  }

  function searchHaystack(r) {
    return [
      r.source, r.resolvedPayload, r.payload, r.statusLabel, r.sourceTypeLabel,
      r.projectId, r.deviceId, r.credential ? r.credential.value : '',
      r.primaryUrl ? r.primaryUrl.url : '',
      r.primaryUrl ? r.primaryUrl.host : '',
      (r.firebaseUrls || []).map(function (u) { return u.url; }).join(' ')
    ].join(' ').toLowerCase();
  }

  function getFilteredResults() {
    if (!state.bulk) return [];
    var q = state.search.trim().toLowerCase();
    return state.bulk.allResults.filter(function (r) {
      if (state.filter !== 'duplicates' && state.dedupe && r.duplicate) return false;
      if (!matchesFilter(r, state.filter)) return false;
      if (q && searchHaystack(r).indexOf(q) === -1) return false;
      return true;
    });
  }

  function statCardHtml(label, value, iconName, colorClass) {
    return '' +
      '<div class="glass-soft p-3.5 sm:p-4">' +
        '<div class="flex items-center justify-between gap-2">' +
          '<span class="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">' + label + '</span>' +
          '<span class="' + colorClass + '">' + icon(iconName, 'h-4 w-4') + '</span>' +
        '</div>' +
        '<p class="mt-2 text-xl font-extrabold tracking-tight text-white sm:text-2xl">' + value + '</p>' +
      '</div>';
  }

  function renderStats(stats) {
    var cards = [
      statCardHtml('Checked', stats.total, 'list', 'text-slate-400'),
      statCardHtml('Valid', stats.valid, 'check', 'text-emerald-300'),
      statCardHtml('Unique URLs', stats.uniqueFirebaseUrls, 'database', 'text-amber-300'),
      statCardHtml('Duplicates', stats.duplicates, 'layers', 'text-indigo-300'),
      statCardHtml('Expired', stats.expired, 'clock', 'text-rose-300'),
      statCardHtml('No Firebase', stats.noFirebase, 'alert', 'text-amber-300'),
      statCardHtml('Invalid', stats.invalid, 'x', 'text-slate-400'),
      statCardHtml('API keys', stats.withApiKeys, 'key', 'text-orange-300')
    ];
    $('bulk-stats').innerHTML = cards.join('');
  }

  function renderFilterChips() {
    if (!state.bulk) return;
    var html = FILTERS.map(function (f) {
      var count = state.bulk.allResults.filter(function (r) { return matchesFilter(r, f.id); }).length;
      var active = state.filter === f.id;
      return '<button type="button" data-filter="' + f.id + '" class="chip ' + (active ? 'chip-active' : '') + '">' +
        f.label + '<span class="rounded-full bg-black/25 px-1.5 py-0.5 font-mono text-[10px]">' + count + '</span>' +
      '</button>';
    }).join('');
    $('filter-chips').innerHTML = html;
  }

  function miniSegmentHtml(seg, index) {
    var value = state.revealCredential ? seg.value : (seg.sensitive ? D.maskSecret(seg.value) : seg.value);
    return '' +
      '<div class="flex gap-2 py-1.5">' +
        '<span class="font-mono text-[10px] text-slate-600">' + String(index + 1).padStart(2, '0') + '</span>' +
        '<div class="min-w-0">' +
          '<p class="text-[10px] font-bold uppercase tracking-wide text-slate-500">' + escapeHtml(seg.label) + '</p>' +
          '<p class="break-all font-mono text-[11px] leading-4 ' + (seg.sensitive && !state.revealCredential ? 'text-amber-200' : 'text-slate-300') + '">' + escapeHtml(value) + '</p>' +
        '</div>' +
      '</div>';
  }

  function bulkCardHtml(r) {
    var style = statusStyle(r.status);
    var display = r.primaryUrl
      ? r.primaryUrl.url
      : (r.resolvedPayload ? truncate(r.resolvedPayload, 180) : '—');
    var subParts = [];
    if (r.projectId) subParts.push('Project: ' + r.projectId);
    if (r.primaryUrl) subParts.push(r.primaryUrl.type);
    if (r.expiresAt) subParts.push(r.expiresAt.relative);
    if (r.credential) subParts.push('Key: ' + r.credential.masked);
    subParts.push(r.sourceTypeLabel);
    var duplicateBadge = r.duplicate
      ? '<span class="rounded-full bg-indigo-400/10 px-2 py-0.5 text-[10px] font-bold text-indigo-300 ring-1 ring-inset ring-indigo-400/20">duplicate of #' + r.duplicateOf + '</span>'
      : '';
    return '' +
      '<article class="glass p-4">' +
        '<div class="flex items-start gap-3">' +
          '<span class="mt-1.5 h-2 w-2 shrink-0 rounded-full ' + style.dot + '"></span>' +
          '<div class="min-w-0 flex-1">' +
            '<div class="flex flex-wrap items-center gap-2">' +
              '<span class="font-mono text-[10px] text-slate-500">#' + r.index + ' · line ' + r.line + '</span>' +
              '<span class="rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ring-inset ' + style.pill + '">' + escapeHtml(r.statusLabel) + '</span>' +
              duplicateBadge +
            '</div>' +
            '<p class="mt-2 break-all font-mono text-[13px] font-medium ' + (r.primaryUrl ? 'text-slate-100' : 'text-slate-400') + '">' + escapeHtml(display) + '</p>' +
            '<p class="mt-1 break-words text-[11px] leading-4 text-slate-500">' + escapeHtml(subParts.join(' · ')) + '</p>' +
            '<div class="mt-3 flex flex-wrap gap-2">' +
              '<button type="button" data-copy-bulk="url" data-id="' + r.index + '" class="mini-btn">' + icon('copy', 'h-3.5 w-3.5') + ' URL</button>' +
              '<button type="button" data-copy-bulk="payload" data-id="' + r.index + '" class="mini-btn">' + icon('copy', 'h-3.5 w-3.5') + ' Payload</button>' +
              '<button type="button" data-copy-bulk="json" data-id="' + r.index + '" class="mini-btn">' + icon('copy', 'h-3.5 w-3.5') + ' JSON</button>' +
            '</div>' +
            '<details class="mt-3 rounded-xl border border-white/10 bg-slate-950/40">' +
              '<summary class="cursor-pointer list-none px-3 py-2.5 text-xs font-semibold text-slate-300 hover:text-white">Breakdown (' + plural(r.segments.length, 'field') + ')</summary>' +
              '<div class="border-t border-white/5 px-3 py-2">' +
                (r.segments.length ? r.segments.map(miniSegmentHtml).join('') : '<p class="py-2 text-[11px] text-slate-500">No fields decoded.</p>') +
                (r.warnings.length ? '<ul class="mt-2 space-y-1 border-t border-white/5 pt-2 text-[10px] leading-4 text-amber-200/80">' + r.warnings.map(function (w) { return '<li>• ' + escapeHtml(w) + '</li>'; }).join('') + '</ul>' : '') +
              '</div>' +
            '</details>' +
          '</div>' +
        '</div>' +
      '</article>';
  }

  function renderBulkList() {
    if (!state.bulk) return;
    var filtered = getFilteredResults();
    var visible = filtered.slice(0, state.visibleCount);
    if (!visible.length) {
      $('bulk-list').innerHTML = '' +
        '<div class="glass flex flex-col items-center gap-2 p-8 text-center">' +
          '<span class="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/5 text-slate-500">' + icon('search', 'h-5 w-5') + '</span>' +
          '<p class="text-sm font-semibold text-slate-300">No matching results</p>' +
          '<p class="text-xs text-slate-500">Try a different filter or clear the search box.</p>' +
        '</div>';
    } else {
      $('bulk-list').innerHTML = visible.map(bulkCardHtml).join('');
    }
    var remaining = filtered.length - visible.length;
    $('btn-load-more').classList.toggle('hidden', remaining <= 0);
    $('btn-load-more').innerHTML = icon('refresh', 'h-4 w-4') + ' Load more (' + remaining + ' remaining)';
  }

  function renderBulk() {
    if (!state.bulk) return;
    var stats = state.bulk.stats;
    $('bulk-result').classList.remove('hidden');
    $('bulk-timing').textContent = stats.total + ' items · ' + stats.durationMs.toFixed(1) + ' ms · ' + new Date(stats.checkedAt).toLocaleTimeString();
    renderStats(stats);
    renderFilterChips();
    renderBulkList();
    var notice = $('bulk-truncated');
    if (stats.truncated) {
      notice.textContent = 'Input limit reached: only the first ' + formatBytes(MAX_INPUT_CHARS) + ' / ' + MAX_CANDIDATES + ' items were processed.';
      notice.classList.remove('hidden');
    } else {
      notice.classList.add('hidden');
    }
  }

  function runBulk() {
    var raw = $('bulk-input').value;
    if (!raw.trim()) {
      state.bulk = null;
      $('bulk-result').classList.add('hidden');
      showToast('Paste or upload a list first', 'error');
      return;
    }
    try {
      var output = D.processBulk(raw, {
        dedupe: state.dedupe,
        maxChars: MAX_INPUT_CHARS,
        maxCandidates: MAX_CANDIDATES
      });
      output.byIndex = new Map(output.allResults.map(function (r) { return [String(r.index), r]; }));
      state.bulk = output;
      state.visibleCount = PAGE_SIZE;
      renderBulk();
      showToast('Checked ' + plural(output.stats.total, 'item') + ' in ' + output.stats.durationMs.toFixed(1) + ' ms', 'success');
    } catch (e) {
      console.error(e);
      showToast('Bulk decoder error — check the input', 'error');
    }
  }

  function csvCell(value) {
    var s = String(value == null ? '' : value);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCSV(results) {
    var headers = [
      'index', 'line', 'status', 'status_label', 'source_type', 'firebase_url', 'base_url',
      'project_id', 'host_type', 'region', 'credential_masked', 'expires_at_iso',
      'expires_relative', 'device_id', 'duplicate', 'source'
    ];
    var rows = results.map(function (r) {
      return [
        r.index, r.line, r.status, r.statusLabel, r.sourceTypeLabel,
        r.primaryUrl ? r.primaryUrl.url : '',
        r.primaryUrl ? r.primaryUrl.baseUrl : '',
        r.projectId || '',
        r.primaryUrl ? r.primaryUrl.type : '',
        r.primaryUrl ? r.primaryUrl.region : '',
        r.credential ? r.credential.masked : '',
        r.expiresAt ? r.expiresAt.iso : '',
        r.expiresAt ? r.expiresAt.relative : '',
        r.deviceId || '',
        r.duplicate ? 'yes' : 'no',
        r.source
      ];
    });
    return [headers].concat(rows).map(function (row) {
      return row.map(csvCell).join(',');
    }).join('\r\n');
  }

  function currentExportRows() {
    return getFilteredResults();
  }

  function exportFilename(ext) {
    var d = new Date();
    var stamp = d.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return 'linkscope-' + stamp + '.' + ext;
  }

  function updateRevealButton() {
    var btn = $('btn-reveal');
    if (!btn) return;
    btn.innerHTML = icon(state.revealCredential ? 'eye-off' : 'eye', 'h-4 w-4') +
      ' Reveal keys: <span>' + (state.revealCredential ? 'ON' : 'OFF') + '</span>';
    btn.setAttribute('aria-pressed', String(state.revealCredential));
    btn.className = state.revealCredential
      ? 'btn-secondary border-amber-400/30 bg-amber-400/10 text-amber-200'
      : 'btn-secondary';
  }

  function updateDedupeButton() {
    var btn = $('btn-dedupe');
    btn.setAttribute('aria-pressed', String(state.dedupe));
    $('dedupe-state').textContent = state.dedupe ? 'ON' : 'OFF';
    btn.className = state.dedupe
      ? 'btn-secondary border-amber-400/30 bg-amber-400/10 text-amber-200'
      : 'btn-secondary';
  }

  function readFileAsText(file) {
    if (typeof file.text === 'function') return file.text();
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsText(file);
    });
  }

  async function readFiles(fileList) {
    var files = Array.from(fileList || []);
    if (!files.length) return;
    var chunks = [];
    var total = 0;
    var truncated = false;
    for (var i = 0; i < files.length; i++) {
      var text = await readFileAsText(files[i]);
      var room = MAX_INPUT_CHARS - total;
      if (room <= 0) { truncated = true; break; }
      if (text.length > room) {
        chunks.push(text.slice(0, room));
        truncated = true;
        total = MAX_INPUT_CHARS;
        break;
      }
      chunks.push(text);
      total += text.length;
    }
    var existing = $('bulk-input').value.trim();
    var combined = chunks.join('\n');
    $('bulk-input').value = existing ? existing + '\n' + combined : combined;
    updateBulkCount();
    var status = $('file-status');
    status.textContent = (truncated ? 'Loaded with size limit: ' : 'Loaded ') + plural(files.length, 'file') + ' · ' + formatBytes(total);
    status.classList.remove('hidden');
    showToast(truncated ? 'Files loaded (size limit applied)' : 'Files loaded', truncated ? 'info' : 'success');
  }

  function autoLoadFromQuery() {
    try {
      var params = new URL(window.location.href).searchParams;
      // s= and m= (VANTAGE merged) plus the alias parameters the decoder reads.
      var names = ['s', 'm', 'd', 'data', 'payload', 'token', 'encoded', 'share', 'link'];
      var hasShareValue = names.some(function (name) { return !!params.get(name); });
      if (hasShareValue) {
        $('single-input').value = window.location.href;
        setMode('single');
        runSingle({ silent: true });
      }
    } catch (e) { /* ignore */ }
  }

  function bindEvents() {
    $('tab-single').addEventListener('click', function () { setMode('single'); });
    $('tab-bulk').addEventListener('click', function () { setMode('bulk'); });

    $('single-input').addEventListener('input', scheduleSingleDecode);
    $('btn-decode').addEventListener('click', function () { runSingle(); });
    $('bottom-action').addEventListener('click', function () {
      if (state.mode === 'single') runSingle();
      else runBulk();
    });

    $('btn-paste').addEventListener('click', async function () {
      try {
        var text = await navigator.clipboard.readText();
        $('single-input').value = text;
        runSingle();
      } catch (e) {
        showToast('Clipboard unavailable — paste manually', 'error');
      }
    });

    $('btn-sample').addEventListener('click', function () {
      $('single-input').value = SAMPLE_LINKS[0];
      runSingle();
    });

    $('btn-clear-single').addEventListener('click', function () {
      $('single-input').value = '';
      clearSingleResult();
      clearTimeout(singleTimer);
      showToast('Cleared', 'info');
    });

    $('bulk-input').addEventListener('input', updateBulkCount);
    $('btn-check').addEventListener('click', runBulk);
    $('btn-sample-bulk').addEventListener('click', function () {
      $('bulk-input').value = SAMPLE_LINKS.join('\n');
      updateBulkCount();
      runBulk();
    });
    $('btn-clear-bulk').addEventListener('click', function () {
      $('bulk-input').value = '';
      state.bulk = null;
      $('bulk-result').classList.add('hidden');
      $('file-status').classList.add('hidden');
      updateBulkCount();
      showToast('Cleared', 'info');
    });

    $('btn-dedupe').addEventListener('click', function () {
      state.dedupe = !state.dedupe;
      updateDedupeButton();
      state.visibleCount = PAGE_SIZE;
      if (state.bulk) renderBulk();
    });

    $('btn-reveal').addEventListener('click', function () {
      state.revealCredential = !state.revealCredential;
      updateRevealButton();
      if (state.singleResult) renderSingle();
      if (state.bulk) renderBulkList();
    });

    $('btn-choose-file').addEventListener('click', function () { $('file-input').click(); });
    $('file-input').addEventListener('change', function (e) {
      readFiles(e.target.files);
      e.target.value = '';
    });

    var dropzone = $('dropzone');
    ['dragenter', 'dragover'].forEach(function (evt) {
      dropzone.addEventListener(evt, function (e) {
        e.preventDefault();
        dropzone.classList.add('border-amber-400/50', 'bg-amber-400/[0.06]');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      dropzone.addEventListener(evt, function (e) {
        e.preventDefault();
        dropzone.classList.remove('border-amber-400/50', 'bg-amber-400/[0.06]');
      });
    });
    dropzone.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) readFiles(e.dataTransfer.files);
    });

    $('single-result').addEventListener('click', function (e) {
      var reveal = e.target.closest('[data-action="reveal-credential"]');
      if (reveal) {
        state.revealCredential = !state.revealCredential;
        updateRevealButton();
        renderSingle();
        return;
      }
      var copy = e.target.closest('[data-copy-single]');
      if (copy) {
        var key = copy.getAttribute('data-copy-single');
        var text = state.singleCopyData[key] || '';
        if (!text) { showToast('Nothing to copy', 'error'); return; }
        copyText(text).then(function (ok) { showToast(ok ? 'Copied to clipboard' : 'Copy failed', ok ? 'success' : 'error'); });
        return;
      }
      var seg = e.target.closest('[data-copy-segment]');
      if (seg) {
        var idx = Number(seg.getAttribute('data-copy-segment'));
        var segText = state.segmentCopyData[idx] || '';
        copyText(segText).then(function (ok) { showToast(ok ? 'Field copied' : 'Copy failed', ok ? 'success' : 'error'); });
        return;
      }
      var fb = e.target.closest('[data-copy-fb]');
      if (fb) {
        var fi = Number(fb.getAttribute('data-copy-fb'));
        var fbText = state.fbCopyData[fi] || '';
        copyText(fbText).then(function (ok) { showToast(ok ? 'URL copied' : 'Copy failed', ok ? 'success' : 'error'); });
      }
    });

    $('bulk-list').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-copy-bulk]');
      if (!btn || !state.bulk) return;
      var type = btn.getAttribute('data-copy-bulk');
      var id = btn.getAttribute('data-id');
      var r = state.bulk.byIndex.get(String(id));
      if (!r) return;
      var text = '';
      if (type === 'url') text = r.primaryUrl ? r.primaryUrl.url : (r.resolvedPayload || r.source);
      else if (type === 'payload') text = r.resolvedPayload || r.payload || r.source;
      else text = JSON.stringify(r, null, 2);
      if (!text) { showToast('Nothing to copy', 'error'); return; }
      copyText(text).then(function (ok) { showToast(ok ? 'Copied to clipboard' : 'Copy failed', ok ? 'success' : 'error'); });
    });

    $('filter-chips').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-filter]');
      if (!btn || !state.bulk) return;
      state.filter = btn.getAttribute('data-filter');
      state.visibleCount = PAGE_SIZE;
      renderFilterChips();
      renderBulkList();
    });

    $('bulk-search').addEventListener('input', function (e) {
      state.search = e.target.value;
      state.visibleCount = PAGE_SIZE;
      $('btn-clear-search').classList.toggle('hidden', !e.target.value);
      renderBulkList();
    });

    $('btn-clear-search').addEventListener('click', function () {
      $('bulk-search').value = '';
      state.search = '';
      state.visibleCount = PAGE_SIZE;
      $('btn-clear-search').classList.add('hidden');
      renderBulkList();
      $('bulk-search').focus();
    });

    $('btn-load-more').addEventListener('click', function () {
      state.visibleCount += PAGE_SIZE;
      renderBulkList();
    });

    $('btn-copy-urls').addEventListener('click', function () {
      var rows = currentExportRows();
      var allUrls = [];
      rows.forEach(function (r) {
        (r.firebaseUrls && r.firebaseUrls.length ? r.firebaseUrls : (r.primaryUrl ? [r.primaryUrl] : []))
          .forEach(function (u) { if (u && u.url) allUrls.push(u.url); });
      });
      var urls = Array.from(new Set(allUrls));
      if (!urls.length) { showToast('No Firebase URLs in this view', 'error'); return; }
      copyText(urls.join('\n')).then(function (ok) { showToast(ok ? plural(urls.length, 'URL') + ' copied' : 'Copy failed', ok ? 'success' : 'error'); });
    });

    $('btn-copy-json').addEventListener('click', function () {
      var rows = currentExportRows();
      if (!rows.length) { showToast('No results in this view', 'error'); return; }
      copyText(JSON.stringify(rows, null, 2)).then(function (ok) { showToast(ok ? 'JSON copied' : 'Copy failed', ok ? 'success' : 'error'); });
    });

    $('btn-download-csv').addEventListener('click', function () {
      var rows = currentExportRows();
      if (!rows.length) { showToast('No results in this view', 'error'); return; }
      if (downloadFile(exportFilename('csv'), '\uFEFF' + toCSV(rows), 'text/csv;charset=utf-8')) showToast('CSV downloaded', 'success');
    });

    $('btn-download-json').addEventListener('click', function () {
      var rows = currentExportRows();
      if (!rows.length) { showToast('No results in this view', 'error'); return; }
      if (downloadFile(exportFilename('json'), JSON.stringify(rows, null, 2), 'application/json;charset=utf-8')) showToast('JSON downloaded', 'success');
    });

    window.addEventListener('error', function (e) {
      console.error('LinkScope error:', e.error || e.message);
    });
    window.addEventListener('unhandledrejection', function (e) {
      console.error('LinkScope rejection:', e.reason);
    });
  }

  function init() {
    if (!D) {
      showToast('decoder.js failed to load', 'error');
      return;
    }
    bindEvents();
    updateDedupeButton();
    updateRevealButton();
    updateBulkCount();
    setMode('single');
    autoLoadFromQuery();
  }

  init();
})();
