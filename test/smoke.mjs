import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { AccessError, readText, metadata } from '../lib/files.mjs';
import { createWorkspace } from '../lib/workspace.mjs';
import { callTool, TOOLS } from '../lib/tools.mjs';
import { session, serve, MAX_MESSAGE_BYTES, PROTOCOL_VERSIONS } from '../lib/protocol.mjs';
import hooks from '../index.mjs';

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'career-ops-workspace-mcp-')));
let count = 0;
function check(name, fn) { fn(); count++; console.log(`ok ${count} - ${name}`); }
const put = (rel, text) => { const file = path.join(temp, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const request = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const init = version => request('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
const mock = { summary: () => ({ permissions: { write: false } }), list: args => ({ jobs: [], args }), get: id => ({ id }), files: id => ({ id }) };

try {
  check('exact read-only tool allowlist and annotations', () => {
    assert.deepStrictEqual(TOOLS.map(t => t.name), ['workspace_summary', 'list_jobs', 'get_job', 'get_application_files']);
    assert.ok(TOOLS.every(t => t.annotations.readOnlyHint && !t.annotations.destructiveHint && !t.annotations.openWorldHint));
    for (const name of ['set_status', 'set_important', 'delete_job', 'submit', 'read_file', 'run_command']) assert.throws(() => callTool(mock, name, {}), AccessError);
  });
  check('strict arguments, no hidden path override or permissive pagination', () => {
    for (const args of [{ path: 'cv.md' }, { codeRoot: '/' }, { limit: 201 }, { limit: 0 }, { limit: 1.5 }, { offset: -1 }, { processed: 'false' }, { collection: 'archive' }, { query: 'x'.repeat(201) }]) assert.throws(() => callTool(mock, 'list_jobs', args), AccessError);
    for (const id of ['../cv.md', 'application:1;do-something', 'inbox:no', 1, null]) assert.throws(() => callTool(mock, 'get_job', { id }), AccessError);
    assert.throws(() => callTool(mock, 'workspace_summary', JSON.parse('{"__proto__": {}}')), AccessError);
  });
  check('initialization gate and supported protocol negotiation', () => {
    for (const version of PROTOCOL_VERSIONS) {
      const handle = session(mock);
      assert.strictEqual(handle(request('tools/list')).error.code, -32000);
      assert.strictEqual(handle(init(version)).result.protocolVersion, version);
      assert.strictEqual(handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
      assert.strictEqual(handle(request('tools/list')).result.tools.length, 4);
      assert.strictEqual(handle(request('initialize', {})).error.code, -32602);
    }
    assert.strictEqual(session(mock)(init('future-version')).result.protocolVersion, PROTOCOL_VERSIONS[0]);
  });
  check('protocol denies writes, unknown methods and invalid arguments', () => {
    const handle = session(mock); handle(init(PROTOCOL_VERSIONS[0])); handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.strictEqual(handle(request('tools/call', { name: 'submit' })).error.code, -32602);
    assert.strictEqual(handle(request('resources/read', { uri: 'file:///cv.md' })).error.code, -32601);
    assert.ok(handle(request('tools/call', { name: 'list_jobs', arguments: { path: 'cv.md' } })).result.isError);
    assert.ok(handle(request('tools/call', { name: 'list_jobs', arguments: null })).result.isError);
    assert.strictEqual(handle(request('tools/list', { cursor: 'extra' })).error.code, -32602);
    for (const malformed of [[], {}, null, { jsonrpc: '2.0', id: null, method: 'ping' }]) assert.strictEqual(handle(malformed).error.code, -32600);
    assert.strictEqual(handle({ jsonrpc: '2.0', method: 'anything' }), null);
    assert.ok(handle(request('ping')).result);
  });
  check('UTF-8 line framing, parse errors, byte limit and recovery', () => {
    const input = new PassThrough(); const output = new PassThrough(); let wire = '';
    output.on('data', chunk => { wire += chunk.toString(); }); serve(mock, input, output);
    const encoded = Buffer.from(JSON.stringify(init(PROTOCOL_VERSIONS[0])).replace('smoke', '审阅'));
    for (const byte of encoded) input.write(Buffer.from([byte])); input.write('\r\n');
    input.write('broken json\n'); input.write('x'.repeat(MAX_MESSAGE_BYTES + 1)); input.write('\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    input.write(JSON.stringify(request('tools/list', {}, 9)) + '\n');
    const messages = wire.trim().split('\n').map(line => JSON.parse(line));
    assert.strictEqual(messages[0].result.protocolVersion, PROTOCOL_VERSIONS[0]);
    assert.strictEqual(messages[1].error.code, -32700); assert.strictEqual(messages[2].error.code, -32600);
    assert.strictEqual(messages[3].id, 9); assert.strictEqual(messages.length, 4);
    input.destroy(); output.destroy();
  });
  check('bounded file reads and scope-specific material metadata', () => {
    put('data/example.md', 'safe'); put('output/test.pdf', '%PDF-fictional'); put('reports/010.md', 'fictional report'); put('cv.md', 'must not expose');
    assert.strictEqual(readText(temp, path.join(temp, 'data/example.md')).text, 'safe');
    assert.throws(() => readText(temp, path.join(temp, 'data/example.md'), 3), AccessError);
    assert.throws(() => readText(temp, path.join(temp, '../outside.md')), AccessError);
    assert.strictEqual(metadata(temp, path.join(temp, 'cv.md'), 'output', '.pdf').reason, 'rejected-path');
    assert.strictEqual(metadata(temp, path.join(temp, 'reports/010.md'), 'output', '.pdf').reason, 'rejected-path');
    assert.strictEqual(metadata(temp, path.join(temp, 'output/missing.pdf'), 'output', '.pdf').reason, 'missing-file');
    assert.ok(metadata(temp, path.join(temp, 'output/test.pdf'), 'output', '.pdf').exists);
  });
  check('directory links cannot widen data permissions', () => {
    const target = path.join(temp, 'private'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'hidden.pdf'), 'secret');
    fs.symlinkSync(target, path.join(temp, 'output/link'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.strictEqual(metadata(temp, path.join(temp, 'output/link/hidden.pdf'), 'output', '.pdf').reason, 'rejected-path');
    assert.throws(() => readText(temp, path.join(temp, 'output/link/missing.pdf')), AccessError);
  });
  const logs = [];
  const result = await hooks.export({ applications: [{}], pipeline: [{ url: 'private' }] }, { dryRun: false, log: line => logs.push(line) });
  check('finite export hook exposes counts, with no service or data writes', () => {
    assert.strictEqual(result.pushed, 0); const value = JSON.parse(logs[0]); assert.strictEqual(value.applications, 1); assert.ok(!logs[0].includes('private'));
  });

  const codeIndex = process.argv.indexOf('--code-root');
  if (codeIndex !== -1) {
    const codeRoot = process.argv[codeIndex + 1];
    const tracker = '| # | Date | Company | Role | Location | Score | Status | PDF | Report | Notes | URL |\n|---|---|---|---|---|---|---|---|---|---|---|\n' +
      '| 10 | 2026-01-01 | Example Labs | Developer | Toronto | 4.2/5 | Evaluated | yes | [010](../reports/010-fictional.md) | PRIVATE NOTE | [job](https://example.invalid/jobs/10) |\n' +
      '| 11 | 2026-01-02 | Example Labs | Researcher | Vancouver | N/A | Applied | no | — | PRIVATE NOTE | — |\n';
    put('data/applications.md', tracker); put('data/pipeline.md', '- [ ] https://example.invalid/jobs/new | Example Labs | Analyst | Toronto | posted: 2026-01-03\r\n- [x] https://example.invalid/jobs/done | Example Two | Associate\r\n');
    put('data/pdf-index.tsv', 'report\tpdf\thtml\tformat\tdate\tkind\n10\toutput/letter.pdf\t\t\t2026-01-01\tcover\n10\toutput/test.pdf\t\t\t2026-01-02\tcv\n'); put('output/letter.pdf', '%PDF-fictional letter'); put('reports/010-fictional.md', 'fictional report');
    const workspace = await createWorkspace({ codeRoot, dataRoot: temp });
    check('uses real core readers: custom columns, CRLF inbox and exact URLs', () => {
      const state = workspace.summary(); assert.strictEqual(state.totals.applications, 2); assert.strictEqual(state.totals.inbox, 2); assert.strictEqual(state.totals.inbox_pending, 1);
      const first = workspace.get('application:10').job; assert.strictEqual(first.location, 'Toronto'); assert.strictEqual(first.score, '4.2/5'); assert.strictEqual(first.url, 'https://example.invalid/jobs/10');
      assert.ok(!JSON.stringify(workspace.list()).includes('PRIVATE NOTE')); assert.ok(!JSON.stringify(workspace.list()).includes('must not expose'));
    });
    check('filters, location sorting, pagination and stale-page rejection', () => {
      assert.strictEqual(workspace.list({ company: 'example', location: 'toronto' }).total, 2);
      assert.strictEqual(workspace.list({ collection: 'applications', status: 'Applied' }).total, 1);
      assert.strictEqual(workspace.list({ processed: false }).total, 1);
      const first = workspace.list({ limit: 1, sort: 'location' }); assert.strictEqual(first.next_offset, 1);
      assert.notStrictEqual(workspace.list({ limit: 1, offset: 1, snapshot_id: first.snapshot_id }).jobs[0].id, first.jobs[0].id);
      put('data/pipeline.md', '- [ ] https://example.invalid/extra | Fictional Co | Intern\n');
      assert.throws(() => workspace.list({ snapshot_id: first.snapshot_id }), /changed/);
    });
    check('CV/cover separation and no same-company package guessing', () => {
      const files = workspace.files('application:10'); assert.ok(files.resume.path.endsWith('test.pdf')); assert.ok(files.cover_letter.path.endsWith('letter.pdf')); assert.ok(files.report.exists);
      const missing = workspace.files('application:11'); assert.strictEqual(missing.resume.path, null); assert.strictEqual(missing.cover_letter.path, null);
      const inbox = workspace.list({ collection: 'inbox' }).jobs[0]; assert.strictEqual(workspace.files(inbox.id).resume.path, null);
      assert.throws(() => workspace.get('application:999'), /not found/);
    });
    check('unsafe indexed paths are rejected without contents or external path disclosure', () => {
      for (const file of ['../outside.pdf', 'cv.md', 'reports/010.md', 'output/link/hidden.pdf']) {
        put('data/pdf-index.tsv', `10\t${file}\t\t\t\tcv\n`);
        const found = workspace.files('application:10').resume; assert.strictEqual(found.reason, 'rejected-path'); assert.strictEqual(found.path, null);
      }
    });
    check('duplicate identities are visible and cannot select ambiguous material', () => {
      put('data/applications.md', tracker + tracker.split('\n')[2] + '\n');
      assert.deepStrictEqual(workspace.summary().diagnostics.duplicate_ids, ['application:10']);
      assert.throws(() => workspace.get('application:10'), /Ambiguous/); assert.throws(() => workspace.files('application:10'), /Ambiguous/);
      put('data/applications.md', tracker);
    });
    check('report label/target mismatch, multiple reports and reserved sentinels cannot select a package', () => {
      for (const link of ['[010](../reports/011-other.md)', '[010](../reports/010-fictional.md) [011](../reports/011-other.md)', '[010](../reports/010-RESERVED.md)']) {
        put('data/applications.md', tracker.replace('[010](../reports/010-fictional.md)', link));
        assert.strictEqual(workspace.get('application:10').job.report_number, null);
        assert.throws(() => workspace.files('application:10'), /association rejected/);
      }
      put('data/applications.md', tracker);
    });
    check('ordinary reads leave source files unchanged', () => {
      const before = fs.readFileSync(path.join(temp, 'data/applications.md')); workspace.summary(); workspace.list(); workspace.get('application:10'); workspace.files('application:10');
      assert.deepStrictEqual(fs.readFileSync(path.join(temp, 'data/applications.md')), before);
    });
    put('data/applications.md', tracker.replace('| Evaluated |', '| __proto__ |'));
    check('untrusted lifecycle text cannot alter object prototypes', () => assert.strictEqual(workspace.summary().statuses.__proto__, 1));
    fs.unlinkSync(path.join(temp, 'data/applications.md')); fs.unlinkSync(path.join(temp, 'data/pipeline.md'));
    check('missing sources are explicit, not invented data', () => assert.deepStrictEqual(workspace.summary().diagnostics.missing_sources, ['applications', 'inbox']));
    put('applications.md', tracker.replace('../reports/', 'reports/'));
    const legacy = await createWorkspace({ codeRoot, dataRoot: temp });
    check('legacy root tracker keeps report paths associated with the same workspace', () => assert.ok(legacy.files('application:10').report.exists));
    put('custom/tracker.md', tracker.replace('../reports/', 'reports/'));
    put('custom/index.tsv', '10\toutput/test.pdf\t\t\t\tcv\n');
    const custom = await createWorkspace({ codeRoot, dataRoot: temp, tracker: 'custom/tracker.md', pdfIndex: 'custom/index.tsv' });
    check('explicit custom tracker/index paths use core report-link normalization', () => { assert.ok(custom.files('application:10').resume.exists); assert.ok(custom.files('application:10').report.exists); });
    try { await createWorkspace({ codeRoot, dataRoot: temp, tracker: '../escape.md' }); assert.fail('path override accepted'); } catch (error) { assert.ok(error instanceof AccessError); }
    count++; console.log(`ok ${count} - startup rejects an out-of-root tracker override`);
  } else console.log('Core integration checks: pass --code-root <trusted-career-ops-checkout> to enable.');
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  check('manifest declares no keys, network hosts or lifecycle hook', () => { assert.deepStrictEqual(manifest.hooks, ['export']); assert.deepStrictEqual(manifest.allowedHosts, []); assert.deepStrictEqual(manifest.requiredEnv, []); assert.strictEqual(manifest.humanInTheLoop, true); });
  console.log(`${count} checks passed.`);
} finally {
  // Only the newly generated test directory is removed, never a user workspace.
  assert.ok(path.basename(temp).startsWith('career-ops-workspace-mcp-'));
  fs.rmSync(temp, { recursive: true, force: true });
}
