import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { AccessError, directory, containedFile, readText, metadata } from './files.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const nullable = (value) => !value || ['—', '-', 'N/A'].includes(value.trim()) ? null : value.trim();

async function coreModule(root, relative, names) {
  const file = containedFile(root, path.join(root, relative));
  if (!file) throw new AccessError(`Missing Career-Ops reader: ${relative}. Update your trusted checkout.`);
  // Executes only modules from the operator-selected trusted code checkout.
  // Job data and tool arguments can never choose an import path.
  const specifier = pathToFileURL(file).href;
  const mod = await import(specifier);
  if (names.some(name => typeof mod[name] !== 'function')) throw new AccessError(`Incompatible Career-Ops reader: ${relative}.`);
  return mod;
}

export async function createWorkspace({ codeRoot, dataRoot, tracker = null, pdfIndex = 'data/pdf-index.tsv' }) {
  const code = directory(codeRoot);
  const root = directory(dataRoot ?? code);
  const [parser, inbox, pdf, reports, links] = await Promise.all([
    coreModule(code, 'tracker-parse.mjs', ['resolveColumns', 'parseTrackerRow', 'parseMarkdownLinks', 'extractTrackerReportLinks']),
    coreModule(code, 'web/src/lib/pipeline-table.mjs', ['parseInbox']),
    coreModule(code, 'web/src/lib/apply/cv-selection.mjs', ['pdfIndexEntryForReport']),
    coreModule(code, 'web/src/lib/report-files.mjs', ['isReservedReportFile']),
    coreModule(code, 'tracker-links.mjs', ['normalizeReportLink']),
  ]);
  const trackerFile = tracker ? path.resolve(root, tracker)
    : fs.existsSync(path.join(root, 'data/applications.md')) ? path.join(root, 'data/applications.md')
      : fs.existsSync(path.join(root, 'applications.md')) ? path.join(root, 'applications.md')
        : path.join(root, 'data/applications.md');
  const indexFile = path.resolve(root, pdfIndex);
  // Validate overrides immediately, including paths to missing files.
  containedFile(root, trackerFile);
  containedFile(root, indexFile);

  function reportAssociation(row) {
    const reportLinks = parser.parseMarkdownLinks(links.normalizeReportLink(row.report, path.dirname(trackerFile), root));
    const identities = parser.extractTrackerReportLinks(row.report);
    if (reportLinks.length > 1 || identities.length > 1) return { number: null, problem: 'ambiguous-report' };
    if (identities.length !== 1) return { number: null, problem: 'not-indexed' };
    const identity = identities[0];
    if (identity.label !== null && identity.label !== identity.target) return { number: null, problem: 'mismatched-report-label' };
    const target = reportLinks.length ? reportLinks[0].target : row.report.trim();
    if (reports.isReservedReportFile(target)) return { number: null, problem: 'reserved-report' };
    return { number: identity.target, target, problem: null };
  }

  function snapshot() {
    const trackerRead = readText(root, trackerFile);
    const pipelineRead = readText(root, path.join(root, 'data/pipeline.md'));
    const lines = trackerRead.text.split(/\r?\n/);
    const columns = parser.resolveColumns(lines, { allowTabs: true, allowIndentation: true });
    const rows = lines.map(line => parser.parseTrackerRow(line, columns, { allowTabs: true, allowIndentation: true })).filter(Boolean);
    const applications = rows.map(row => {
      const association = reportAssociation(row);
      return {
      id: `application:${row.num}`, collection: 'applications', number: row.num,
      company: row.company, role: row.role, location: nullable(row.location),
      status: row.status, score: nullable(row.score), date: nullable(row.date),
      url: nullable(row.url), report_number: association.number, report_problem: association.problem,
      };
    });
    const incoming = inbox.parseInbox(pipelineRead.text).map(row => ({
      id: 'inbox:' + hash(JSON.stringify([row.url, row.company, row.role])), collection: 'inbox',
      company: row.company, role: row.role, location: nullable(row.location), url: row.url,
      processed: row.done, posted_at: row.postedAt ?? null,
    }));
    const jobs = [...applications, ...incoming];
    const seen = new Set();
    const duplicates = new Set();
    for (const job of jobs) { if (seen.has(job.id)) duplicates.add(job.id); seen.add(job.id); }
    return {
      snapshot_at: new Date().toISOString(), snapshot_id: hash(JSON.stringify([trackerRead.text, pipelineRead.text])),
      jobs, rows,
      diagnostics: {
        missing_sources: [trackerRead.missing ? 'applications' : null, pipelineRead.missing ? 'inbox' : null].filter(Boolean),
        duplicate_ids: [...duplicates],
      },
    };
  }

  function selected(id) {
    const state = snapshot();
    const matches = state.jobs.filter(job => job.id === id);
    if (!matches.length) throw new AccessError('Job not found; refresh the list.');
    if (matches.length !== 1) throw new AccessError('Ambiguous job identity; resolve duplicate source rows first.');
    return { state, job: matches[0] };
  }

  function files(id) {
    const { state, job } = selected(id);
    const empty = { path: null, exists: false, reason: 'not-indexed' };
    if (job.collection === 'inbox') return { snapshot_at: state.snapshot_at, id, report: empty, resume: empty, cover_letter: empty };
    const row = state.rows.find(row => `application:${row.num}` === id);
    const association = reportAssociation(row);
    if (association.problem && association.problem !== 'not-indexed') throw new AccessError(`Material association rejected: ${association.problem}. Correct the source report link first.`);
    const report = association.target ? metadata(root, path.resolve(path.dirname(trackerFile), association.target), 'reports', '.md') : empty;
    const indexRead = readText(root, indexFile);
    const material = kind => {
      if (job.report_number === null) return empty;
      const entry = pdf.pdfIndexEntryForReport(indexRead.text, job.report_number, kind);
      if (!entry.found) return empty;
      if (!entry.path) return { ...empty, reason: 'rejected-path' };
      return metadata(root, path.resolve(root, entry.path), 'output', '.pdf');
    };
    return { snapshot_at: new Date().toISOString(), id, report, resume: material('cv'), cover_letter: material('cover'), index_missing: indexRead.missing };
  }

  return {
    summary() {
      const state = snapshot();
      const statuses = Object.create(null);
      for (const job of state.jobs.filter(job => job.collection === 'applications')) {
        statuses[job.status] = (Object.hasOwn(statuses, job.status) ? statuses[job.status] : 0) + 1;
      }
      return {
        snapshot_at: state.snapshot_at, snapshot_id: state.snapshot_id,
        totals: { applications: state.rows.length, inbox: state.jobs.length - state.rows.length, inbox_pending: state.jobs.filter(job => job.collection === 'inbox' && !job.processed).length },
        statuses, diagnostics: state.diagnostics, permissions: { read: true, write: false, network: false },
      };
    },
    list({ collection = 'all', query = '', status, company, location, processed, sort = 'company', direction = 'asc', offset = 0, limit = 50, snapshot_id } = {}) {
      const state = snapshot();
      if (snapshot_id && snapshot_id !== state.snapshot_id) throw new AccessError('Workspace changed during pagination; start again at offset 0.');
      const has = (value, pattern) => String(value ?? '').toLocaleLowerCase().includes(pattern.toLocaleLowerCase());
      const result = state.jobs.filter(job =>
        (collection === 'all' || job.collection === collection) &&
        (!status || job.status === status) && (!company || has(job.company, company)) && (!location || has(job.location, location)) &&
        (processed === undefined || (job.collection === 'inbox' && job.processed === processed)) &&
        (!query || [job.company, job.role, job.location, job.url].some(value => has(value, query))));
      result.sort((a, b) => (String(a[sort] ?? '').localeCompare(String(b[sort] ?? '')) || a.id.localeCompare(b.id)) * (direction === 'desc' ? -1 : 1));
      return { snapshot_at: state.snapshot_at, snapshot_id: state.snapshot_id, total: result.length, offset, limit, next_offset: offset + limit < result.length ? offset + limit : null, jobs: result.slice(offset, offset + limit), diagnostics: state.diagnostics };
    },
    get(id) { const { state, job } = selected(id); return { snapshot_at: state.snapshot_at, snapshot_id: state.snapshot_id, job }; },
    files,
  };
}
