import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectStore } from '../src/objectstore.ts';

/**
 * Object keys come from the database, but they are still attacker-influenced
 * data: an attachment row could be created through the product with a crafted
 * filename. Since this class deletes files, escaping the store root would be a
 * remote file deletion primitive, so traversal is tested explicitly.
 */

let root: string;
let store: ObjectStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tombstone-objects-'));
  store = new ObjectStore(root);
  await store.init();
});

afterEach(() => {
  root = '';
});

describe('path safety', () => {
  const escapes = [
    '../outside.txt',
    '../../outside.txt',
    'nested/../../outside.txt',
    '/etc/passwd',
    './../../outside.txt',
  ];

  for (const key of escapes) {
    it(`refuses to resolve ${JSON.stringify(key)}`, () => {
      expect(() => store.resolveKey(key)).toThrowError(/escapes the object store root|Invalid object key/);
    });
  }

  it('rejects empty keys and keys containing NUL', () => {
    expect(() => store.resolveKey('')).toThrowError(/Invalid object key/);
    expect(() => store.resolveKey('a\0b')).toThrowError(/Invalid object key/);
  });

  it('allows ordinary nested keys', () => {
    const resolved = store.resolveKey('priya/passport-scan.txt');
    expect(resolved.startsWith(path.resolve(root) + path.sep)).toBe(true);
  });

  it('does not delete a file outside the root even if one exists there', async () => {
    const outside = path.join(path.dirname(root), 'do-not-delete.txt');
    await writeFile(outside, 'important', 'utf8');
    await expect(store.remove('../do-not-delete.txt')).rejects.toThrow();
    expect(await readFile(outside, 'utf8')).toBe('important');
  });

  it('is not fooled by a sibling directory sharing the root prefix', async () => {
    // e.g. root "/tmp/objects" must not permit "/tmp/objects-evil/x".
    const sibling = `${root}-evil`;
    await mkdir(sibling, { recursive: true });
    expect(() => store.resolveKey(path.join('..', `${path.basename(root)}-evil`, 'x.txt'))).toThrowError(
      /escapes the object store root/,
    );
  });
});

describe('lifecycle', () => {
  it('stores, digests and removes an object', async () => {
    await store.put('priya/file.txt', 'contents');
    expect(await store.exists('priya/file.txt')).toBe(true);

    const digest = await store.digest('priya/file.txt');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    const removed = await store.remove('priya/file.txt');
    expect(removed.removed).toBe(true);
    expect(removed.digest).toBe(digest);
    expect(await store.exists('priya/file.txt')).toBe(false);
  });

  it('treats removing a missing object as a no-op, so erasure is idempotent', async () => {
    const result = await store.remove('never/existed.txt');
    expect(result).toEqual({ removed: false, digest: null });
  });

  it('returns a null digest for a missing object rather than throwing', async () => {
    expect(await store.digest('never/existed.txt')).toBeNull();
  });
});
