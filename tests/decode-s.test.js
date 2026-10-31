#!/usr/bin/env node
/*!
 * Tests for the single-pipe (|) payload format and the decode-s CLI.
 * Run with: node tests/decode-s.test.js
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var os = require('os');
var childProcess = require('child_process');

var D = require(path.join(__dirname, '..', 'decoder.js'));
var cli = require(path.join(__dirname, '..', 'decode-s.js'));

var NOW = 1794000000000; // 2026-11-06, after the sample expiry
var BASE = 'https://sample-pipe-default-rtdb.firebaseio.com';

function b64(text) {
  return Buffer.from(text, 'utf-8').toString('base64');
}

// Build a VANTAGE share value: base64url(XOR(JSON {u,k,l,e})).
function vantage(obj) {
  var bytes = Buffer.from(JSON.stringify(obj), 'utf-8');
  var out = Buffer.alloc(bytes.length);
  var key = cli.VANTAGE_XOR_KEY;
  for (var i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ key.charCodeAt(i % key.length);
  return out.toString('base64url');
}

var VANTAGE_URL = 'https://vantagepanel.netlify.app/?s=DUMbVltFDQQVHhZWWR4xNRtYAzFVBWNTFCpVAz5CRzpHByQWHz1DPwAkRhYoXxcVDgNWTUUOUltMJCAweBECJGY9EWJVYhUdbg5UEVkEJlYAMl0ddh14B2cPQzw';
var VANTAGE_FB = 'https://nmpanagr-default-rtdb.firebaseio.com';

// Build a merged-connections value: base64url(encodeURIComponent(JSON list)).
function merged(list) {
  return Buffer.from(encodeURIComponent(JSON.stringify(list)), 'utf-8').toString('base64url');
}
var MERGED_LIST = [
  { url: 'https://merged-one-default-rtdb.firebaseio.com', key: 'KEYONE' },
  { url: 'https://merged-two-default-rtdb.firebaseio.com', key: 'KEYTWO' },
  { url: 'https://merged-one-default-rtdb.firebaseio.com', key: 'KEYONE' },
  { url: 'not-a-url', key: 'BAD' }
];
var MERGED_VALUE = merged(MERGED_LIST);
var MERGED_URL = 'https://vantagepanel.netlify.app/?m=' + MERGED_VALUE;
var MERGED_FB1 = 'https://merged-one-default-rtdb.firebaseio.com';
var MERGED_FB2 = 'https://merged-two-default-rtdb.firebaseio.com';

function run(args) {
  return childProcess.spawnSync(process.execPath, [path.join(__dirname, '..', 'decode-s.js')].concat(args), {
    encoding: 'utf-8'
  });
}

var passed = 0;
var failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    console.log('  ✗ ' + name);
    console.log('    ' + String(err && err.message ? err.message : err).split('\n').join('\n    '));
  }
}

console.log('\ndecodeS()');

test('decodes a single-pipe payload from a raw s value', function () {
  var r = cli.decodeS(b64(BASE + '|KEY123|1793105515015|device-123'));
  assert.strictEqual(r.error, undefined);
  assert.strictEqual(r.raw, BASE + '|KEY123|1793105515015|device-123');
  assert.strictEqual(r.firebase_url, BASE + '/');
  assert.deepStrictEqual(r.trailing, ['KEY123', '1793105515015', 'device-123']);
});

test('accepts a full share URL', function () {
  var s = b64(BASE + '|KEY|1793105515015');
  var r = cli.decodeS('https://vantagepanel.netlify.app/?s=' + s);
  assert.strictEqual(r.firebase_url, BASE + '/');
  assert.deepStrictEqual(r.trailing, ['KEY', '1793105515015']);
});

test('accepts an s= assignment', function () {
  var r = cli.decodeS('s=' + b64(BASE + '|KEY'));
  assert.strictEqual(r.firebase_url, BASE + '/');
  assert.deepStrictEqual(r.trailing, ['KEY']);
});

test('adds missing Base64 padding', function () {
  var s = b64(BASE + '|KEY|1793105515015').replace(/=+$/, '');
  var r = cli.decodeS(s);
  assert.strictEqual(r.raw, BASE + '|KEY|1793105515015');
  assert.ok(r.padding >= 0 && r.padding <= 2);
});

test('does not report padding that was already present', function () {
  var r = cli.decodeS(b64(BASE + '|KEY'));
  assert.strictEqual(r.padding, 0);
});

test('falls back to the URL-safe alphabet', function () {
  // "K??" encodes to a value containing "_", exercising the URL-safe path.
  var s = Buffer.from(BASE + '|K??|1793105515015|dev', 'utf-8').toString('base64url');
  assert.ok(s.indexOf('_') !== -1);
  assert.strictEqual(cli.decodeS(s).error, undefined);
  var r = cli.decodeS(s);
  assert.strictEqual(r.firebase_url, BASE + '/');
  assert.strictEqual(r.url_safe, true);
  assert.deepStrictEqual(r.trailing, ['K??', '1793105515015', 'dev']);
});

test('URL-safe input is not corrupted by the standard decoder', function () {
  var s = Buffer.from(BASE + '|K??|1793105515015|dev', 'utf-8').toString('base64url');
  var r = cli.decodeS(s);
  assert.strictEqual(r.raw, BASE + '|K??|1793105515015|dev');
});

test('keeps field order for the legacy ||| separator', function () {
  var r = cli.decodeS(b64(BASE + '|||Gg|||1793105515015'));
  assert.strictEqual(r.firebase_url, BASE + '/');
  assert.deepStrictEqual(r.trailing, ['Gg', '1793105515015']);
});

test('rejects an empty value', function () {
  assert.strictEqual(cli.decodeS('').error, 'empty_s_param');
  assert.strictEqual(cli.decodeS('   ').error, 'empty_s_param');
});

test('rejects invalid Base64 characters', function () {
  assert.strictEqual(cli.decodeS('not-base64!!!').error, 'invalid_base64_chars');
});

test('rejects an impossible Base64 length', function () {
  assert.strictEqual(cli.decodeS('abcde').error, 'invalid_base64_length');
});

test('warns instead of failing when field 1 is not Firebase', function () {
  var r = cli.decodeS(b64('https://example.com|KEY'));
  assert.strictEqual(r.firebase_url, 'https://example.com/');
  assert.ok(r.warnings.join(' ').indexOf('Firebase') !== -1);
});

console.log('\nVANTAGE share links (Base64 + XOR JSON)');

test('decodes the real VANTAGE share link', function () {
  var r = cli.decodeS(VANTAGE_URL);
  assert.strictEqual(r.error, undefined);
  assert.strictEqual(r.format, 'vantage-xor');
  assert.strictEqual(r.firebase_url, VANTAGE_FB + '/');
  assert.strictEqual(r.connection.key, 'ALFINZO_PAP');
  assert.strictEqual(r.connection.label, 'Connected');
  assert.strictEqual(r.connection.permanent, true);
  assert.deepStrictEqual(r.trailing, ['ALFINZO_PAP', 'Connected', 'permanent']);
});

test('decodes a bare VANTAGE value with no padding', function () {
  var s = VANTAGE_URL.split('?s=')[1];
  var r = cli.decodeS(s);
  assert.strictEqual(r.firebase_url, VANTAGE_FB + '/');
  assert.strictEqual(r.raw, '{"u":"' + VANTAGE_FB + '","k":"ALFINZO_PAP","l":"Connected","e":0}');
});

test('reads url/label/expiry from the JSON payload', function () {
  var s = vantage({ u: BASE, k: 'KEY', l: 'Temp', e: 1800000000000 });
  var r = cli.decodeS('https://x.netlify.app/?s=' + s);
  assert.strictEqual(r.firebase_url, BASE + '/');
  assert.strictEqual(r.connection.label, 'Temp');
  assert.strictEqual(r.connection.expiry, 1800000000000);
  assert.strictEqual(r.connection.permanent, false);
});

test('warns when a VANTAGE link has already expired', function () {
  var r = cli.decodeS(vantage({ u: BASE, k: 'K', l: '', e: 1793105515015 }));
  assert.ok(r.warnings.join(' ').indexOf('in the past') !== -1);
});

test('does not treat random Base64 as a VANTAGE link', function () {
  var r = cli.decodeS(b64('hello world, just some text'));
  assert.strictEqual(r.format, 'base64');
  assert.strictEqual(r.connection, undefined);
});

test('CLI prints the VANTAGE URL for panels.txt', function () {
  var out = run([VANTAGE_URL, '--quiet']);
  assert.strictEqual(out.status, 0);
  assert.strictEqual(out.stdout.trim(), VANTAGE_FB + '/');
});

test('CLI --json exposes the connection object', function () {
  var out = run([VANTAGE_URL, '--json']);
  var parsed = JSON.parse(out.stdout);
  assert.strictEqual(parsed.format, 'vantage-xor');
  assert.strictEqual(parsed.connection.url, VANTAGE_FB);
  assert.strictEqual(parsed.connection.key, 'ALFINZO_PAP');
});

console.log('\nVANTAGE merged connections (JSON array)');

test('decodes a ?m= merged link', function () {
  var r = cli.decodeS(MERGED_URL);
  assert.strictEqual(r.error, undefined);
  assert.strictEqual(r.format, 'merged');
  assert.strictEqual(r.firebase_url, MERGED_FB1 + '/');
  assert.deepStrictEqual(r.urls, [MERGED_FB1 + '/', MERGED_FB2 + '/']);
  assert.strictEqual(r.connections.length, 2);
  assert.deepStrictEqual(r.connections[0], { url: MERGED_FB1, key: 'KEYONE' });
});

test('dedupes merged connections and drops invalid entries', function () {
  var r = cli.decodeS(MERGED_URL);
  assert.strictEqual(r.connections.length, 2);
  assert.ok(!r.connections.some(function (c) { return c.url === 'not-a-url'; }));
});

test('accepts a bare merged value and an m= assignment', function () {
  assert.strictEqual(cli.decodeS(MERGED_VALUE).urls.length, 2);
  assert.strictEqual(cli.decodeS('m=' + MERGED_VALUE).urls.length, 2);
});

test('rejects a broken ?m= value with a clear error', function () {
  var r = cli.decodeS('https://vantagepanel.netlify.app/?m=' + b64('hello world'));
  assert.strictEqual(r.error, 'invalid_merged_payload');
});

test('--quiet prints every merged Firebase URL', function () {
  var out = run([MERGED_URL, '--quiet']);
  assert.strictEqual(out.status, 0);
  assert.deepStrictEqual(out.stdout.trim().split('\n'), [MERGED_FB1 + '/', MERGED_FB2 + '/']);
});

test('CLI --json exposes all merged connections', function () {
  var out = run([MERGED_URL, '--json']);
  var parsed = JSON.parse(out.stdout);
  assert.strictEqual(parsed.format, 'merged');
  assert.strictEqual(parsed.connections.length, 2);
  assert.strictEqual(parsed.connections[1].key, 'KEYTWO');
});

test('does not treat a JSON array of strings as merged', function () {
  var s = Buffer.from(encodeURIComponent(JSON.stringify(['https://a-default-rtdb.firebaseio.com'])), 'utf-8').toString('base64url');
  var r = cli.decodeS(s);
  assert.notStrictEqual(r.format, 'merged');
});

console.log('\nextractSFromUrl()');

test('reads ?s= from a URL', function () {
  assert.strictEqual(cli.extractSFromUrl('https://x.netlify.app/?s=ABC123'), 'ABC123');
});

test('reads s= when it is not the first parameter', function () {
  assert.strictEqual(cli.extractSFromUrl('https://x.netlify.app/?a=1&s=ABC123'), 'ABC123');
});

test('returns null when there is no s param', function () {
  assert.strictEqual(cli.extractSFromUrl('https://x.netlify.app/?a=1'), null);
});

console.log('\nCLI');

test('prints the panels.txt line', function () {
  var out = run([b64(BASE + '|KEY|1793105515015')]);
  assert.strictEqual(out.status, 0);
  assert.ok(out.stdout.indexOf('panels.txt') !== -1);
  assert.ok(out.stdout.indexOf(BASE + '/') !== -1);
});

test('--quiet prints only the Firebase URL', function () {
  var out = run([b64(BASE + '|KEY'), '--quiet']);
  assert.strictEqual(out.status, 0);
  assert.strictEqual(out.stdout.trim(), BASE + '/');
});

test('--json prints machine-readable output', function () {
  var out = run([b64(BASE + '|KEY|123'), '--json']);
  var parsed = JSON.parse(out.stdout);
  assert.strictEqual(parsed.firebase_url, BASE + '/');
  assert.deepStrictEqual(parsed.trailing, ['KEY', '123']);
});

test('exits 3 for an undecodable value', function () {
  var out = run(['not-base64!!!']);
  assert.strictEqual(out.status, 3);
  assert.ok(out.stderr.indexOf('decode failed') !== -1);
});

test('decodes every line from stdin with -', function () {
  var input = b64(BASE + '|K1') + '\n' + b64('https://second-default-rtdb.firebaseio.com|K2') + '\n';
  var out = childProcess.spawnSync(process.execPath, [path.join(__dirname, '..', 'decode-s.js'), '-'], {
    input: input,
    encoding: 'utf-8'
  });
  assert.strictEqual(out.status, 0);
  assert.ok(out.stdout.indexOf(BASE + '/') !== -1);
  assert.ok(out.stdout.indexOf('https://second-default-rtdb.firebaseio.com/') !== -1);
});

console.log('\ndecoder core integration');

test('classifies a single-pipe payload as pipe-payload', function () {
  var r = D.inspect(BASE + '|KEY123|1793105515015|device-123', { now: NOW });
  assert.strictEqual(r.sourceType, 'pipe-payload');
  assert.strictEqual(r.sourceTypeLabel, 'Pipe-delimited payload');
  assert.strictEqual(r.status, 'EXPIRED');
  assert.strictEqual(r.segments.length, 4);
});

test('extracts credential, expiry and device from single-pipe fields', function () {
  var r = D.inspect(BASE + '|KEY123|1793105515015|device-123', { now: NOW });
  assert.ok(r.credential && r.credential.masked !== 'KEY123');
  assert.strictEqual(r.expiresAt.raw, '1793105515015');
  assert.strictEqual(r.deviceId, 'device-123');
});

test('decodes a Base64 single-pipe link through the core', function () {
  var r = D.inspect(b64(BASE + '|KEY123|1793105515015'), { now: NOW });
  assert.strictEqual(r.primaryUrl.url, BASE);
  assert.strictEqual(r.sourceType, 'raw-base64');
  assert.strictEqual(r.decodeCount, 1);
  assert.strictEqual(r.segments.length, 3);
});

test('still handles the legacy ||| payload', function () {
  var r = D.inspect(BASE + '|||Gg|||1793105515015|||device-1', { now: NOW });
  assert.strictEqual(r.sourceType, 'payload');
  assert.strictEqual(r.segments.length, 4);
  assert.strictEqual(r.deviceId, 'device-1');
});

test('tolerates spaces around single pipes', function () {
  var r = D.inspect(BASE + ' | KEY | 1793105515015 | dev', { now: NOW });
  assert.strictEqual(r.sourceType, 'pipe-payload');
  assert.strictEqual(r.segments.length, 4);
  assert.strictEqual(r.deviceId, 'dev');
});

test('does not misclassify prose containing a pipe', function () {
  assert.strictEqual(D.isPipeDelimitedPayload('Some prose | with a pipe'), false);
  assert.strictEqual(D.isPipeDelimitedPayload('https://example.com|not-firebase'), false);
  assert.strictEqual(D.isPipeDelimitedPayload(BASE + '|'), false);
  var r = D.inspect('Some prose | with a pipe', { now: NOW });
  assert.strictEqual(r.status, 'INVALID');
});

test('bulk mode recognises single-pipe lines', function () {
  var input = [
    BASE + '|K1|1793105515015',
    'https://second-default-rtdb.firebaseio.com | K2 | 1793105515015 | device-2',
    'not a link at all'
  ].join('\n');
  var out = D.processBulk(input, { now: NOW });
  assert.strictEqual(out.stats.total, 3);
  assert.strictEqual(out.results[0].sourceType, 'pipe-payload');
  assert.strictEqual(out.results[1].sourceType, 'pipe-payload');
  assert.strictEqual(out.results[2].status, 'INVALID');
});

test('exports the pipe detector', function () {
  assert.strictEqual(typeof D.isPipeDelimitedPayload, 'function');
});

test('classifies a VANTAGE share link as vantage-share', function () {
  var r = D.inspect(VANTAGE_URL, { now: NOW });
  assert.strictEqual(r.status, 'VALID');
  assert.strictEqual(r.sourceType, 'vantage-share');
  assert.strictEqual(r.sourceTypeLabel, 'VANTAGE share link');
  assert.strictEqual(r.encoding, 'XOR + Base64');
  assert.strictEqual(r.primaryUrl.url, VANTAGE_FB);
  assert.strictEqual(r.projectId, 'nmpanagr');
});

test('masks the VANTAGE credential and keeps the label', function () {
  var r = D.inspect(VANTAGE_URL, { now: NOW });
  assert.ok(r.credential);
  assert.strictEqual(r.credential.value, 'ALFINZO_PAP');
  assert.notStrictEqual(r.credential.masked, 'ALFINZO_PAP');
  var label = r.segments.find(function (s) { return s.label === 'Label'; });
  assert.ok(label);
  assert.strictEqual(label.value, 'Connected');
});

test('reports a permanent VANTAGE link without an expiry warning', function () {
  var r = D.inspect(VANTAGE_URL, { now: NOW });
  assert.strictEqual(r.expiresAt, null);
  assert.strictEqual(r.warnings.length, 0);
  assert.ok(r.messages.join(' ').indexOf('permanent') !== -1);
});

test('detects an expired VANTAGE temporary link', function () {
  var s = vantage({ u: BASE, k: 'K', l: 'Temp', e: 1793105515015 });
  var r = D.inspect('https://x.netlify.app/?s=' + s, { now: NOW });
  assert.strictEqual(r.status, 'EXPIRED');
  assert.strictEqual(r.expiresAt.raw, '1793105515015');
});

test('detects a still-valid VANTAGE temporary link', function () {
  var s = vantage({ u: BASE, k: 'K', l: 'Temp', e: 1800000000000 });
  var r = D.inspect('https://x.netlify.app/?s=' + s, { now: NOW });
  assert.strictEqual(r.status, 'VALID');
  assert.strictEqual(r.expiresAt.raw, '1800000000000');
});

test('decodes a bare VANTAGE value in the core', function () {
  var s = VANTAGE_URL.split('?s=')[1];
  var r = D.inspect(s, { now: NOW });
  assert.strictEqual(r.sourceType, 'vantage-share');
  assert.strictEqual(r.primaryUrl.url, VANTAGE_FB);
});

test('bulk mode recognises VANTAGE links', function () {
  var input = [VANTAGE_URL, BASE + '|K1|1793105515015', 'not a link'].join('\n');
  var out = D.processBulk(input, { now: NOW });
  assert.strictEqual(out.stats.total, 3);
  assert.strictEqual(out.results[0].sourceType, 'vantage-share');
  assert.strictEqual(out.results[1].sourceType, 'pipe-payload');
  assert.strictEqual(out.results[2].status, 'INVALID');
});

test('exports the VANTAGE decoder', function () {
  assert.strictEqual(typeof D.decodeVantageShare, 'function');
  assert.strictEqual(D.decodeVantageShare('hello'), null);
});

test('classifies a merged link as merged-share with every endpoint', function () {
  var r = D.inspect(MERGED_URL, { now: NOW });
  assert.strictEqual(r.status, 'VALID');
  assert.strictEqual(r.sourceType, 'merged-share');
  assert.strictEqual(r.sourceTypeLabel, 'VANTAGE merged connections');
  assert.deepStrictEqual(r.firebaseUrls.map(function (u) { return u.url; }), [MERGED_FB1, MERGED_FB2]);
  assert.strictEqual(r.primaryUrl.url, MERGED_FB1);
});

test('masks the first merged credential and labels each connection', function () {
  var r = D.inspect(MERGED_URL, { now: NOW });
  assert.ok(r.credential);
  assert.strictEqual(r.credential.value, 'KEYONE');
  assert.notStrictEqual(r.credential.masked, 'KEYONE');
  assert.deepStrictEqual(r.segments.map(function (s) { return s.label; }), ['Connection 1', 'Connection 2']);
  assert.ok(r.segments[0].value.indexOf(MERGED_FB1 + ' | KEYONE') !== -1);
});

test('merged links do not emit a missing-expiry warning', function () {
  var r = D.inspect(MERGED_URL, { now: NOW });
  assert.strictEqual(r.expiresAt, null);
  assert.ok(!r.warnings.some(function (w) { return /expiry/i.test(w); }));
  assert.ok(r.messages.join(' ').indexOf('2 connections') !== -1);
});

test('decodes a bare merged value in the core', function () {
  var r = D.inspect(MERGED_VALUE, { now: NOW });
  assert.strictEqual(r.sourceType, 'merged-share');
  assert.strictEqual(r.firebaseUrls.length, 2);
});

test('bulk mode recognises merged links', function () {
  var out = D.processBulk([MERGED_URL, VANTAGE_URL].join('\n'), { now: NOW });
  assert.strictEqual(out.stats.uniqueFirebaseUrls, 3);
  assert.strictEqual(out.results[0].sourceType, 'merged-share');
  assert.strictEqual(out.results[1].sourceType, 'vantage-share');
});

test('exports the merged decoder', function () {
  assert.strictEqual(typeof D.decodeMergedShare, 'function');
  assert.strictEqual(D.decodeMergedShare('hello'), null);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
if (failed) process.exitCode = 1;
