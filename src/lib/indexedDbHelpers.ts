import { isBrowser } from './runtimeHelpers.ts';

export type IDBLoadResult<T> = { found: true; data: T } | { found: false };
type WrappedIdbValue<T> = { __synkWrapper: 'idb-value-v1'; data: T };

function wrapIdbValue<T>(value: T): WrappedIdbValue<T> {
    return { __synkWrapper: 'idb-value-v1', data: value };
}

function isWrappedIdbValue<T>(value: unknown): value is WrappedIdbValue<T> {
    const maybeWrapped = value as Partial<WrappedIdbValue<unknown>>;
    return (
        typeof value === 'object' && value !== null && maybeWrapped.__synkWrapper === 'idb-value-v1'
    );
}

function isIndexedDbAvailable(): boolean {
    return isBrowser() && typeof indexedDB !== 'undefined';
}

function openIndexedDb(name: string, version?: number): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (!isIndexedDbAvailable()) {
            reject(new Error('IndexedDB is not available in this environment.'));
            return;
        }

        const request =
            version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);

        request.onsuccess = () => {
            resolve(request.result);
        };

        request.onerror = () => {
            reject(request.error ?? new Error(`Failed to open IndexedDB database "${name}".`));
        };
    });
}

type StoreRequestMode = 'readonly' | 'readwrite';

function runStoreRequest<T>(
    db: IDBDatabase,
    storeName: string,
    mode: StoreRequestMode,
    execute: (store: IDBObjectStore) => IDBRequest
): Promise<T> {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        const request = execute(store);
        let result: T;

        transaction.oncomplete = () => {
            resolve(result);
        };

        transaction.onabort = () => {
            reject(transaction.error ?? new Error('IndexedDB transaction was aborted.'));
        };

        request.onsuccess = () => {
            result = request.result as T;
        };

        request.onerror = () => {
            reject(request.error ?? new Error('IndexedDB request failed.'));
        };
    });
}

function openIndexedDbWithStore(dbName: string, storeName: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (!isIndexedDbAvailable()) {
            reject(new Error('IndexedDB is not available in this environment.'));
            return;
        }

        const request = indexedDB.open(dbName);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(storeName)) {
                db.createObjectStore(storeName);
            }
        };

        request.onsuccess = () => {
            const db = request.result;
            if (db.objectStoreNames.contains(storeName)) {
                resolve(db);
                return;
            }

            const nextVersion = db.version + 1;
            db.close();

            const upgradeRequest = indexedDB.open(dbName, nextVersion);

            upgradeRequest.onupgradeneeded = () => {
                const upgradedDb = upgradeRequest.result;
                if (!upgradedDb.objectStoreNames.contains(storeName)) {
                    upgradedDb.createObjectStore(storeName);
                }
            };

            upgradeRequest.onsuccess = () => {
                resolve(upgradeRequest.result);
            };

            upgradeRequest.onerror = () => {
                reject(
                    upgradeRequest.error ??
                        new Error(
                            `Failed to upgrade IndexedDB database "${dbName}" to create store "${storeName}".`
                        )
                );
            };

            upgradeRequest.onblocked = () => {
                reject(new Error(`IndexedDB upgrade is blocked for database "${dbName}".`));
            };
        };

        request.onerror = () => {
            reject(request.error ?? new Error(`Failed to open IndexedDB database "${dbName}".`));
        };

        request.onblocked = () => {
            reject(new Error(`IndexedDB open request is blocked for database "${dbName}".`));
        };
    });
}

export class IDBManager {
    #dbName: string;
    #storeName: string;
    #dbPromise: Promise<IDBDatabase> | undefined;
    #stores: Map<string, IDBStore<unknown>> = new Map();

    constructor(dbName: string, storeName: string) {
        this.#dbName = dbName;
        this.#storeName = storeName;
    }

    async #getDb(): Promise<IDBDatabase> {
        if (this.#dbPromise) {
            return this.#dbPromise;
        }

        this.#dbPromise = openIndexedDbWithStore(this.#dbName, this.#storeName)
            .then((db) => {
                // If another tab upgrades the DB, this connection becomes stale.
                db.onversionchange = () => {
                    db.close();
                    this.#dbPromise = undefined;
                };
                return db;
            })
            .catch((error) => {
                this.#dbPromise = undefined;
                throw error;
            });

        return this.#dbPromise;
    }

    async #readRaw(key: string): Promise<unknown | undefined> {
        const db = await this.#getDb();
        return await runStoreRequest<unknown | undefined>(
            db,
            this.#storeName,
            'readonly',
            (store) => store.get(key)
        );
    }

    async #writeRaw(key: string, value: unknown): Promise<void> {
        const db = await this.#getDb();
        await runStoreRequest<unknown>(db, this.#storeName, 'readwrite', (store) =>
            store.put(value, key)
        );
    }

    getStore<T>(key: string): IDBStore<T> {
        const existingStore = this.#stores.get(key);
        if (existingStore) {
            return existingStore as IDBStore<T>;
        }

        const store = new IDBStore<T>(
            this.#storeName,
            key,
            async () => {
                const value = await this.#readRaw(key);
                return value as T | undefined;
            },
            async (value) => {
                await this.#writeRaw(key, value);
            }
        );
        this.#stores.set(key, store as IDBStore<unknown>);
        return store;
    }

    async listKeys(): Promise<string[]> {
        const db = await this.#getDb();
        const keys = await runStoreRequest<IDBValidKey[]>(
            db,
            this.#storeName,
            'readonly',
            (store) => store.getAllKeys()
        );
        return keys
            .map((key) => (typeof key === 'string' ? key : String(key)))
            .filter((key) => key.length > 0);
    }

    async deleteKey(key: string): Promise<void> {
        const db = await this.#getDb();
        await runStoreRequest<unknown>(db, this.#storeName, 'readwrite', (store) =>
            store.delete(key)
        );
        this.#stores.delete(key);
    }

    async clearAll(): Promise<void> {
        const db = await this.#getDb();
        await runStoreRequest<unknown>(db, this.#storeName, 'readwrite', (store) => store.clear());
        this.#stores.clear();
    }

    async close(): Promise<void> {
        const dbPromise = this.#dbPromise;
        this.#dbPromise = undefined;
        this.#stores.clear();
        if (!dbPromise) {
            return;
        }

        const db = await dbPromise.catch(() => undefined);
        db?.close();
    }
}

export class IDBStore<T> {
    #store: string;
    #key: string;
    #read: () => Promise<unknown>;
    #write: (value: unknown) => Promise<void>;

    constructor(
        store: string,
        key: string,
        read: () => Promise<unknown | undefined>,
        write: (value: unknown) => Promise<void>
    ) {
        this.#store = store;
        this.#key = key;
        this.#read = read;
        this.#write = write;
    }

    get key(): string {
        return this.#key;
    }

    get store(): string {
        return this.#store;
    }

    async load(): Promise<IDBLoadResult<T>> {
        const value = await this.#read();
        if (isWrappedIdbValue<T>(value)) {
            return { found: true, data: value.data };
        }
        return { found: false };
    }

    async save(value: T): Promise<void> {
        await this.#write(wrapIdbValue(value));
    }
}
