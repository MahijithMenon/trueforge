import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * A filesystem-backed stand-in for blob storage (S3/GCS).
 *
 * Object keys originate in the database, but they are still treated as
 * untrusted input: every key is resolved and checked to be inside the store
 * root before any read or unlink, so a crafted key such as
 * `../../../../etc/passwd` cannot escape.
 */
export class ObjectStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  /** Resolves a key to an absolute path, refusing anything outside the root. */
  resolveKey(key: string): string {
    if (typeof key !== 'string' || key.length === 0 || key.includes('\0')) {
      throw new Error(`Invalid object key: ${JSON.stringify(key)}`);
    }
    const resolved = path.resolve(this.root, key);
    const withSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (resolved !== this.root && !resolved.startsWith(withSep)) {
      throw new Error(`Object key escapes the object store root: ${key}`);
    }
    return resolved;
  }

  async put(key: string, contents: string): Promise<void> {
    const target = this.resolveKey(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, 'utf8');
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolveKey(key));
      return true;
    } catch {
      return false;
    }
  }

  /** Digest of the stored bytes, recorded in the receipt as proof of what was destroyed. */
  async digest(key: string): Promise<string | null> {
    try {
      const buf = await fs.readFile(this.resolveKey(key));
      return createHash('sha256').update(buf).digest('hex');
    } catch {
      return null;
    }
  }

  /** Deletes an object. Missing objects are not an error: erasure is idempotent. */
  async remove(key: string): Promise<{ removed: boolean; digest: string | null }> {
    const target = this.resolveKey(key);
    const digest = await this.digest(key);
    try {
      await fs.unlink(target);
      return { removed: true, digest };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: false, digest: null };
      throw error;
    }
  }
}
