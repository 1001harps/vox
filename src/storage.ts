export type RecordingData = {
  id: string
  createdAt: number
  durationMs: number
  blob: Blob
}

export interface RecordingStorage {
  save(recording: RecordingData): Promise<void>
  getAll(): Promise<RecordingData[]>
  delete(id: string): Promise<void>
}

const DB_NAME = 'vox-recordings'
const DB_VERSION = 1
const STORE_NAME = 'recordings'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }
    }
  })
}

export class IndexedDBStorage implements RecordingStorage {
  async save(recording: RecordingData): Promise<void> {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.put(recording)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
      tx.oncomplete = () => db.close()
    })
  }

  async getAll(): Promise<RecordingData[]> {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const index = store.index('createdAt')
      const request = index.getAll()
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const results = request.result as RecordingData[]
        resolve(results.sort((a, b) => b.createdAt - a.createdAt))
      }
      tx.oncomplete = () => db.close()
    })
  }

  async delete(id: string): Promise<void> {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.delete(id)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
      tx.oncomplete = () => db.close()
    })
  }
}
