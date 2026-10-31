/*!
 * LinkScope Decoder Core — v1.2.0
 * 100% local text parsing. No fetch(), no network calls, no telemetry.
 * Works in browsers and Node.js (UMD).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LinkScopeDecoder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.2.0';
  var MAX_DECODE_ROUNDS = 3;
  var MAX_RESOLVE_DEPTH = 4;
  var DEFAULT_MAX_CHARS = 2000000;
  var DEFAULT_MAX_CANDIDATES = 20000;

  var FIREBASE_HOST_RE = /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:firebaseio\.com|firebasedatabase\.app|firebaseapp\.com|firebasestorage\.app|appspot\.com|web\.app)/i;
  var FIREBASE_URL_PATTERN = '(?:https?:\\/\\/)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9-]+)*\\.(?:firebaseio\\.com|firebasedatabase\\.app|firebaseapp\\.com|firebasestorage\\.app|appspot\\.com|web\\.app)(?:\\/[^\\s"\'<>`|\\\\^{}\\[\\]]*)?';
  var API_KEY_RE = /AIza[0-9A-Za-z_-]{35}/gi;
  var API_KEY_SINGLE_RE = /AIza[0-9A-Za-z_-]{35}/i;
  var ENCODED_CONTAINER_RE = /(?:[?&]|^|[\s,;({[|&])s\s*[:=]\s*["']?[A-Za-z0-9%+/=_-]{8,}/i;

  var SOURCE_LABELS = {
    'full-url': 'Full share URL',
    's-param': 's= parameter',
    'raw-base64': 'Raw Base64',
    'firebase-url': 'Direct Firebase URL',
    payload: 'Delimited payload',
    url: 'Plain URL',
    json: 'JSON payload',
    query: 'Query-string payload',
    'pipe-payload': 'Pipe-delimited payload',
    'vantage-share': 'VANTAGE share link',
    'merged-share': 'VANTAGE merged connections',
    'share-param': 'Share parameter',
    plain: 'Plain text',
    empty: 'Empty input'
  };

  var STATUS_META = {
    VALID: { label: 'Valid', severity: 'success', description: 'Firebase endpoint extracted successfully.' },
    EXPIRED: { label: 'Expired', severity: 'danger', description: 'The link expiry timestamp is in the past.' },
    NO_FIREBASE: { label: 'No Firebase URL', severity: 'warning', description: 'Text decoded, but no Firebase endpoint was found.' },
    INVALID: { label: 'Not recognized', severity: 'muted', description: 'Could not decode or identify a Firebase link.' }
  };

  function nowMs() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  function cleanToken(value) {
    var s = String(value == null ? '' : value);
    s = s.replace(/^[\uFEFF\u200B-\u200D\u2060]+/, '');
    s = s.trim();
    s = s.replace(/^["'`]+|["'`]+$/g, '');
    // Keep balanced JSON/array wrappers; only strip prose/markdown punctuation.
    var first = s.charAt(0);
    var last = s.charAt(s.length - 1);
    var balancedWrapper = (first === '{' && last === '}') || (first === '[' && last === ']');
    if (!balancedWrapper) s = s.replace(/[.,;:!?)\]}>]+$/g, '');
    return s.trim();
  }

  function decodeSValue(value) {
    var s = String(value == null ? '' : value).trim();
    s = s.replace(/^["']|["']$/g, '');
    var first = s.charAt(0);
    var last = s.charAt(s.length - 1);
    var balancedWrapper = (first === '{' && last === '}') || (first === '[' && last === ']');
    if (!balancedWrapper) s = s.replace(/[.,;:!?)\]}>]+$/g, '');
    // In query strings "+" often means a literal Base64 "+", not a space.
    s = s.replace(/\+/g, '%2B');
    try { s = decodeURIComponent(s); } catch (e) { /* keep original */ }
    // If a previous layer decoded "+" into a space, restore it for Base64.
    s = s.replace(/\s/g, '+');
    return s;
  }

  function normalizeBase64(value) {
    var s = decodeSValue(value);
    s = s.replace(/\s/g, '');
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    s = s.replace(/[.,;:!?)\]}>]+$/g, '');
    if (!s || s.length < 8) return null;
    if (!/^[A-Za-z0-9+/=]+$/.test(s)) return null;
    s = s.replace(/=+$/, '');
    var mod = s.length % 4;
    if (mod === 1) return null;
    if (mod) s += '='.repeat(4 - mod);
    return s;
  }

  function looksLikeBase64(value) {
    return !!normalizeBase64(value);
  }

  function base64ToBytes(s) {
    try {
      if (typeof atob === 'function') {
        var bin = atob(s);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
      }
      if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
    } catch (e) { /* invalid */ }
    return null;
  }

  function bytesToUtf8(bytes) {
    if (typeof TextDecoder !== 'undefined') {
      try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); } catch (e) { /* fallback */ }
    }
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
  }

  function isPrintableText(text) {
    var t = String(text || '');
    if (!t) return false;
    var bad = 0;
    var replacement = 0;
    for (var i = 0; i < t.length; i++) {
      var c = t.charCodeAt(i);
      if (c === 0xfffd) replacement++;
      else if (c < 32 && c !== 9 && c !== 10 && c !== 13) bad++;
    }
    var ratio = (t.length - bad - replacement) / t.length;
    return ratio >= 0.9 && replacement / t.length < 0.03;
  }

  function looksLikePayload(text) {
    var t = String(text || '').trim();
    if (!t || !isPrintableText(t)) return false;
    return /firebase|https?:\/\/|\|\||AIza|expires|expiry|projectId|deviceId|auth=|databaseURL/i.test(t);
  }

  function decodeChain(value) {
    var raw = String(value == null ? '' : value);
    var current = normalizeBase64(raw);
    var rounds = [];
    var last = raw;
    var urlSafe = /[-_]/.test(raw) || /%2D|%5F/i.test(raw);
    if (!current) return { ok: false, text: last, count: 0, encoding: 'plain', rounds: rounds };
    for (var i = 0; i < MAX_DECODE_ROUNDS; i++) {
      var bytes = base64ToBytes(current);
      if (!bytes || !bytes.length) break;
      var text = bytesToUtf8(bytes);
      if (!isPrintableText(text)) break;
      rounds.push({ encoding: urlSafe && i === 0 ? 'URL-safe Base64' : 'Base64', chars: current.length });
      last = text;
      if (looksLikePayload(text)) {
        return { ok: true, text: text, count: i + 1, encoding: rounds.map(function (r) { return r.encoding; }).join(' → '), rounds: rounds };
      }
      var next = normalizeBase64(text);
      if (!next || next === current) break;
      current = next;
      urlSafe = /[-_]/.test(text);
    }
    return {
      ok: looksLikePayload(last) && rounds.length > 0,
      text: last,
      count: rounds.length,
      encoding: rounds.map(function (r) { return r.encoding; }).join(' → ') || 'plain',
      rounds: rounds
    };
  }

  function extractSParam(value) {
    var raw = String(value == null ? '' : value);
    var patterns = [
      /[?&]s=([^&#\s"']+)/i,
      /^s=([^&#\s"']+)/i,
      /[#&]s=([^&#\s"']+)/i,
      /(?:^|[\s,;({[|&])["']?s["']?\s*[:=]\s*["']?([A-Za-z0-9%+/=_-]{8,})/i
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = raw.match(patterns[i]);
      if (m && m[1]) {
        var cleaned = cleanToken(m[1]);
        if (cleaned && cleaned.length >= 8) return decodeSValue(cleaned);
      }
    }
    return null;
  }

  function looksLikeEncodedContainer(text) {
    return ENCODED_CONTAINER_RE.test(String(text || ''));
  }

  // Panels do not always use "s=" — "d", "data", "payload", "token",
  // "encoded", "share" and "link" are common alternatives.
  var SHARE_PARAM_NAMES = 'd|data|payload|token|encoded|share|link';

  function extractAliasParam(value) {
    var raw = String(value == null ? '' : value);
    var patterns = [
      new RegExp('[?&](?:' + SHARE_PARAM_NAMES + ')=([^&#\\s"\']+)', 'i'),
      new RegExp('^(?:' + SHARE_PARAM_NAMES + ')=([^&#\\s"\']+)', 'i'),
      new RegExp('(?:^|[\\s,;({[|&])(?:' + SHARE_PARAM_NAMES + ')\\s*[:=]\\s*["\']?([A-Za-z0-9%+/=_-]{8,})', 'i')
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = raw.match(patterns[i]);
      if (m && m[1]) {
        var cleaned = cleanToken(m[1]);
        if (cleaned && cleaned.length >= 8) return decodeSValue(cleaned);
      }
    }
    return null;
  }

  // Format C — VANTAGE share links (vantagepanel.netlify.app):
  //   ?s= base64url( XOR( JSON {u,k,l,e}, fixedKey ) )
  // "u" = database URL, "k" = credential, "l" = label, "e" = expiry in ms
  // (0 or missing means the link never expires). This is the app's public
  // client-side fallback encoder, so the key ships with the page itself.
  var VANTAGE_XOR_KEY = 'vantagepanelv1_Xk9mP2wN7qL4vR6jH3cF8yT1ZbE5sA09';

  function looseBase64(value) {
    var s = String(value == null ? '' : value).replace(/\s/g, '');
    s = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    if (s.length < 16 || !/^[A-Za-z0-9+/]+$/.test(s)) return null;
    var mod = s.length % 4;
    if (mod === 1) return null;
    return mod ? s + '='.repeat(4 - mod) : s;
  }

  function xorWithKey(bytes, key) {
    var out = new Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ key.charCodeAt(i % key.length);
    return out;
  }

  // Format D — VANTAGE merged connections (?m=):
  //   base64url( encodeURIComponent( JSON [ {url,key}, ... ] ) )
  // "Watch all" links carry several databases in one parameter.
  function extractMFromUrl(value) {
    var raw = String(value == null ? '' : value);
    try {
      var u = new URL(raw);
      var fromUrl = u.searchParams.get('m');
      if (fromUrl) return decodeSValue(fromUrl);
    } catch (e) { /* not an absolute URL */ }
    var m = raw.match(/[?&#]m=([^&#\s"']+)/i) || raw.match(/^m=([^&#\s"']+)/i);
    return m && m[1] ? decodeSValue(m[1]) : null;
  }

  function normalizeMergedItems(list) {
    var items = [];
    var seen = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
      var url = String(it.url != null ? it.url : (it.u != null ? it.u : (it.databaseURL != null ? it.databaseURL : ''))).trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(url)) continue;
      var key = String(it.key != null ? it.key : (it.k != null ? it.k : (it.apiKey != null ? it.apiKey : '')));
      var id = url + '\u0000' + key;
      if (seen[id]) continue;
      seen[id] = true;
      items.push({ url: url, key: key });
    }
    return items;
  }

  function decodeMergedShare(value) {
    var raw = String(value == null ? '' : value).trim();
    if (!raw) return null;
    if (/^https?:/i.test(raw)) {
      raw = extractMFromUrl(raw);
      if (!raw) return null;
    } else {
      raw = raw.replace(/^m\s*=\s*/i, '');
      try { raw = decodeURIComponent(raw); } catch (e) { /* keep raw */ }
    }
    var b64 = looseBase64(raw);
    if (!b64) return null;
    var bytes = base64ToBytes(b64);
    if (!bytes || bytes.length < 8) return null;
    var text = bytesToUtf8(bytes);
    if (!isPrintableText(text)) return null;
    var jsonText = text;
    if (/%[0-9A-Fa-f]{2}/.test(text)) {
      try { jsonText = decodeURIComponent(text); } catch (e) { return null; }
    }
    var list;
    try { list = JSON.parse(jsonText); } catch (e) { return null; }
    if (!Array.isArray(list) || !list.length) return null;
    var items = normalizeMergedItems(list);
    if (!items.length) return null;
    return {
      items: items,
      text: jsonText,
      payload: JSON.stringify(items.map(function (x) { return { databaseURL: x.url, apiKey: x.key }; }))
    };
  }

  function decodeVantageShare(value) {
    var raw = String(value == null ? '' : value).trim();
    if (!raw) return null;
    if (/^https?:/i.test(raw)) {
      raw = extractSParam(raw);
      if (!raw) return null;
    } else {
      raw = raw.replace(/^s\s*=\s*/i, '');
      try { raw = decodeURIComponent(raw); } catch (e) { /* keep raw */ }
    }
    var b64 = looseBase64(raw);
    if (!b64) return null;
    var bytes = base64ToBytes(b64);
    if (!bytes || bytes.length < 16) return null;
    var text = bytesToUtf8(xorWithKey(bytes, VANTAGE_XOR_KEY));
    if (!isPrintableText(text)) return null;
    var obj;
    try { obj = JSON.parse(text); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    var url = String(obj.u != null ? obj.u : (obj.url != null ? obj.url : '')).trim();
    if (!/^https?:\/\//i.test(url)) return null;
    var key = String(obj.k != null ? obj.k : (obj.key != null ? obj.key : ''));
    var label = String(obj.l != null ? obj.l : (obj.label != null ? obj.label : ''));
    var expiryMs = Number(obj.e != null ? obj.e : (obj.exp != null ? obj.exp : 0)) || 0;
    return {
      payload: JSON.stringify({
        databaseURL: url,
        apiKey: key,
        label: label,
        expiry: expiryMs > 0 ? expiryMs : 'Permanent'
      }),
      text: text,
      url: url,
      key: key,
      label: label,
      expiryMs: expiryMs
    };
  }

  function firebaseUrlRegex() {
    return new RegExp(FIREBASE_URL_PATTERN, 'gi');
  }

  function inferProjectId(host) {
    var label = String(host || '').toLowerCase().split('.')[0] || '';
    label = label.replace(/-default-rtdb$/i, '').replace(/-rtdb$/i, '').replace(/-default$/i, '');
    return label || String(host || '');
  }

  function canonicalFirebaseUrl(url) {
    try {
      var u = new URL(url);
      u.protocol = 'https:';
      u.hostname = u.hostname.toLowerCase();
      u.hash = '';
      ['auth', 'key', 'token', 'apiKey', 'api_key', 'access_token'].forEach(function (p) { u.searchParams.delete(p); });
      var path = u.pathname.replace(/\/+$/, '');
      return u.origin + path + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '');
    } catch (e) {
      return String(url || '').trim().toLowerCase().replace(/\/+$/, '');
    }
  }

  function describeFirebaseUrl(url) {
    var u = new URL(url);
    var host = u.hostname.toLowerCase();
    var type = 'Firebase project';
    var region = 'Global / default';
    if (/\.firebaseio\.com$/i.test(host)) {
      type = 'Realtime Database (classic)';
      region = 'us-central1';
    } else if (/\.firebasedatabase\.app$/i.test(host)) {
      type = 'Realtime Database';
      var parts = host.split('.');
      region = parts.length > 3 ? parts[1] : 'us-central1';
    } else if (/\.firebaseapp\.com$/i.test(host)) {
      type = 'Firebase Hosting / App';
    } else if (/\.firebasestorage\.app$/i.test(host)) {
      type = 'Cloud Storage';
    } else if (/\.appspot\.com$/i.test(host)) {
      type = 'App Engine / Storage';
    } else if (/\.web\.app$/i.test(host)) {
      type = 'Firebase Hosting';
    }
    var path = u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/+$/, '') : '';
    var baseUrl = u.origin;
    var cleanUrl = baseUrl + path;
    var queryKeys = [];
    try { queryKeys = Array.from(u.searchParams.keys()); } catch (e) { /* noop */ }
    var sensitiveKeys = ['auth', 'key', 'token', 'apiKey', 'api_key', 'access_token'];
    var hasSensitiveQuery = sensitiveKeys.some(function (k) {
      try { return u.searchParams.has(k); } catch (e) { return false; }
    });
    return {
      url: cleanUrl,
      baseUrl: baseUrl,
      rawUrl: u.toString(),
      canonical: canonicalFirebaseUrl(cleanUrl),
      host: host,
      projectId: inferProjectId(host),
      type: type,
      region: region,
      path: path || '/',
      protocol: u.protocol.replace(':', ''),
      isSecure: u.protocol === 'https:',
      queryKeys: queryKeys,
      hasSensitiveQuery: hasSensitiveQuery
    };
  }

  function extractFirebaseUrls(text) {
    var out = [];
    var seen = Object.create(null);
    var re = firebaseUrlRegex();
    var m;
    var source = String(text == null ? '' : text);
    while ((m = re.exec(source)) !== null) {
      var raw = cleanToken(m[0]);
      if (!raw) continue;
      // Avoid matching a host fragment inside percent-encoded text (e.g. "%2Fproject").
      var before = m.index > 0 ? source.charAt(m.index - 1) : '';
      if (before && /[A-Za-z0-9%]/.test(before) && !/^https?:\/\//i.test(raw)) continue;
      if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
      try {
        var info = describeFirebaseUrl(raw);
        if (!seen[info.canonical]) {
          seen[info.canonical] = true;
          out.push(info);
        }
      } catch (e) { /* ignore malformed match */ }
    }
    return out;
  }

  function extractApiKeys(text) {
    var matches = String(text == null ? '' : text).match(API_KEY_RE) || [];
    return Array.from(new Set(matches));
  }

  function toTimestampMs(value) {
    var str = String(value == null ? '' : value).trim();
    if (!/^\d{9,17}$/.test(str)) return null;
    var n = Number(str);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n > 1e15) n = Math.floor(n / 1000); // microseconds → ms
    if (n > 1e11) return n;                 // already ms
    if (n > 1e9) return n * 1000;           // seconds → ms
    return null;
  }

  function humanizeKey(key) {
    return String(key || '')
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/^./, function (c) { return c.toUpperCase(); })
      .trim();
  }

  function humanizeDuration(ms) {
    var abs = Math.abs(ms);
    var units = [
      ['year', 31536000000],
      ['month', 2592000000],
      ['day', 86400000],
      ['hour', 3600000],
      ['minute', 60000],
      ['second', 1000]
    ];
    for (var i = 0; i < units.length; i++) {
      if (abs >= units[i][1]) {
        var val = Math.floor(abs / units[i][1]);
        return val + ' ' + units[i][0] + (val === 1 ? '' : 's');
      }
    }
    return 'less than a second';
  }

  function relativeTime(ms, now) {
    var diff = ms - now;
    if (Math.abs(diff) < 60000) return diff >= 0 ? 'in less than a minute' : 'just now';
    var h = humanizeDuration(Math.abs(diff));
    return diff >= 0 ? 'in ' + h : h + ' ago';
  }

  function maskSecret(value) {
    var s = String(value == null ? '' : value);
    if (!s) return '';
    if (/^AIza/i.test(s) && s.length > 12) return s.slice(0, 6) + '••••' + s.slice(-4);
    if (s.length <= 3) return '•••';
    if (s.length <= 8) return s[0] + '••••' + s[s.length - 1];
    return s.slice(0, 3) + '••••' + s.slice(-3);
  }

  function classifySegment(value, index, isDelimited) {
    var v = String(value == null ? '' : value);
    if (FIREBASE_HOST_RE.test(v)) return { kind: 'url', label: index === 0 ? 'Firebase endpoint' : 'URL', sensitive: false };
    if (/^https?:\/\//i.test(v)) return { kind: 'url', label: 'URL', sensitive: false };
    if (API_KEY_SINGLE_RE.test(v)) return { kind: 'apiKey', label: 'API key', sensitive: true };
    if (/^\d{9,17}$/.test(v)) return { kind: 'timestamp', label: isDelimited && index === 2 ? 'Expiry timestamp' : 'Timestamp', sensitive: false };
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return { kind: 'date', label: 'Date / expiry', sensitive: false };
    if (isDelimited && index === 1) return { kind: 'credential', label: 'Credential / key', sensitive: true };
    if (isDelimited && index === 3) return { kind: 'deviceId', label: 'Device ID / reference', sensitive: false };
    if (/^[a-f0-9]{8,}$/i.test(v)) return { kind: 'deviceId', label: 'Device ID / hash', sensitive: false };
    if (/^(true|false|null|undefined)$/i.test(v)) return { kind: 'literal', label: 'Value', sensitive: false };
    return { kind: 'text', label: isDelimited ? 'Field ' + (index + 1) : 'Value', sensitive: false };
  }

  function getCaseInsensitive(obj, key) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
    var target = String(key).toLowerCase();
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() === target) return obj[keys[i]];
    }
    return undefined;
  }

  function flattenStrings(value, out) {
    out = out || [];
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(function (v) { flattenStrings(v, out); });
    else if (value && typeof value === 'object') Object.keys(value).forEach(function (k) { flattenStrings(value[k], out); });
    return out;
  }

  // Format B — single-pipe payloads:
  //   https://project-default-rtdb.firebaseio.com|KEY|1793105515015|device-123
  // The older format uses "|||" between fields. A single "|" payload is only
  // recognised when field 1 is a Firebase endpoint and at least one later field
  // has a value, so ordinary prose containing a pipe is left alone.
  function isPipeDelimitedPayload(value) {
    var text = String(value == null ? '' : value).trim();
    if (!text || text.indexOf('|') === -1 || /\|\|/.test(text)) return false;
    var parts = text.split('|');
    if (parts.length < 2) return false;
    var head = parts[0].trim();
    if (!head || !FIREBASE_HOST_RE.test(head)) return false;
    for (var i = 1; i < parts.length; i++) {
      if (parts[i].trim()) return true;
    }
    return false;
  }

  // Array items shaped like { url, key } (merged connections, JSON exports)
  // are summarised instead of dumped as raw JSON.
  function summarizeConnectionObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    var url = String(value.url != null ? value.url : (value.u != null ? value.u : (value.databaseURL != null ? value.databaseURL : ''))).trim();
    if (!/^https?:\/\//i.test(url)) return null;
    var key = String(value.key != null ? value.key : (value.k != null ? value.k : (value.apiKey != null ? value.apiKey : '')));
    return { text: key ? url + ' | ' + key : url, key: key, hasKey: !!key };
  }

  function splitPayloadSegments(payload) {
    var text = String(payload == null ? '' : payload).trim();
    if (!text) return [];
    var separator = /\|\|/.test(text) ? /\s*\|{2,}\s*/ : (isPipeDelimitedPayload(text) ? /\s*\|\s*/ : null);
    if (separator) {
      return text.split(separator).map(function (v, i) {
        var c = classifySegment(v, i, true);
        return { index: i, label: c.label, value: v, kind: c.kind, sensitive: c.sensitive };
      }).filter(function (seg) {
        // Drop empty fields from the breakdown but keep their original index so
        // labels stay aligned with field 1 / field 2 / field 3.
        return String(seg.value).trim() !== '';
      });
    }
    if (/^[[{]/.test(text)) {
      try {
        var obj = JSON.parse(text);
        if (obj && typeof obj === 'object') {
          var isArrayPayload = Array.isArray(obj);
          var entries = isArrayPayload
            ? obj.map(function (v, i) { return ['item ' + (i + 1), v]; })
            : Object.keys(obj).map(function (k) { return [k, obj[k]]; });
          return entries.map(function (entry, i) {
            var k = entry[0];
            // Connection objects look better as "url | key" than as raw JSON.
            var summary = isArrayPayload ? summarizeConnectionObject(entry[1]) : null;
            var v = summary
              ? summary.text
              : (typeof entry[1] === 'object' ? JSON.stringify(entry[1]) : String(entry[1] == null ? '' : entry[1]));
            var c = classifySegment(v, i, false);
            return {
              index: i,
              label: humanizeKey(k) || c.label,
              value: v,
              kind: c.kind,
              credential: summary && summary.key ? summary.key : '',
              sensitive: c.sensitive || !!(summary && summary.hasKey) || /key|secret|token|auth|pass/i.test(k)
            };
          });
        }
      } catch (e) { /* not JSON */ }
    }
    if (!/^https?:\/\//i.test(text) && text.indexOf('=') !== -1 && /(?:^|&)(?:url|firebase|key|auth|expires|expiry|device)/i.test(text)) {
      try {
        var params = new URLSearchParams(text.replace(/^\?/, ''));
        var pairs = Array.from(params.entries());
        if (pairs.length) {
          return pairs.map(function (pair, i) {
            var c = classifySegment(pair[1], i, false);
            return {
              index: i,
              label: humanizeKey(pair[0]),
              value: pair[1],
              kind: c.kind,
              sensitive: c.sensitive || /key|secret|token|auth|pass/i.test(pair[0])
            };
          });
        }
      } catch (e) { /* noop */ }
    }
    var single = classifySegment(text, 0, false);
    return [{ index: 0, label: single.label, value: text, kind: single.kind, sensitive: single.sensitive }];
  }

  function findCredential(segments, apiKeys, primaryUrl, text) {
    if (apiKeys.length) {
      return { value: apiKeys[0], masked: maskSecret(apiKeys[0]), type: 'Firebase Web API key', source: 'pattern match' };
    }
    var seg = segments.find(function (s) {
      return (s.kind === 'credential' || s.kind === 'apiKey' || s.sensitive) && s.value;
    });
    if (seg) {
      var segValue = seg.credential || seg.value;
      return {
        value: segValue,
        masked: maskSecret(segValue),
        type: seg.kind === 'apiKey' ? 'Firebase Web API key' : 'Credential / database secret',
        source: 'field ' + (seg.index + 1)
      };
    }
    // JSON payloads (including merged-connection arrays) keep their secrets in
    // named fields, so look for those before falling back to query params.
    var jsonField = String(text || '').match(/"(?:apiKey|api_key|key|credential|secret)"\s*:\s*"([^"]{3,})"/i);
    if (jsonField) {
      return {
        value: jsonField[1],
        masked: maskSecret(jsonField[1]),
        type: 'Credential / database secret',
        source: 'JSON field'
      };
    }
    if (primaryUrl && primaryUrl.hasSensitiveQuery) {
      try {
        var u = new URL(primaryUrl.rawUrl);
        var auth = u.searchParams.get('auth') || u.searchParams.get('key') || u.searchParams.get('access_token');
        if (auth) return { value: auth, masked: maskSecret(auth), type: 'URL auth parameter', source: 'query string' };
      } catch (e) { /* noop */ }
    }
    var m = String(text || '').match(/(?:[?&]auth=)([^&\s|]+)/i);
    if (m) {
      var value = decodeURIComponent(m[1]);
      return { value: value, masked: maskSecret(value), type: 'Auth parameter', source: 'raw text' };
    }
    return null;
  }

  function findExpiry(payload, segments) {
    var i;
    for (i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (seg.kind === 'timestamp' || seg.kind === 'date' || /^(expires at|expiry|expires|valid until|timestamp|time|date)$/i.test(seg.label)) {
        var ms = toTimestampMs(seg.value);
        if (!ms) {
          var parsed = Date.parse(seg.value);
          if (!Number.isNaN(parsed)) ms = parsed;
        }
        if (ms) return { raw: seg.value, ms: ms };
      }
    }
    var nums = String(payload || '').match(/\b\d{9,17}\b/g) || [];
    for (i = 0; i < nums.length; i++) {
      var n = toTimestampMs(nums[i]);
      if (n) return { raw: nums[i], ms: n };
    }
    var iso = String(payload || '').match(/\b\d{4}-\d{2}-\d{2}(?:[T ][^\s|"']+)?/);
    if (iso) {
      var isoMs = Date.parse(iso[0]);
      if (!Number.isNaN(isoMs)) return { raw: iso[0], ms: isoMs };
    }
    return null;
  }

  function findDeviceId(segments, text) {
    var seg = segments.find(function (s) { return s.kind === 'deviceId' && s.value; });
    if (seg) return seg.value;
    var m = String(text || '').match(/(?:deviceId|device_id|device|ref|reference)\s*[:=]\s*([A-Za-z0-9_-]{4,})/i);
    return m ? m[1] : null;
  }

  function queryToPayload(token) {
    try {
      var params = new URLSearchParams(String(token).replace(/^\?/, ''));
      var get = function () {
        for (var i = 0; i < arguments.length; i++) if (params.has(arguments[i])) return params.get(arguments[i]);
        return '';
      };
      var url = get('url', 'firebase', 'firebaseUrl', 'firebase_url', 'databaseURL', 'endpoint');
      var key = get('key', 'apiKey', 'api_key', 'auth', 'secret', 'token');
      var exp = get('expiresAt', 'expiry', 'exp', 'expires', 'validUntil', 'timestamp', 'time');
      var dev = get('deviceId', 'device_id', 'device', 'ref', 'reference');
      var parts = [url, key, exp, dev].filter(Boolean);
      return parts.length ? parts.join('|||') : null;
    } catch (e) { return null; }
  }

  function jsonToPayload(token, notes) {
    var obj;
    try { obj = JSON.parse(token); } catch (e) { return null; }
    var strings = flattenStrings(obj);
    var encodedKeys = ['s', 'encoded', 'token', 'base64', 'payload', 'data', 'value'];
    for (var i = 0; i < encodedKeys.length; i++) {
      var v = getCaseInsensitive(obj, encodedKeys[i]);
      if (typeof v === 'string' && looksLikeBase64(v)) {
        var d = decodeChain(v);
        if (d.ok) {
          notes.push('Decoded JSON field "' + encodedKeys[i] + '".');
          return d.text;
        }
      }
    }
    for (i = 0; i < strings.length; i++) {
      if (looksLikeBase64(strings[i])) {
        var decoded = decodeChain(strings[i]);
        if (decoded.ok && looksLikePayload(decoded.text)) {
          notes.push('Decoded a Base64 string inside JSON.');
          return decoded.text;
        }
      }
    }
    var get = function () {
      for (var j = 0; j < arguments.length; j++) {
        var val = getCaseInsensitive(obj, arguments[j]);
        if (val !== undefined && val !== null && val !== '') return String(val);
      }
      return '';
    };
    var url = get('url', 'u', 'firebaseUrl', 'firebase_url', 'firebaseURL', 'databaseURL', 'databaseUrl', 'endpoint', 'host');
    var key = get('key', 'k', 'apiKey', 'api_key', 'auth', 'secret', 'credential', 'token');
    var exp = get('expiresAt', 'expiry', 'e', 'exp', 'expires', 'validUntil', 'timestamp', 'time');
    var dev = get('deviceId', 'device_id', 'device', 'dev', 'ref', 'reference');
    var parts = [url, key, exp, dev].filter(Boolean);
    if (parts.length) return parts.join('|||');
    var fbs = strings.filter(function (s) { return FIREBASE_HOST_RE.test(s); });
    if (fbs.length) return fbs.join('\n');
    return token;
  }

  function findBase64InUrlPath(url) {
    try {
      var u = new URL(url);
      var parts = u.pathname.split('/').filter(Boolean).reverse();
      for (var i = 0; i < parts.length; i++) {
        var cleaned;
        try { cleaned = decodeURIComponent(parts[i]); } catch (e) { cleaned = parts[i]; }
        if (looksLikeBase64(cleaned)) return cleaned;
      }
      if (u.hash && looksLikeBase64(u.hash.slice(1))) return u.hash.slice(1);
    } catch (e) { /* noop */ }
    return null;
  }

  function resolvePayload(raw, depth, notes) {
    depth = depth || 0;
    notes = notes || [];
    var token = cleanToken(raw);
    if (!token) return { payload: '', sourceType: 'empty', encoding: 'plain', decodeCount: 0, notes: notes.concat(['Empty input.']) };
    if (depth > MAX_RESOLVE_DEPTH) {
      return { payload: token, sourceType: 'plain', encoding: 'plain', decodeCount: 0, notes: notes.concat(['Maximum decoding depth reached.']) };
    }

    // VANTAGE merged connections (?m=) carry a JSON array, so check before
    // the s= / plain-URL branches can treat the parameter as a normal URL.
    var merged = decodeMergedShare(token);
    if (merged) {
      return {
        payload: merged.payload,
        sourceType: 'merged-share',
        encoding: 'URL-encoded JSON + Base64',
        decodeCount: 1,
        notes: notes.concat([
          'Decoded a VANTAGE merged-connections link (' + merged.items.length +
          ' connection' + (merged.items.length === 1 ? '' : 's') + ').'
        ])
      };
    }

    if (/^[[{]/.test(token)) {
      var jsonNotes = notes.slice();
      var jsonPayload = jsonToPayload(token, jsonNotes);
      if (jsonPayload) {
        if (depth < MAX_RESOLVE_DEPTH && looksLikeEncodedContainer(jsonPayload)) {
          var nestedJson = resolvePayload(jsonPayload, depth + 1, jsonNotes.concat(['Following nested encoded value from JSON.']));
          nestedJson.sourceType = 'json';
          return nestedJson;
        }
        return { payload: jsonPayload, sourceType: 'json', encoding: 'json', decodeCount: 0, notes: jsonNotes.concat(['Parsed JSON input.']) };
      }
    }

    var sVal = extractSParam(token);
    if (sVal) {
      var decodedS = decodeChain(sVal);
      if (decodedS.ok) {
        var sNotes = notes.concat(['Decoded ?s= value using ' + decodedS.encoding + '.']);
        if (depth < MAX_RESOLVE_DEPTH && looksLikeEncodedContainer(decodedS.text)) {
          var nestedS = resolvePayload(decodedS.text, depth + 1, sNotes);
          nestedS.sourceType = /^https?:\/\//i.test(token) ? 'full-url' : 's-param';
          nestedS.decodeCount = decodedS.count + nestedS.decodeCount;
          return nestedS;
        }
        return {
          payload: decodedS.text,
          sourceType: /^https?:\/\//i.test(token) ? 'full-url' : 's-param',
          encoding: decodedS.encoding,
          decodeCount: decodedS.count,
          notes: sNotes
        };
      }
      // Not plain Base64 — try the VANTAGE XOR-obfuscated share payload.
      var vantageS = decodeVantageShare(sVal);
      if (vantageS) {
        return {
          payload: vantageS.payload,
          sourceType: 'vantage-share',
          encoding: 'XOR + Base64',
          decodeCount: 1,
          notes: notes.concat(['Decoded a VANTAGE share link (Base64 + XOR-encoded JSON).'])
        };
      }
      // Some panels put URL-encoded or plain JSON straight into s=.
      if (/^[[{]/.test(sVal)) {
        var jsonSPath = jsonToPayload(sVal, []);
        if (jsonSPath) {
          return {
            payload: jsonSPath,
            sourceType: 's-param',
            encoding: 'json',
            decodeCount: 0,
            notes: notes.concat(['Parsed a JSON payload from the s= value.'])
          };
        }
      }
      notes = notes.concat(['Found an s= value, but it did not decode as readable Base64.']);
    }

    // Alternative share parameters (d=, data=, payload=, token=, …).
    var aliasValue = extractAliasParam(token);
    if (aliasValue) {
      var aliasNotes = notes.concat(['Found a share parameter value.']);
      if (/^[[{]/.test(aliasValue)) {
        var aliasJson = jsonToPayload(aliasValue, []);
        if (aliasJson) {
          return { payload: aliasJson, sourceType: 'share-param', encoding: 'json', decodeCount: 0, notes: aliasNotes.concat(['Parsed a JSON payload from the share parameter.']) };
        }
      }
      if (isPipeDelimitedPayload(aliasValue)) {
        return { payload: aliasValue, sourceType: 'share-param', encoding: 'plain', decodeCount: 0, notes: aliasNotes.concat(['Share parameter contains a single-pipe payload.']) };
      }
      if (/^https?:\/\//i.test(aliasValue)) {
        return { payload: aliasValue, sourceType: 'share-param', encoding: 'plain', decodeCount: 0, notes: aliasNotes.concat(['Share parameter contains a URL.']) };
      }
      var aliasDecoded = decodeChain(aliasValue);
      if (aliasDecoded.ok) {
        return {
          payload: aliasDecoded.text,
          sourceType: 'share-param',
          encoding: aliasDecoded.encoding,
          decodeCount: aliasDecoded.count,
          notes: aliasNotes.concat(['Decoded share parameter using ' + aliasDecoded.encoding + '.'])
        };
      }
      var aliasVantage = decodeVantageShare(aliasValue);
      if (aliasVantage) {
        return { payload: aliasVantage.payload, sourceType: 'share-param', encoding: 'XOR + Base64', decodeCount: 1, notes: aliasNotes.concat(['Decoded a VANTAGE share value from a share parameter.']) };
      }
      var aliasMerged = decodeMergedShare(aliasValue);
      if (aliasMerged) {
        return {
          payload: aliasMerged.payload,
          sourceType: 'share-param',
          encoding: 'URL-encoded JSON + Base64',
          decodeCount: 1,
          notes: aliasNotes.concat(['Decoded merged connections from a share parameter.'])
        };
      }
    }

    // A delimited payload can begin with https://, so detect it before plain URLs.
    if (/\|\|/.test(token)) {
      return { payload: token, sourceType: 'payload', encoding: 'plain', decodeCount: 0, notes: notes.concat(['Detected a ||| delimited payload.']) };
    }

    if (isPipeDelimitedPayload(token)) {
      return { payload: token, sourceType: 'pipe-payload', encoding: 'plain', decodeCount: 0, notes: notes.concat(['Detected a single-pipe (|) delimited payload.']) };
    }

    // Query-string payloads can contain an encoded Firebase host; decode them
    // before running the bare-host detector (which would otherwise match "%2Fhost").
    if (token.indexOf('=') !== -1 && /(?:^|&)(?:url|firebase|key|auth|expires|expiry|device)/i.test(token)) {
      var qp = queryToPayload(token);
      if (qp) return { payload: qp, sourceType: 'query', encoding: 'plain', decodeCount: 0, notes: notes.concat(['Converted URL-encoded fields into a delimited payload.']) };
    }

    if (/^https?:\/\//i.test(token)) {
      if (FIREBASE_HOST_RE.test(token)) {
        return { payload: token, sourceType: 'firebase-url', encoding: 'plain', decodeCount: 0, notes: notes.concat(['Detected a direct Firebase URL.']) };
      }
      var pathCandidate = findBase64InUrlPath(token);
      if (pathCandidate) {
        var decodedPath = decodeChain(pathCandidate);
        if (decodedPath.ok) {
          var pathNotes = notes.concat(['Decoded a Base64 URL path segment using ' + decodedPath.encoding + '.']);
          if (depth < MAX_RESOLVE_DEPTH && looksLikeEncodedContainer(decodedPath.text)) {
            var nestedPath = resolvePayload(decodedPath.text, depth + 1, pathNotes);
            nestedPath.sourceType = 'url';
            nestedPath.decodeCount = decodedPath.count + nestedPath.decodeCount;
            return nestedPath;
          }
          return { payload: decodedPath.text, sourceType: 'url', encoding: decodedPath.encoding, decodeCount: decodedPath.count, notes: pathNotes };
        }
      }
      var embedded = extractFirebaseUrls(token);
      if (embedded.length) {
        return { payload: embedded.map(function (x) { return x.url; }).join('\n'), sourceType: 'url', encoding: 'plain', decodeCount: 0, notes: notes.concat(['Extracted Firebase URL(s) embedded in the URL.']) };
      }
      return { payload: token, sourceType: 'url', encoding: 'plain', decodeCount: 0, notes: notes.concat(['Detected a plain URL.']) };
    }

    if (FIREBASE_HOST_RE.test(token)) {
      return { payload: token, sourceType: 'firebase-url', encoding: 'plain', decodeCount: 0, notes: notes.concat(['Detected a Firebase host without a scheme; HTTPS assumed.']) };
    }

    if (looksLikeBase64(token)) {
      var vantageRaw = decodeVantageShare(token);
      if (vantageRaw) {
        return {
          payload: vantageRaw.payload,
          sourceType: 'vantage-share',
          encoding: 'XOR + Base64',
          decodeCount: 1,
          notes: notes.concat(['Decoded a VANTAGE share value (Base64 + XOR-encoded JSON).'])
        };
      }
      var decodedRaw = decodeChain(token);
      if (decodedRaw.ok) {
        var rawNotes = notes.concat(['Decoded raw value using ' + decodedRaw.encoding + '.']);
        if (depth < MAX_RESOLVE_DEPTH && looksLikeEncodedContainer(decodedRaw.text)) {
          var nestedRaw = resolvePayload(decodedRaw.text, depth + 1, rawNotes);
          nestedRaw.sourceType = 'raw-base64';
          nestedRaw.decodeCount = decodedRaw.count + nestedRaw.decodeCount;
          return nestedRaw;
        }
        return { payload: decodedRaw.text, sourceType: 'raw-base64', encoding: decodedRaw.encoding, decodeCount: decodedRaw.count, notes: rawNotes };
      }
      notes = notes.concat(['Input looked like Base64 but did not decode to readable text.']);
    }

    return { payload: token, sourceType: 'plain', encoding: 'plain', decodeCount: 0, notes: notes.concat(['Input was treated as plain text.']) };
  }

  function parsePayload(payload, options) {
    options = options || {};
    var now = Number.isFinite(options.now) ? options.now : Date.now();
    var text = String(payload == null ? '' : payload).trim();
    var firebaseUrls = extractFirebaseUrls(text);
    var apiKeys = extractApiKeys(text);
    var segments = splitPayloadSegments(text);
    var primaryUrl = firebaseUrls[0] || null;
    var credential = findCredential(segments, apiKeys, primaryUrl, text);
    var expiryRaw = findExpiry(text, segments);
    var expiresAt = null;
    if (expiryRaw && Number.isFinite(expiryRaw.ms)) {
      expiresAt = {
        raw: expiryRaw.raw,
        ms: expiryRaw.ms,
        iso: new Date(expiryRaw.ms).toISOString(),
        local: new Date(expiryRaw.ms).toLocaleString(),
        relative: relativeTime(expiryRaw.ms, now),
        expired: expiryRaw.ms <= now
      };
    }
    var deviceId = findDeviceId(segments, text);
    var sourceType = options.sourceType || 'plain';
    var decodeCount = options.decodeCount || 0;
    var encoding = options.encoding || 'plain';
    var notes = (options.notes || []).slice();
    var isDelimited = /\|\|/.test(text) || isPipeDelimitedPayload(text);
    var decoded = decodeCount > 0 || sourceType === 'json' || sourceType === 'query' || sourceType === 'payload' || sourceType === 'pipe-payload' || sourceType === 'vantage-share' || sourceType === 'merged-share' || sourceType === 'share-param';
    var isVantagePermanent = sourceType === 'vantage-share' && /"expiry"\s*:\s*"Permanent"/i.test(text);
    var hasNoExpiryByDesign = isVantagePermanent || sourceType === 'merged-share';
    if (sourceType === 'merged-share') {
      segments.forEach(function (seg, i) { seg.label = 'Connection ' + (i + 1); });
    }

    var status;
    if (!text) status = 'INVALID';
    else if (!firebaseUrls.length) status = (!decoded && !isDelimited) ? 'INVALID' : 'NO_FIREBASE';
    else if (expiresAt && expiresAt.expired) status = 'EXPIRED';
    else status = 'VALID';

    var meta = STATUS_META[status];
    var messages = [];
    var warnings = [];

    if (decodeCount) messages.push('Decoded ' + decodeCount + ' Base64 layer' + (decodeCount === 1 ? '' : 's') + ' (' + encoding + ').');
    messages.push('Input detected as ' + (SOURCE_LABELS[sourceType] || 'plain text') + '.');
    if (firebaseUrls.length) messages.push('Found ' + firebaseUrls.length + ' Firebase endpoint' + (firebaseUrls.length === 1 ? '' : 's') + '.');
    else messages.push('No Firebase endpoint was found in the decoded text.');
    if (expiresAt) messages.push('Expiry: ' + expiresAt.local + ' (' + expiresAt.relative + ').');
    else if (isVantagePermanent) messages.push('This VANTAGE link is permanent (no expiry).');
    else if (sourceType === 'merged-share') messages.push('Merged links do not carry an expiry field.');
    else messages.push('No expiry timestamp was detected.');
    if (sourceType === 'merged-share') {
      var connections = (text.match(/"databaseURL"/g) || []).length;
      messages.push('Merged link contains ' + connections + ' connection' + (connections === 1 ? '' : 's') + '.');
    }
    if (credential) messages.push('A credential field was found and is masked by default.');

    notes.forEach(function (n) { messages.push(n); });

    if (apiKeys.length) warnings.push('A Firebase Web API key is present. Do not share it publicly.');
    if (firebaseUrls.length > 1) warnings.push('Multiple Firebase URLs were found; the first is shown as primary.');
    if (primaryUrl && !primaryUrl.isSecure) warnings.push('This endpoint uses HTTP instead of HTTPS.');
    if (expiresAt && expiresAt.expired) warnings.push('This link has expired.');
    if (!expiresAt && !hasNoExpiryByDesign) warnings.push('This link has no detectable expiry field.');
    if (sourceType === 'plain' && decodeCount === 0 && !isDelimited) warnings.push('Input was not recognized as Base64, a delimited payload, or a Firebase URL.');
    if (primaryUrl && primaryUrl.hasSensitiveQuery) warnings.push('Sensitive query parameters were removed from the displayed URL.');

    return {
      payload: text,
      status: status,
      statusLabel: meta.label,
      statusDescription: meta.description,
      severity: meta.severity,
      segments: segments,
      firebaseUrls: firebaseUrls,
      primaryUrl: primaryUrl,
      projectId: primaryUrl ? primaryUrl.projectId : null,
      apiKeys: apiKeys,
      credential: credential,
      expiresAt: expiresAt,
      deviceId: deviceId,
      decoded: decoded,
      messages: messages,
      warnings: warnings,
      sourceType: sourceType,
      sourceTypeLabel: SOURCE_LABELS[sourceType] || 'Plain text',
      encoding: encoding,
      decodeCount: decodeCount,
      notes: notes,
      checkedAt: now
    };
  }

  function inspect(raw, options) {
    options = options || {};
    var start = nowMs();
    var resolved = resolvePayload(raw, 0, []);
    var parsed = parsePayload(resolved.payload, {
      now: options.now,
      sourceType: resolved.sourceType,
      encoding: resolved.encoding,
      decodeCount: resolved.decodeCount,
      notes: resolved.notes
    });
    var end = nowMs();
    parsed.version = VERSION;
    parsed.source = String(raw == null ? '' : raw).trim();
    parsed.resolvedPayload = resolved.payload;
    parsed.durationMs = Math.max(0, end - start);
    return parsed;
  }

  function isCandidateToken(value) {
    var t = cleanToken(value);
    if (!t || t.length < 4) return false;
    if (/^https?:\/\//i.test(t)) return true;
    if (FIREBASE_HOST_RE.test(t)) return true;
    if (/\|\|/.test(t)) return true;
    if (isPipeDelimitedPayload(t)) return true;
    if (API_KEY_SINGLE_RE.test(t)) return true;
    if (extractSParam(t)) return true;
    if (extractAliasParam(t)) return true;
    if (/^[sm]=/i.test(t) && t.length > 8) return true;
    if (t.length >= 12 && looksLikeBase64(t)) {
      if (decodeVantageShare(t)) return true;
      if (decodeMergedShare(t)) return true;
      var d = decodeChain(t);
      if (d.ok) return true;
    }
    return false;
  }

  function extractCandidates(input, options) {
    options = options || {};
    var maxChars = options.maxChars || DEFAULT_MAX_CHARS;
    var maxCandidates = options.maxCandidates || DEFAULT_MAX_CANDIDATES;
    var text = String(input == null ? '' : input)
      .replace(/\r\n?/g, '\n')
      .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '');
    var truncated = false;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
    }
    var lines = text.split('\n');
    var candidates = [];
    function push(value, line) {
      if (candidates.length >= maxCandidates) { truncated = true; return false; }
      var v = cleanToken(value);
      if (!v) return true;
      candidates.push({ value: v, line: line });
      return true;
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || /^(#|\/\/|;)/.test(line)) continue;
      if (/\|\|/.test(line) || isPipeDelimitedPayload(line) || /^[[{]/.test(line)) {
        if (!push(line, i + 1)) break;
        continue;
      }
      var tokens = line.match(/[^\s,;"'<>\[\]()]+/g) || [];
      var added = false;
      for (var j = 0; j < tokens.length; j++) {
        var token = cleanToken(tokens[j]);
        if (!token || !isCandidateToken(token)) continue;
        if (!push(token, i + 1)) { truncated = true; break; }
        added = true;
      }
      if (truncated) break;
      if (!added) {
        var compact = line.replace(/\s/g, '');
        if (isCandidateToken(line)) {
          if (!push(line, i + 1)) break;
        } else if (compact !== line && isCandidateToken(compact)) {
          if (!push(compact, i + 1)) break;
        } else if (line.length >= 4) {
          // Keep unrecognised non-empty lines so bulk mode can report them as invalid.
          if (!push(line, i + 1)) break;
        }
      }
    }
    return { candidates: candidates, truncated: truncated };
  }

  function processBulk(input, options) {
    options = options || {};
    var start = nowMs();
    var now = Number.isFinite(options.now) ? options.now : Date.now();
    var extracted = extractCandidates(input, options);
    var allResults = [];
    var seen = Object.create(null);
    var duplicateCount = 0;
    for (var i = 0; i < extracted.candidates.length; i++) {
      var c = extracted.candidates[i];
      var r = inspect(c.value, { now: now });
      r.index = i + 1;
      r.line = c.line;
      var key = r.primaryUrl ? r.primaryUrl.canonical : r.resolvedPayload.trim().toLowerCase();
      if (key && seen[key] !== undefined) {
        r.duplicate = true;
        r.duplicateOf = seen[key];
        duplicateCount++;
      } else {
        r.duplicate = false;
        r.duplicateOf = null;
        if (key) seen[key] = r.index;
      }
      allResults.push(r);
    }
    var results = options.dedupe ? allResults.filter(function (r) { return !r.duplicate; }) : allResults.slice();
    var uniqueUrls = new Set();
    // Count every endpoint, not only the primary one, so merged links and
    // payloads with several URLs are represented accurately.
    allResults.forEach(function (r) {
      (r.firebaseUrls || []).forEach(function (u) { uniqueUrls.add(u.canonical); });
      if (!r.firebaseUrls || !r.firebaseUrls.length) {
        if (r.primaryUrl) uniqueUrls.add(r.primaryUrl.canonical);
      }
    });
    var stats = {
      total: allResults.length,
      shown: results.length,
      valid: allResults.filter(function (r) { return r.status === 'VALID'; }).length,
      expired: allResults.filter(function (r) { return r.status === 'EXPIRED'; }).length,
      noFirebase: allResults.filter(function (r) { return r.status === 'NO_FIREBASE'; }).length,
      invalid: allResults.filter(function (r) { return r.status === 'INVALID'; }).length,
      duplicates: duplicateCount,
      uniqueFirebaseUrls: uniqueUrls.size,
      withApiKeys: allResults.filter(function (r) { return r.apiKeys.length > 0; }).length,
      truncated: extracted.truncated,
      checkedAt: now,
      durationMs: Math.max(0, nowMs() - start)
    };
    return { results: results, allResults: allResults, stats: stats };
  }

  return {
    VERSION: VERSION,
    STATUS_META: STATUS_META,
    SOURCE_LABELS: SOURCE_LABELS,
    cleanToken: cleanToken,
    decodeSValue: decodeSValue,
    normalizeBase64: normalizeBase64,
    looksLikeBase64: looksLikeBase64,
    decodeBase64Utf8: function (value) { return decodeChain(value).text; },
    decodeChain: decodeChain,
    extractSParam: extractSParam,
    extractFirebaseUrls: extractFirebaseUrls,
    extractApiKeys: extractApiKeys,
    canonicalFirebaseUrl: canonicalFirebaseUrl,
    inferProjectId: inferProjectId,
    maskSecret: maskSecret,
    toTimestampMs: toTimestampMs,
    splitPayloadSegments: splitPayloadSegments,
    isPipeDelimitedPayload: isPipeDelimitedPayload,
    decodeVantageShare: decodeVantageShare,
    decodeMergedShare: decodeMergedShare,
    parsePayload: parsePayload,
    resolvePayload: resolvePayload,
    inspect: inspect,
    extractCandidates: extractCandidates,
    processBulk: processBulk
  };
});
