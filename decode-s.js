#!/usr/bin/env node
/*!
 * LinkScope — decode-s CLI (single-pipe payloads)
 * 100% local text parsing. No fetch(), no network calls, no telemetry.
 *
 * Decodes a ?s= Base64 parameter and turns either payload shape
 *   FIREBASE_URL|CREDENTIAL|EXPIRY_MS|OPTIONAL_DEVICE_ID
 *   base64url( XOR( {"u":URL,"k":KEY,"l":LABEL,"e":EXPIRY_MS} ) )   [VANTAGE]
 * into a clean Firebase URL ready to paste into panels.txt.
 *
 * Usage:
 *   node decode-s.js https://site.netlify.app/?s=XXXX
 *   node decode-s.js XXXX
 *   node decode-s.js "s=XXXX"
 *   node decode-s.js - < links.txt
 *   node decode-s.js XXXX --json
 *   node decode-s.js XXXX --quiet
 */
'use strict';

var USAGE = [
  'usage: node decode-s.js <url_or_param> [--json] [--quiet]',
  '  accepts:',
  '    - full share URL   https://vantagepanel.netlify.app/?s=XXXX',
  '    - full merged URL  https://vantagepanel.netlify.app/?m=XXXX',
  '    - just the s value XXXX',
  '    - an s= / m= assignment',
  '    - "-" to read one value per line from stdin',
  '',
  '  decodes:',
  '    - Base64 pipe payloads      URL|KEY|EXPIRY|DEVICE (or |||)',
  '    - VANTAGE share links       base64url(XOR(JSON {u,k,l,e}))',
  '    - VANTAGE merged links      base64url(JSON [{url,key}, ...])',
  '',
  '  flags:',
  '    --json    print the decoded result as JSON',
  '    --quiet   print only the Firebase URL (good for panels.txt)'
].join('\n');

var FIREBASE_OR_HTTP_RE = /firebase|https?:\/\//i;
var PRINTABLE_RE = /^[\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]*$/;

// VANTAGE share links wrap the payload as base64url(XOR(JSON{u,k,l,e})).
// The fixed key is the app's public client-side fallback key.
var VANTAGE_XOR_KEY = 'vantagepanelv1_Xk9mP2wN7qL4vR6jH3cF8yT1ZbE5sA09';

function isPrintable(text) {
  return typeof text === 'string' && text.length > 0 && PRINTABLE_RE.test(text);
}

function padBase64(value) {
  var s = String(value == null ? '' : value).replace(/\s/g, '');
  if (!s) return s;
  var rem = s.length % 4;
  if (rem === 1) return s; // impossible Base64 length — leave it for validation
  if (rem) s += '='.repeat(4 - rem);
  return s;
}

function looksLikeBase64(value) {
  return /^[A-Za-z0-9+/=_-]+$/.test(String(value == null ? '' : value).replace(/\s/g, ''));
}

function decodeBase64Utf8(value) {
  var padded = padBase64(value);
  if (!padded) return { error: 'empty_value' };
  if (!looksLikeBase64(padded)) return { error: 'invalid_base64_chars', detail: 'unexpected character in Base64 value' };
  if (padded.length % 4 !== 0) return { error: 'invalid_base64_length', detail: 'Base64 length ' + padded.length + ' is not a multiple of 4' };
  try {
    var buffer = Buffer.from(padded, 'base64');
    if (!buffer.length) return { error: 'b64_decode_failed', detail: 'decoded to zero bytes' };
    var original = String(value == null ? '' : value).replace(/\s/g, '');
    return {
      text: buffer.toString('utf-8'),
      bytes: new Uint8Array(buffer),
      padding: Math.max(0, padded.length - original.length)
    };
  } catch (e) {
    return { error: 'b64_decode_failed', detail: String(e) };
  }
}

/**
 * Try the VANTAGE share format: base64url(XOR(JSON {u,k,l,e})).
 * @param {Uint8Array} bytes Base64-decoded bytes
 * @returns {{url:string,key:string,label:string,expiry:number,text:string}|null}
 */
function decodeVantageBytes(bytes) {
  if (!bytes || bytes.length < 16) return null;
  var out = new Uint8Array(bytes.length);
  for (var i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ VANTAGE_XOR_KEY.charCodeAt(i % VANTAGE_XOR_KEY.length);
  var text;
  try {
    text = Buffer.from(out).toString('utf-8');
  } catch (e) {
    return null;
  }
  if (!isPrintable(text)) return null;
  var obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  var url = String(obj.u != null ? obj.u : (obj.url != null ? obj.url : '')).trim();
  if (!/^https?:\/\//i.test(url)) return null;
  var key = String(obj.k != null ? obj.k : (obj.key != null ? obj.key : ''));
  var label = String(obj.l != null ? obj.l : (obj.label != null ? obj.label : ''));
  var expiry = Number(obj.e != null ? obj.e : (obj.exp != null ? obj.exp : 0)) || 0;
  return { url: url, key: key, label: label, expiry: expiry, text: text };
}

/**
 * Decode a share value: single-pipe payload, VANTAGE ?s= link or ?m= merged
 * connections link.
 * @param {string} sParam raw value, "s="/"m=" assignment, or full URL
 * @returns {{raw:string, firebase_url:string, trailing:string[], url_safe:boolean,
 *            padding:number, warnings:string[], input_s:string}|{error:string, detail?:string}}
 */
function decodeS(sParam) {
  var input = String(sParam == null ? '' : sParam).trim();
  if (!input) return { error: 'empty_s_param' };

  // Accept a full URL, an "s=..."/"m=..." assignment, or a bare value.
  var s = input;
  var fromMergedUrl = false;
  if (/^https?:/i.test(s)) {
    var fromUrl = extractSFromUrl(s);
    if (fromUrl) {
      s = fromUrl;
    } else {
      var fromM = extractMFromUrl(s);
      if (!fromM) return { error: 'missing_s_param' };
      s = fromM;
      fromMergedUrl = true;
    }
  } else {
    s = s.replace(/^(?:s|m)\s*=\s*/i, '');
    try { s = decodeURIComponent(s); } catch (e) { /* keep raw */ }
  }
  s = s.replace(/\s/g, '');
  if (!s) return { error: 'empty_s_param' };

  var warnings = [];

  // URL-safe Base64 uses "-" and "_" instead of "+" and "/". Node's decoder
  // silently ignores those characters, which corrupts the payload, so when
  // they appear the URL-safe alphabet is tried first.
  var urlSafe = /[-_]/.test(s);
  var candidates = [];
  if (urlSafe) candidates.push({ value: s.replace(/-/g, '+').replace(/_/g, '/'), urlSafe: true });
  candidates.push({ value: s, urlSafe: false });

  var decoded = null;
  var firstError = null;
  var usedUrlSafe = false;
  for (var i = 0; i < candidates.length; i++) {
    var attempt = decodeBase64Utf8(candidates[i].value);
    if (attempt.error) {
      if (!firstError) firstError = attempt;
      continue;
    }
    if (!decoded) decoded = attempt;
    if (isPrintable(attempt.text) && FIREBASE_OR_HTTP_RE.test(attempt.text)) {
      decoded = attempt;
      usedUrlSafe = candidates[i].urlSafe;
      break;
    }
  }

  if (!decoded) return { error: firstError.error, detail: firstError.detail };

  var raw = decoded.text;
  var padding = decoded.padding || 0;

  // Merged connections decode to readable percent-encoded JSON, so check this
  // before the printable/pipe split below.
  var merged = decodeMergedBytes(decoded.bytes);
  if (merged) return mergedResult(merged, s, usedUrlSafe, padding);
  if (fromMergedUrl) {
    return { error: 'invalid_merged_payload', detail: 'm= value is not a JSON connection list' };
  }

  if (!isPrintable(raw)) {
    // Not readable text — maybe a VANTAGE share link (Base64 + XOR JSON).
    var vantage = decodeVantageBytes(decoded.bytes);
    if (vantage) {
      var fbV = vantage.url;
      if (!fbV.endsWith('/')) fbV += '/';
      var vWarnings = [];
      if (!vantage.key) vWarnings.push('payload has no credential field');
      if (vantage.expiry && vantage.expiry <= Date.now()) vWarnings.push('link expiry is in the past');
      return {
        input_s: s,
        raw: vantage.text,
        firebase_url: fbV,
        trailing: [vantage.key, vantage.label, vantage.expiry ? String(vantage.expiry) : 'permanent'].filter(function (v) { return !!v; }),
        connection: {
          url: vantage.url,
          key: vantage.key,
          label: vantage.label,
          expiry: vantage.expiry,
          permanent: !vantage.expiry
        },
        format: 'vantage-xor',
        url_safe: usedUrlSafe,
        padding: padding,
        warnings: vWarnings
      };
    }
    return { error: 'not_text', detail: 'Base64 decoded to binary data, not a readable payload' };
  }

  // Split trailing metadata after "|". Empty fields (as produced by the older
  // "|||" separator) are dropped, but field order is preserved.
  var parts = raw.split('|');
  var fb = (parts[0] || '').trim();
  if (fb && !fb.endsWith('/')) fb += '/';

  var trailing = parts.slice(1).map(function (v) { return String(v).trim(); }).filter(function (v) { return v !== ''; });

  if (!fb) warnings.push('payload has no Firebase URL in field 1');
  else if (!/^https?:\/\//i.test(fb)) warnings.push('field 1 is not an http(s) URL');
  if (!/firebase/i.test(fb)) warnings.push('field 1 does not look like a Firebase host');
  if (!trailing.length) warnings.push('payload has no trailing metadata fields');

  return {
    input_s: s,
    raw: raw,
    firebase_url: fb,
    trailing: trailing,
    format: 'base64',
    url_safe: usedUrlSafe,
    padding: padding,
    warnings: warnings
  };
}

/**
 * Pull the s= value out of a share URL.
 * @param {string} url
 * @returns {string|null}
 */
function extractSFromUrl(url) {
  var text = String(url == null ? '' : url).trim();
  if (!text) return null;
  try {
    var u = new URL(text);
    var direct = u.searchParams.get('s');
    if (direct) return direct;
    var names = ['s', 'd', 'data', 'encoded', 'token', 'payload', 'share', 'link'];
    for (var i = 0; i < names.length; i++) {
      var v = u.searchParams.get(names[i]);
      if (v) return v;
    }
    return null;
  } catch (_) {
    // Not an absolute URL — fall back to a plain regex.
    var m = text.match(/[?&#]s=([^&#\s]+)/i) || text.match(/^s=([^&#\s]+)/i);
    return m && m[1] ? m[1] : null;
  }
}

/**
 * Pull the m= (merged connections) value out of a share URL.
 * @param {string} url
 * @returns {string|null}
 */
function extractMFromUrl(url) {
  var text = String(url == null ? '' : url).trim();
  if (!text) return null;
  try {
    var u = new URL(text);
    var direct = u.searchParams.get('m');
    if (direct) return direct;
    return null;
  } catch (_) {
    var m = text.match(/[?&#]m=([^&#\s]+)/i) || text.match(/^m=([^&#\s]+)/i);
    return m && m[1] ? m[1] : null;
  }
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

/**
 * Try the VANTAGE merged-connections format:
 * base64url( encodeURIComponent( JSON [ {url,key}, ... ] ) ).
 * @param {Uint8Array} bytes Base64-decoded bytes
 * @returns {{items:Array<{url:string,key:string}>,text:string}|null}
 */
function decodeMergedBytes(bytes) {
  if (!bytes || bytes.length < 8) return null;
  var text;
  try {
    text = Buffer.from(bytes).toString('utf-8');
  } catch (e) {
    return null;
  }
  if (!isPrintable(text)) return null;
  var jsonText = text;
  if (/%[0-9A-Fa-f]{2}/.test(text)) {
    try {
      jsonText = decodeURIComponent(text);
    } catch (e) {
      return null;
    }
  }
  var list;
  try {
    list = JSON.parse(jsonText);
  } catch (e) {
    return null;
  }
  if (!Array.isArray(list) || !list.length) return null;
  var items = normalizeMergedItems(list);
  if (!items.length) return null;
  return { items: items, text: jsonText };
}

function mergedResult(merged, s, urlSafe, padding) {
  var urls = merged.items.map(function (x) { return x.url + '/'; });
  return {
    input_s: s,
    raw: merged.text,
    firebase_url: urls[0],
    urls: urls,
    trailing: [],
    connections: merged.items,
    format: 'merged',
    url_safe: urlSafe,
    padding: padding,
    warnings: merged.items.some(function (x) { return !x.key; })
      ? ['some connections have no credential field']
      : []
  };
}

function parseArgs(argv) {
  var args = { input: null, json: false, quiet: false, help: false };
  argv.forEach(function (arg) {
    if (arg === '--json') args.json = true;
    else if (arg === '--quiet' || arg === '-q') args.quiet = true;
    else if (arg === '-h' || arg === '--help') args.help = true;
    else if (!args.input) args.input = arg;
  });
  return args;
}

function readStdin() {
  try {
    return require('fs').readFileSync(0, 'utf-8');
  } catch (e) {
    return '';
  }
}

function describe(result, input) {
  var line = '='.repeat(60);
  var out = [];
  out.push(line);
  out.push('input      : ' + input);
  if (result.format === 'vantage-xor') out.push('format     : VANTAGE share link (Base64 + XOR JSON)');
  if (result.format === 'merged') out.push('format     : VANTAGE merged connections (JSON array)');
  out.push('raw        : ' + result.raw);
  out.push('firebase   : ' + result.firebase_url);
  if (result.trailing.length) out.push('trailing   : ' + result.trailing.join(' | '));
  if (result.connections) {
    out.push('connections: ' + result.connections.length);
    result.connections.forEach(function (c, i) {
      out.push('  ' + (i + 1) + '. ' + c.url + (c.key ? ' | ' + c.key : ''));
    });
  }
  if (result.connection) {
    if (result.connection.label) out.push('label      : ' + result.connection.label);
    out.push('expiry     : ' + (result.connection.permanent
      ? 'permanent (0)'
      : new Date(result.connection.expiry).toISOString()));
  }
  if (result.url_safe) out.push('encoding   : URL-safe Base64 (- / _)');
  if (result.padding) out.push('padding    : ' + result.padding + ' "=" added');
  result.warnings.forEach(function (w) { out.push('[!] ' + w); });
  out.push(line);
  out.push('');
  out.push('→ drop this in panels.txt:');
  (result.urls || [result.firebase_url]).forEach(function (url) {
    out.push('   ' + url);
  });
  return out.join('\n');
}

function runOne(input, flags) {
  var result = decodeS(input);
  if (result.error) {
    if (flags.json) console.log(JSON.stringify({ input: input, error: result.error, detail: result.detail || null }, null, 2));
    else console.error('[!] decode failed: ' + result.error + (result.detail ? ' (' + result.detail + ')' : ''));
    return 3;
  }
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else if (flags.quiet) (result.urls || [result.firebase_url]).forEach(function (url) { console.log(url); });
  else {
    console.log(describe(result, input.trim()));
    console.log();
  }
  return 0;
}

function main(argv) {
  var args = parseArgs(argv || process.argv.slice(2));
  if (args.help) { console.log(USAGE); return 0; }

  var input = args.input;

  // No argument and piped stdin: decode every non-empty line.
  if (!input && !process.stdin.isTTY) {
    var lines = readStdin().split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    if (!lines.length) {
      console.log(USAGE);
      return 1;
    }
    var failed = 0;
    lines.forEach(function (line) {
      var code = runOne(line, args);
      if (code) failed++;
    });
    return failed ? 3 : 0;
  }

  if (!input) {
    console.log(USAGE);
    return 1;
  }

  if (input === '-') {
    var piped = readStdin().split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    if (!piped.length) {
      console.error('[!] no input on stdin');
      return 1;
    }
    var bad = 0;
    piped.forEach(function (line) { if (runOne(line, args)) bad++; });
    return bad ? 3 : 0;
  }

  return runOne(input, args);
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  decodeS: decodeS,
  extractSFromUrl: extractSFromUrl,
  decodeVantageBytes: decodeVantageBytes,
  decodeMergedBytes: decodeMergedBytes,
  extractMFromUrl: extractMFromUrl,
  padBase64: padBase64,
  decodeBase64Utf8: decodeBase64Utf8,
  main: main,
  USAGE: USAGE,
  VANTAGE_XOR_KEY: VANTAGE_XOR_KEY
};
