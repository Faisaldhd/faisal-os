/**
 * Storage backend abstraction for the VFS. Keeps IndexedDB details out of
 * index.ts so another backend (e.g. OPFS) can be dropped in later.
 */

export interface StoredNode {
  path: string;
  name: string;
  type: 'file' | 'dir';
  size: number;
  mode: number;
  mtime: number;
  ctime: number;
  data?: Uint8Array;
}

export interface StorageBackend {
  readonly persistent: boolean;
  loadAll(): Promise<StoredNode[]>;
  put(node: StoredNode): Promise<void>;
  putMany(nodes: StoredNode[]): Promise<void>;
  delete(path: string): Promise<void>;
  deleteMany(paths: string[]): Promise<void>;
  clear(): Promise<void>;
}

const DB_NAME = 'faisal-vfs';
const STORE = 'nodes';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB unavailable'));
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err as Error);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'path' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    req.onblocked = () => reject(new Error('indexedDB blocked'));
  });
}

class IndexedDbBackend implements StorageBackend {
  readonly persistent = true;
  constructor(private db: IDBDatabase) {}

  private tx(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(STORE, mode).objectStore(STORE);
  }

  loadAll(): Promise<StoredNode[]> {
    return new Promise((resolve, reject) => {
      const out: StoredNode[] = [];
      const req = this.tx('readonly').openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          out.push(cursor.value as StoredNode);
          cursor.continue();
        } else {
          resolve(out);
        }
      };
      req.onerror = () => reject(req.error ?? new Error('loadAll failed'));
    });
  }

  put(node: StoredNode): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = this.tx('readwrite').put(node);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('put failed'));
    });
  }

  putMany(nodes: StoredNode[]): Promise<void> {
    if (nodes.length === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const store = this.tx('readwrite');
      let remaining = nodes.length;
      let failed = false;
      for (const n of nodes) {
        const req = store.put(n);
        req.onsuccess = () => { if (--remaining === 0 && !failed) resolve(); };
        req.onerror = () => { failed = true; reject(req.error ?? new Error('putMany failed')); };
      }
    });
  }

  delete(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = this.tx('readwrite').delete(path);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('delete failed'));
    });
  }

  deleteMany(paths: string[]): Promise<void> {
    if (paths.length === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const store = this.tx('readwrite');
      let remaining = paths.length;
      let failed = false;
      for (const p of paths) {
        const req = store.delete(p);
        req.onsuccess = () => { if (--remaining === 0 && !failed) resolve(); };
        req.onerror = () => { failed = true; reject(req.error ?? new Error('deleteMany failed')); };
      }
    });
  }

  clear(): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = this.tx('readwrite').clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('clear failed'));
    });
  }
}

class MemoryBackend implements StorageBackend {
  readonly persistent = false;
  private map = new Map<string, StoredNode>();
  async loadAll(): Promise<StoredNode[]> { return [...this.map.values()]; }
  async put(node: StoredNode): Promise<void> { this.map.set(node.path, node); }
  async putMany(nodes: StoredNode[]): Promise<void> { for (const n of nodes) this.map.set(n.path, n); }
  async delete(path: string): Promise<void> { this.map.delete(path); }
  async deleteMany(paths: string[]): Promise<void> { for (const p of paths) this.map.delete(p); }
  async clear(): Promise<void> { this.map.clear(); }
}

/** Tries IndexedDB first; falls back to an in-memory backend if unavailable or it throws. */
export async function createStorageBackend(): Promise<StorageBackend> {
  try {
    const db = await openDb();
    return new IndexedDbBackend(db);
  } catch {
    return new MemoryBackend();
  }
}
