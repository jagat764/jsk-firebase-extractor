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

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
if (failed) process.exitCode = 1;
