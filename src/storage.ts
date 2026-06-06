export type RecordingData = {
  id: string;
  createdAt: number;
  durationMs: number;
  blob: Blob;
};

export interface RecordingStorage {
  save(recording: RecordingData): Promise<void>;
  getAll(): Promise<RecordingData[]>;
  delete(id: string): Promise<void>;
}

const DB_NAME = "vox-recordings";
const DB_VERSION = 1;
const STORE_NAME = "recordings";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => { dbPromise = null; reject(request.error); };
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
  });
  return dbPromise;
}

export class IndexedDBStorage implements RecordingStorage {
  async save(recording: RecordingData): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(recording);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async getAll(): Promise<RecordingData[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const index = store.index("createdAt");
      const request = index.getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const results = request.result as RecordingData[];
        resolve(results.sort((a, b) => b.createdAt - a.createdAt));
      };
    });
  }

  async delete(id: string): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(id);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }
}
