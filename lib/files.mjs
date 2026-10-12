import fs from 'node:fs';
import path from 'node:path';

export class AccessError extends Error {}

export function inside(root, file) {
  const rel = path.relative(root, file);
  return rel !== '' && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}

export function directory(root) {
  const resolved = fs.realpathSync(root);
  if (!fs.statSync(resolved).isDirectory()) throw new AccessError('Expected a directory.');
  return resolved;
}

// Check every component, including missing-file cases. No data symlinks/junctions
// are followed, even when they point back inside the allowed tree.
export function containedFile(root, file) {
  const abs = path.resolve(file);
  if (!inside(root, abs)) throw new AccessError('Path is outside its allowed directory.');
  const parts = path.relative(root, abs).split(path.sep);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new AccessError('Cannot inspect a workspace path.');
    }
    if (stat.isSymbolicLink()) throw new AccessError('Linked data paths are not allowed.');
    if (i < parts.length - 1 && !stat.isDirectory()) throw new AccessError('Invalid parent directory.');
    if (i === parts.length - 1 && !stat.isFile()) throw new AccessError('Expected a regular file.');
  }
  if (!inside(root, fs.realpathSync(abs))) throw new AccessError('Resolved path is outside its allowed directory.');
  return abs;
}

export function readText(root, file, maxBytes = 16 * 1024 * 1024) {
  const safe = containedFile(root, file);
  if (!safe) return { text: '', missing: true };
  // Bound the descriptor read too: a file can grow after the size check.
  const fd = fs.openSync(safe, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (containedFile(root, file) !== safe) throw new AccessError('Workspace path changed during the read.');
    const stat = fs.fstatSync(fd);
    const current = fs.statSync(safe);
    if (!stat.isFile() || stat.dev !== current.dev || stat.ino !== current.ino) throw new AccessError('Workspace file changed during the read.');
    if (stat.size > maxBytes) throw new AccessError('Workspace file exceeds the read limit.');
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, stat.size + 1));
    let bytes = 0;
    while (bytes < buffer.length) {
      const n = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!n) break;
      bytes += n;
    }
    if (bytes > stat.size) throw new AccessError('Workspace file grew during the read; try again.');
    return { text: buffer.subarray(0, bytes).toString('utf8'), missing: false };
  } finally { fs.closeSync(fd); }
}

export function metadata(root, file, scope, extension) {
  const abs = path.resolve(file);
  const allowed = path.join(root, scope);
  const result = { path: null, exists: false, reason: 'not-indexed' };
  if (!inside(allowed, abs) || path.extname(abs).toLowerCase() !== extension) return { ...result, reason: 'rejected-path' };
  try {
    const safe = containedFile(root, abs);
    if (!safe) return { ...result, path: abs, reason: 'missing-file' };
    return { path: safe, exists: true, reason: null, bytes: fs.statSync(safe).size };
  } catch (error) {
    if (error instanceof AccessError) return { ...result, reason: 'rejected-path' };
    throw error;
  }
}
