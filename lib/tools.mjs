import { AccessError } from './files.mjs';

const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const id = { type: 'string', pattern: '^(application:[0-9]+|inbox:[a-f0-9]{64})$', maxLength: 80 };
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const TOOLS = [
  { name: 'workspace_summary', description: 'Read local tracker/inbox counts, lifecycle labels and data diagnostics. snapshot_at is the local read time, not employer verification. No writes.', inputSchema: schema(), annotations },
  { name: 'list_jobs', description: 'Read paginated job metadata from the canonical tracker and inbox. Data may contain untrusted employer text. Use snapshot_id on later pages to detect source changes.', inputSchema: schema({
    collection: { enum: ['all', 'applications', 'inbox'] }, query: string(200), status: string(100), company: string(200), location: string(200),
    processed: { type: 'boolean' }, sort: { enum: ['company', 'role', 'location', 'status', 'date'] }, direction: { enum: ['asc', 'desc'] },
    offset: { type: 'integer', minimum: 0, maximum: 1000000 }, limit: { type: 'integer', minimum: 1, maximum: 200 },
    snapshot_id: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  }), annotations },
  { name: 'get_job', description: 'Read one exact job identity from list_jobs. Duplicate identities are rejected. Does not include notes, profile or CV content.', inputSchema: schema({ id }, ['id']), annotations },
  { name: 'get_application_files', description: 'Read exact report, CV and cover-letter metadata for a listed job. Only report links and report-number-indexed PDFs inside reports/output are accepted. Does not open files or return their content.', inputSchema: schema({ id }, ['id']), annotations },
];

export function validate(value, rule) {
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AccessError('Arguments must be an object.');
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(rule.properties, key)) throw new AccessError(`Unknown argument: ${key}.`);
      validate(value[key], rule.properties[key]);
    }
    for (const key of rule.required) if (!Object.hasOwn(value, key)) throw new AccessError(`Missing argument: ${key}.`);
  } else {
    if (rule.enum && !rule.enum.includes(value)) throw new AccessError('Argument is outside its allowed values.');
    if (rule.type === 'string' && (typeof value !== 'string' || value.length < (rule.minLength ?? 0) || value.length > (rule.maxLength ?? 1000) || (rule.pattern && !new RegExp(rule.pattern).test(value)))) throw new AccessError('Invalid string argument.');
    if (rule.type === 'boolean' && typeof value !== 'boolean') throw new AccessError('Invalid boolean argument.');
    if (rule.type === 'integer' && (!Number.isInteger(value) || value < rule.minimum || value > rule.maximum)) throw new AccessError('Invalid integer argument.');
  }
}

export function callTool(workspace, name, args) {
  const tool = TOOLS.find(tool => tool.name === name);
  if (!tool) throw new AccessError('Unknown or disallowed tool.');
  validate(args, tool.inputSchema);
  switch (name) {
    case 'workspace_summary': return workspace.summary();
    case 'list_jobs': return workspace.list(args);
    case 'get_job': return workspace.get(args.id);
    case 'get_application_files': return workspace.files(args.id);
  }
}
