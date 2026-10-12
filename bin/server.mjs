#!/usr/bin/env node
import { createWorkspace } from '../lib/workspace.mjs';
import { serve } from '../lib/protocol.mjs';

const usage = 'Usage: node bin/server.mjs --code-root <trusted-career-ops-checkout> [--data-root <workspace>] [--tracker <relative-path>] [--pdf-index <relative-path>]';
const keys = { '--code-root': 'codeRoot', '--data-root': 'dataRoot', '--tracker': 'tracker', '--pdf-index': 'pdfIndex' };
const options = {};
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.error(usage);
  } else {
    for (let i = 0; i < args.length; i++) {
      const name = args[i];
      if (!Object.hasOwn(keys, name) || Object.hasOwn(options, keys[name]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(usage);
      options[keys[name]] = args[++i];
    }
    if (!options.codeRoot) throw new Error(usage);
    const workspace = await createWorkspace(options);
    serve(workspace, process.stdin, process.stdout);
  }
} catch (error) {
  console.error(error.message === usage ? usage : 'Workspace MCP startup failed. Check the explicit roots and required Career-Ops readers. ' + error.message);
  process.exitCode = 1;
}
