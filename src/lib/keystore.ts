// The private key lives in IndexedDB as a non-extractable CryptoKey: page
// scripts can use it but cannot read its bytes.

export interface StoredIdentity {
  userId: string
  name: string
  privateKey: CryptoKey
}

const db = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('talk', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('kv')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const store = (await db()).transaction('kv', mode).objectStore('kv')
  return new Promise((resolve, reject) => {
    const req = fn(store)
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => reject(req.error)
  })
}

export const loadIdentity = () => tx<StoredIdentity | undefined>('readonly', (s) => s.get('identity'))
export const saveIdentity = (v: StoredIdentity) => tx('readwrite', (s) => s.put(v, 'identity'))
export const clearIdentity = () => tx('readwrite', (s) => s.delete('identity'))
