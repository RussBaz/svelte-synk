import {
    fromStore,
    writable,
    type Readable,
    type Subscriber,
    type Unsubscriber,
    type Updater,
    type Writable
} from 'svelte/store';
import {
    SynkEventBus,
    type BusEvent,
    type LeaderTaskFailedEvent,
    type LeaderStatusEvent,
    type LeaderTaskSkippedEvent,
    type LeaderTaskSubmitEvent,
    type LeaderTaskSubmittedStatus
} from './eventBusHelpers.ts';
import { createId, isBrowser } from './runtimeHelpers.ts';
import { IDBManager, type IDBStore } from './indexedDbHelpers.ts';
import type { ValidationResult } from './validatableStore.ts';
import { isWebLocksApiAvailable, requestWebLock } from './webLocksHelpers.ts';

type Status = 'running' | 'ssr' | 'closed';

const DB_NAME = 'synk-db';
const USER_DATA_STORE_NAME = 'synk-user-data';
const USER_SESSION_DATA_STORE_NAME = 'synk-user-session-data';
const SYSTEM_STORE_NAME = 'synk-system';
const LEADER_LOCK_NAME = 'synk-leader-lock';
const SESSION_INIT_LOCK_NAME = 'synk-session-init-lock';
const SYSTEM_SCHEDULED_TASKS_KEY = 'synk-system-scheduled-tasks';
const SYSTEM_SESSION_META_KEY = 'synk-system-session-meta';
const SYSTEM_SESSION_EPOCH_KEY = 'synk-system-session-epoch';
const DEFAULT_SCHEDULER_TICK_MS = 250;
const SESSION_HEARTBEAT_MS = 4000;
const SESSION_STALE_MS = 12000;

type SessionMeta = {
    id: string;
    lastSeen: number;
};

type SessionEpochMeta = {
    epoch: number;
    updatedAt: number;
};

export type SynkStoreOptions<T> = {
    validate?: (value: unknown) => ValidationResult<T>;
    // 'session' survives tab reloads while at least one tab is active; after all tabs are closed
    // and the heartbeat expires, session-scoped keys are considered stale.
    lifetime?: 'persistent' | 'session';
};

export type SynkOptions = {
    schedulerTickMs?: number;
    debug?: boolean;
};

export type SynkStoreHydrationState =
    | 'ssr' // created outside browser; no IDB hydration attempted
    | 'browser' // created in browser before hydration starts
    | 'pending' // browser runtime: waiting for first IDB hydration attempt
    | 'ready'; // first hydration attempt finished (found, miss, or fallback)
export type SynkStoreDataSource =
    | 'initial' // current value comes from initialValue
    | 'idb' // current value loaded from IndexedDB
    | 'idb-miss' // hydration finished but no value existed in IndexedDB
    | 'runtime'; // current value written at runtime via set/update
export type SynkStoreMetadata = {
    readonly lifetime: 'persistent' | 'session';
    hydration: SynkStoreHydrationState;
    source: SynkStoreDataSource;
    lastHydratedAt?: number;
};

export type SynkPublicStore<T> = Writable<T> & {
    metadata: Readable<SynkStoreMetadata>;
    value: { current: T }; // reactive value
};

export type LeaderTaskContext = {
    key: string;
    payload: unknown;
    signal: AbortSignal;
};

export type LeaderTaskHandler = (context: LeaderTaskContext) => void | Promise<void>;

export type LeaderTaskSubmitResult = {
    // 'timeout' is a local caller-side wait timeout, not a leader-reported bus status.
    status: LeaderTaskSubmittedStatus | 'timeout';
    scheduleId?: string;
};

type LeaderTaskSubmitInput =
    | {
          kind: 'run';
          task: string;
          key: string;
          payload: unknown;
      }
    | {
          kind: 'schedule-timeout';
          task: string;
          key: string;
          payload: unknown;
          delayMs: number;
      }
    | {
          kind: 'schedule-interval';
          task: string;
          key: string;
          payload: unknown;
          intervalMs: number;
      };

type ResolveValueResult<T> = { ok: true; value: T } | { ok: false };

type SessionScopedValue<T> = {
    __synkSessionWrapper: 'session-epoch-v1';
    epoch: number;
    data: T;
};

function isSessionScopedValue<T>(value: unknown): value is SessionScopedValue<T> {
    const candidate = value as Partial<SessionScopedValue<unknown>>;
    return (
        typeof value === 'object' &&
        value !== null &&
        candidate.__synkSessionWrapper === 'session-epoch-v1' &&
        typeof candidate.epoch === 'number' &&
        Number.isFinite(candidate.epoch)
    );
}

class SynkWritableStore<T> implements Writable<T> {
    #name: string;
    #tabId: string; // UUID of the tab that owns this store. (if available)
    // Keep both: in-memory Writable for instant reactive UI updates, IDB store for durable cross-tab persistence.
    #store: Writable<T>;
    #idbStore: IDBStore<unknown>; // not a reactive store, but a persistent storage wrapper over indexedDB.
    #eventBus: SynkEventBus;
    #validate: ((value: unknown) => ValidationResult<T>) | undefined;
    #lifetime: 'persistent' | 'session';
    #sessionReady: Promise<void> | undefined;
    #getSessionEpoch: (() => number) | undefined;
    #metadataStore: Writable<SynkStoreMetadata>;
    #initialValue: T;
    #closed = false;
    #lifecycleGeneration = 0;
    // Promise-chain queue: serialise async IDB writes and broadcasts in submission order.
    #lastWrite: Promise<void> = Promise.resolve();
    readonly metadata: Readable<SynkStoreMetadata>;
    #valueRef: { current: T } | undefined;

    constructor(
        name: string,
        tabId: string,
        initialValue: T,
        idbStore: IDBStore<unknown>,
        eventBus: SynkEventBus,
        initialMetadata: Omit<SynkStoreMetadata, 'lifetime'>,
        validate?: (value: unknown) => ValidationResult<T>,
        options?: {
            lifetime?: 'persistent' | 'session';
            sessionReady?: Promise<void>;
            getSessionEpoch?: () => number;
        }
    ) {
        this.#name = name;
        this.#tabId = tabId;
        this.#store = writable(structuredClone(initialValue));
        this.#initialValue = structuredClone(initialValue);
        this.#idbStore = idbStore;
        this.#eventBus = eventBus;
        this.#validate = validate;
        this.#lifetime = options?.lifetime ?? 'persistent';
        this.#sessionReady = options?.sessionReady;
        this.#getSessionEpoch = options?.getSessionEpoch;
        this.#metadataStore = writable({ ...initialMetadata, lifetime: this.#lifetime });
        this.metadata = {
            subscribe: this.#metadataStore.subscribe
        };
    }

    get lifetime(): 'persistent' | 'session' {
        return this.#lifetime;
    }

    get persistedKey(): string {
        return this.#idbStore.key;
    }

    // creates a reactive value, aka a rune
    get value(): { current: T } {
        if (this.#valueRef === undefined) {
            this.#valueRef = fromStore(this);
        }
        return this.#valueRef;
    }

    subscribe(run: Subscriber<T>, invalidate?: () => void): Unsubscriber {
        return this.#store.subscribe(run, invalidate);
    }

    set(value: T): void {
        this.#ensureOpen();
        const resolved = this.#resolveValue(value);
        if (!resolved.ok) {
            return;
        }

        this.#store.set(resolved.value);
        this.#setMetadata({
            hydration: 'ready',
            source: 'runtime',
            lastHydratedAt: Date.now()
        });
        this.#persistAndPublish(resolved.value);
    }

    update(updater: Updater<T>): void {
        this.#ensureOpen();
        let shouldWrite = false;
        let nextValue: T = undefined as T;
        this.#store.update((currentValue) => {
            const candidate = updater(currentValue);
            const resolved = this.#resolveValue(candidate);
            if (!resolved.ok) {
                return currentValue;
            }
            shouldWrite = true;
            nextValue = resolved.value;
            return resolved.value;
        });

        if (shouldWrite) {
            this.#setMetadata({
                hydration: 'ready',
                source: 'runtime',
                lastHydratedAt: Date.now()
            });
            this.#persistAndPublish(nextValue);
        }
    }

    async syncFromIdb(initialHydration: boolean = false): Promise<void> {
        if (this.#closed) {
            return;
        }

        if (initialHydration) {
            this.#setMetadata({
                hydration: 'pending',
                source: 'initial'
            });
        }

        try {
            if (this.#lifetime === 'session') {
                await this.#sessionReady;
            }
            const result = await this.#idbStore.load();
            if (this.#closed) {
                return;
            }
            if (!result.found) {
                this.#setMetadata({
                    hydration: 'ready',
                    source: 'idb-miss',
                    lastHydratedAt: Date.now()
                });
                return;
            }
            if (this.#lifetime === 'session') {
                const currentEpoch = this.#getSessionEpoch?.() ?? -1;
                if (!isSessionScopedValue<T>(result.data) || result.data.epoch !== currentEpoch) {
                    this.#setMetadata({
                        hydration: 'ready',
                        source: 'idb-miss',
                        lastHydratedAt: Date.now()
                    });
                    return;
                }
                this.#store.set(result.data.data);
            } else {
                this.#store.set(result.data as T);
            }
            this.#setMetadata({
                hydration: 'ready',
                source: 'idb',
                lastHydratedAt: Date.now()
            });
        } catch (error) {
            console.error(`Failed to sync store "${this.#name}" from IndexedDB.`, error);
            this.#setMetadata({
                hydration: 'ready',
                source: 'initial',
                lastHydratedAt: Date.now()
            });
        }
    }

    close(): void {
        this.#closed = true;
        this.#lifecycleGeneration += 1;
    }

    resetRuntimeStateWithoutPersist(): void {
        if (this.#closed) {
            return;
        }
        this.#store.set(structuredClone(this.#initialValue));
        this.#setMetadata({
            hydration: 'ready',
            source: 'initial',
            lastHydratedAt: Date.now()
        });
    }

    #ensureOpen(): void {
        if (this.#closed) {
            throw new Error(`Synk store "${this.#name}" is closed.`);
        }
    }

    #resolveValue(value: unknown): ResolveValueResult<T> {
        if (!this.#validate) {
            return { ok: true, value: value as T };
        }

        const validationResult = this.#validate(value);
        if (!validationResult.success) {
            return { ok: false };
        }
        return { ok: true, value: validationResult.data };
    }

    #setMetadata(metadata: Omit<SynkStoreMetadata, 'lifetime'>): void {
        if (this.#closed) {
            return;
        }
        this.#metadataStore.set({ ...metadata, lifetime: this.#lifetime });
    }

    #persistAndPublish(value: T): void {
        // prevents accidental mutation of the value by the caller before the idb write completes
        const valueToPersist = structuredClone(value);
        const operationGeneration = this.#lifecycleGeneration;
        this.#lastWrite = this.#lastWrite
            .then(async () => {
                if (this.#closed || operationGeneration !== this.#lifecycleGeneration) {
                    return;
                }
                if (this.#lifetime === 'session') {
                    await this.#sessionReady;
                    if (this.#closed || operationGeneration !== this.#lifecycleGeneration) {
                        return;
                    }
                    const epoch = this.#getSessionEpoch?.() ?? -1;
                    await this.#idbStore.save({
                        __synkSessionWrapper: 'session-epoch-v1',
                        epoch,
                        data: valueToPersist
                    } as SessionScopedValue<T>);
                } else {
                    await this.#idbStore.save(valueToPersist);
                }
                if (this.#closed || operationGeneration !== this.#lifecycleGeneration) {
                    return;
                }
                this.#eventBus.publish({
                    event: 'synk-store-changed',
                    sourceTabId: this.#tabId,
                    keys: [this.#name],
                    store: this.#idbStore.store,
                    changeId: createId()
                });
            })
            .catch((error) => {
                console.error(`Failed to persist store "${this.#name}" to IndexedDB.`, error);
            });
    }
}

type ScheduledTaskType = 'timeout' | 'interval';
type ScheduledTaskStatus = 'scheduled' | 'running';

type ScheduledTaskRecord = {
    id: string;
    task: string;
    key: string;
    payload: unknown;
    type: ScheduledTaskType;
    intervalMs?: number;
    nextRunAt: number;
    status: ScheduledTaskStatus;
    runningByTabId?: string;
    runStartedAt?: number;
};

type ScheduledTaskState = {
    tasks: Record<string, ScheduledTaskRecord>;
};

type CreateScheduledTaskResult =
    | { status: 'accepted'; scheduleId: string }
    | { status: 'duplicate' | 'task-not-found' };

export function initSynk(options?: SynkOptions): SynkStore {
    const userDataStoreManager = new IDBManager(DB_NAME, USER_DATA_STORE_NAME);
    const userSessionDataStoreManager = new IDBManager(DB_NAME, USER_SESSION_DATA_STORE_NAME);
    const systemStoreManager = new IDBManager(DB_NAME, SYSTEM_STORE_NAME);
    const eventBus = new SynkEventBus(options?.debug ?? false);
    return new SynkStore(
        userDataStoreManager,
        userSessionDataStoreManager,
        systemStoreManager,
        eventBus,
        options
    );
}

export class SynkStore {
    #status: Status = isBrowser() ? 'running' : 'ssr';
    #stores = new Map<string, SynkWritableStore<unknown>>();
    #tabId = createId();
    #leaderTabId: string | null = null;
    #sessionId = 'ssr';
    #sessionHeartbeatTimer: ReturnType<typeof setInterval> | undefined;

    #userDataStoreManager: IDBManager;
    #userSessionDataStoreManager: IDBManager;
    #systemStoreManager: IDBManager;
    #scheduledTasksStore: IDBStore<ScheduledTaskState>;
    #sessionMetaStore: IDBStore<SessionMeta>;
    #sessionEpochStore: IDBStore<SessionEpochMeta>;
    #eventBus: SynkEventBus;
    #eventBusUnsubscribe: (() => void) | undefined;

    #leaderTasks = new Map<string, LeaderTaskHandler>();
    #leaderTaskInFlight = new Map<string, Set<string>>();
    #pendingTaskSubmissions = new Map<string, (result: LeaderTaskSubmitResult) => void>();
    #leaderTaskFailureHandlers = new Set<(event: LeaderTaskFailedEvent) => void>();
    #leaderTaskSkippedHandlers = new Set<(event: LeaderTaskSkippedEvent) => void>();
    #leaderStatusHandlers = new Set<(event: LeaderStatusEvent) => void>();
    #isLeader = false;
    #leaderCloseResolver: (() => void) | undefined;
    #leaderLoopAbortController = new AbortController();
    #leaderSessionAbortController: AbortController | undefined;
    #leaderLoopPromise: Promise<void> | undefined;
    #scheduleTickTimer: ReturnType<typeof setTimeout> | undefined;
    #scheduleMutationQueue: Promise<void> = Promise.resolve();
    #schedulerTickMs: number;
    #sessionReady: Promise<void> = Promise.resolve();
    #sessionEpoch = 0;

    constructor(
        userDataStoreManager: IDBManager,
        userSessionDataStoreManager: IDBManager,
        systemStoreManager: IDBManager,
        eventBus: SynkEventBus,
        options?: SynkOptions
    ) {
        this.#userDataStoreManager = userDataStoreManager;
        this.#userSessionDataStoreManager = userSessionDataStoreManager;
        this.#systemStoreManager = systemStoreManager;
        this.#scheduledTasksStore = systemStoreManager.getStore<ScheduledTaskState>(
            SYSTEM_SCHEDULED_TASKS_KEY
        );
        this.#sessionMetaStore = systemStoreManager.getStore<SessionMeta>(SYSTEM_SESSION_META_KEY);
        this.#sessionEpochStore =
            systemStoreManager.getStore<SessionEpochMeta>(SYSTEM_SESSION_EPOCH_KEY);
        this.#eventBus = eventBus;
        this.#schedulerTickMs =
            options?.schedulerTickMs !== undefined &&
            Number.isFinite(options.schedulerTickMs) &&
            options.schedulerTickMs > 0
                ? options.schedulerTickMs
                : DEFAULT_SCHEDULER_TICK_MS;
        if (isBrowser()) {
            this.#sessionReady = this.#initSession().catch((error) => {
                console.error('Failed to initialise Synk session metadata.', error);
                this.#sessionId = createId();
                this.#startSessionHeartbeat();
            });
            this.#eventBusUnsubscribe = this.#eventBus.subscribe((event) => {
                void this.#onEvent(event).catch((error) => {
                    console.error('Failed to process Synk bus event.', error, event);
                });
            });
            this.#leaderLoopPromise = this.#startLeaderLoop();
        }
    }

    get status() {
        return this.#status;
    }

    get isLeader(): boolean {
        return this.#isLeader;
    }

    get tabId(): string {
        return this.#tabId;
    }

    get leaderTabId(): string | null {
        return this.#leaderTabId;
    }

    get sessionId(): string {
        return this.#sessionId;
    }

    async #touchSessionHeartbeat(): Promise<void> {
        if (!isBrowser() || this.#status === 'closed') {
            return;
        }
        await this.#sessionMetaStore.save({ id: this.#sessionId, lastSeen: Date.now() });
    }

    #startSessionHeartbeat(): void {
        this.#sessionHeartbeatTimer = setInterval(() => {
            void this.#touchSessionHeartbeat();
        }, SESSION_HEARTBEAT_MS);
    }

    async #resolveSessionState(allowClearWithoutLock: boolean): Promise<void> {
        const now = Date.now();
        const existingSession = await this.#sessionMetaStore.load();
        const existingEpoch = await this.#sessionEpochStore.load();

        if (existingSession.found && now - existingSession.data.lastSeen <= SESSION_STALE_MS) {
            this.#sessionId = existingSession.data.id;
            this.#sessionEpoch = existingEpoch.found ? existingEpoch.data.epoch : 1;
            if (!existingEpoch.found) {
                await this.#sessionEpochStore.save({ epoch: this.#sessionEpoch, updatedAt: now });
            }
            await this.#touchSessionHeartbeat();
            return;
        }

        this.#sessionId = createId();
        this.#sessionEpoch = (existingEpoch.found ? existingEpoch.data.epoch : 0) + 1;
        await this.#sessionEpochStore.save({ epoch: this.#sessionEpoch, updatedAt: now });
        await this.#sessionMetaStore.save({ id: this.#sessionId, lastSeen: now });
        if (allowClearWithoutLock) {
            await this.#userSessionDataStoreManager.clearAll();
        }
    }

    async #initSession(): Promise<void> {
        if (!isBrowser()) {
            return;
        }

        if (isWebLocksApiAvailable()) {
            const lockResult = await requestWebLock(
                SESSION_INIT_LOCK_NAME,
                async (lock) => {
                    if (!lock || this.#status === 'closed') {
                        return;
                    }
                    await this.#resolveSessionState(true);
                },
                { mode: 'exclusive' }
            );
            if (!lockResult.available) {
                // Should not happen if the availability check above was true, but keep a safe fallback.
                await this.#resolveSessionState(false);
            }
        } else {
            // Without cross-context locks (e.g. possibly some worker runtimes), avoid destructive clear to prevent races.
            await this.#resolveSessionState(false);
        }
        this.#startSessionHeartbeat();
    }

    createStore<T>(
        name: string,
        initialValue: T,
        options?: SynkStoreOptions<T>
    ): SynkPublicStore<T> {
        if (this.#status === 'closed') {
            throw new Error('Synk is closed.');
        }

        const lifetime = options?.lifetime ?? 'persistent';
        const persistedStoreKey = name;

        const existingStore = this.#stores.get(name);
        if (existingStore) {
            if (existingStore.lifetime !== lifetime) {
                throw new Error(
                    `Store "${name}" already exists with lifetime "${existingStore.lifetime}". Requested "${lifetime}".`
                );
            }
            return existingStore as unknown as SynkPublicStore<T>;
        }

        const idbStore =
            lifetime === 'session'
                ? this.#userSessionDataStoreManager.getStore<unknown>(persistedStoreKey)
                : this.#userDataStoreManager.getStore<unknown>(persistedStoreKey);
        const store = new SynkWritableStore(
            name,
            this.#tabId,
            initialValue,
            idbStore,
            this.#eventBus,
            isBrowser()
                ? { hydration: 'browser', source: 'initial' }
                : { hydration: 'ssr', source: 'initial' },
            options?.validate,
            {
                lifetime,
                sessionReady: this.#sessionReady,
                getSessionEpoch: () => this.#sessionEpoch
            }
        );
        this.#stores.set(name, store as SynkWritableStore<unknown>);
        if (isBrowser()) {
            void store.syncFromIdb(true);
        }
        return store as SynkPublicStore<T>;
    }

    registerLeaderTask(name: string, handler: LeaderTaskHandler): void {
        if (this.#status === 'closed') {
            throw new Error('Synk is closed.');
        }

        this.#leaderTasks.set(name, handler);
    }

    async runLeaderTask(
        task: string,
        key: string,
        payload?: unknown
    ): Promise<LeaderTaskSubmitResult> {
        return await this.#submitLeaderTask({
            kind: 'run',
            task,
            key,
            payload
        });
    }

    async scheduleLeaderTimeoutTask(
        task: string,
        key: string,
        delayMs: number,
        payload?: unknown
    ): Promise<LeaderTaskSubmitResult> {
        return await this.#submitLeaderTask({
            kind: 'schedule-timeout',
            task,
            key,
            payload,
            delayMs
        });
    }

    async scheduleLeaderIntervalTask(
        task: string,
        key: string,
        intervalMs: number,
        payload?: unknown
    ): Promise<LeaderTaskSubmitResult> {
        return await this.#submitLeaderTask({
            kind: 'schedule-interval',
            task,
            key,
            payload,
            intervalMs
        });
    }

    onLeaderTaskFailed(handler: (event: LeaderTaskFailedEvent) => void): () => void {
        this.#leaderTaskFailureHandlers.add(handler);
        return () => {
            this.#leaderTaskFailureHandlers.delete(handler);
        };
    }

    onLeaderTaskSkipped(handler: (event: LeaderTaskSkippedEvent) => void): () => void {
        this.#leaderTaskSkippedHandlers.add(handler);
        return () => {
            this.#leaderTaskSkippedHandlers.delete(handler);
        };
    }

    onLeaderStatusChanged(handler: (event: LeaderStatusEvent) => void): () => void {
        this.#leaderStatusHandlers.add(handler);
        return () => {
            this.#leaderStatusHandlers.delete(handler);
        };
    }

    async clearUnregisteredUserStores(): Promise<string[]> {
        if (this.#status === 'closed' || !isBrowser()) {
            return [];
        }

        const registeredUserDataKeys = new Set(
            [...this.#stores.values()]
                .filter((store) => store.lifetime === 'persistent')
                .map((store) => store.persistedKey)
        );
        const persistedKeys = await this.#userDataStoreManager.listKeys();
        const staleKeys = persistedKeys.filter((key) => !registeredUserDataKeys.has(key));

        await Promise.all(staleKeys.map((key) => this.#userDataStoreManager.deleteKey(key)));
        return staleKeys;
    }

    async clearAllPersistedStores(): Promise<void> {
        if (this.#status === 'closed' || !isBrowser()) {
            return;
        }

        await Promise.all([
            this.#userDataStoreManager.clearAll(),
            this.#userSessionDataStoreManager.clearAll(),
            this.#systemStoreManager.clearAll()
        ]);
        for (const store of this.#stores.values()) {
            store.resetRuntimeStateWithoutPersist();
        }
    }

    async #submitLeaderTask(eventInput: LeaderTaskSubmitInput): Promise<LeaderTaskSubmitResult> {
        if (this.#status === 'closed') {
            return { status: 'closed' };
        }
        if (!isBrowser()) {
            return { status: 'leader-unavailable' };
        }
        if (!isWebLocksApiAvailable()) {
            return { status: 'leader-unavailable' };
        }

        const requestId = createId();
        let event: LeaderTaskSubmitEvent;
        if (eventInput.kind === 'run') {
            event = {
                event: 'synk-leader-task-submit',
                requestId,
                sourceTabId: this.#tabId,
                kind: 'run',
                task: eventInput.task,
                key: eventInput.key,
                payload: eventInput.payload
            };
        } else if (eventInput.kind === 'schedule-timeout') {
            event = {
                event: 'synk-leader-task-submit',
                requestId,
                sourceTabId: this.#tabId,
                kind: 'schedule-timeout',
                task: eventInput.task,
                key: eventInput.key,
                payload: eventInput.payload,
                delayMs: eventInput.delayMs
            };
        } else {
            event = {
                event: 'synk-leader-task-submit',
                requestId,
                sourceTabId: this.#tabId,
                kind: 'schedule-interval',
                task: eventInput.task,
                key: eventInput.key,
                payload: eventInput.payload,
                intervalMs: eventInput.intervalMs
            };
        }

        if (this.#isLeader) {
            return await this.#handleLeaderTaskSubmit(event);
        }

        return await new Promise<LeaderTaskSubmitResult>((resolve) => {
            const timeoutId = setTimeout(() => {
                this.#pendingTaskSubmissions.delete(requestId);
                resolve({ status: 'timeout' });
            }, 2000);

            this.#pendingTaskSubmissions.set(requestId, (result) => {
                clearTimeout(timeoutId);
                resolve(result);
            });
            this.#eventBus.publish(event);
        });
    }

    async close(): Promise<void> {
        if (this.#status === 'closed') {
            return;
        }
        this.#status = 'closed';

        for (const store of this.#stores.values()) {
            store.close();
        }
        this.#stores.clear();

        if (this.#sessionHeartbeatTimer) {
            clearInterval(this.#sessionHeartbeatTimer);
            this.#sessionHeartbeatTimer = undefined;
        }

        for (const resolve of this.#pendingTaskSubmissions.values()) {
            resolve({ status: 'closed' });
        }
        this.#pendingTaskSubmissions.clear();

        this.#leaderCloseResolver?.();
        this.#leaderLoopAbortController.abort();
        this.#leaderSessionAbortController?.abort();
        if (this.#isLeader) {
            const leaderStatusEvent: LeaderStatusEvent = {
                event: 'synk-leader-status',
                sourceTabId: this.#tabId,
                leaderTabId: null
            };
            this.#eventBus.publish(leaderStatusEvent);
            this.#emitLeaderStatus(leaderStatusEvent);
        }
        this.#leaderTabId = null;
        this.#leaderSessionAbortController = undefined;
        this.#stopScheduleTick();
        await this.#leaderLoopPromise;

        this.#eventBusUnsubscribe?.();
        this.#eventBus.close();

        await Promise.all([
            this.#userDataStoreManager.close(),
            this.#userSessionDataStoreManager.close(),
            this.#systemStoreManager.close()
        ]);
    }

    async #onEvent(event: BusEvent): Promise<void> {
        if (event.event === 'synk-store-changed') {
            if (event.sourceTabId === this.#tabId) {
                return;
            }
            if (
                event.store !== USER_DATA_STORE_NAME &&
                event.store !== USER_SESSION_DATA_STORE_NAME
            ) {
                return;
            }

            for (const key of event.keys) {
                const store = this.#stores.get(key);
                await store?.syncFromIdb();
            }
            return;
        }

        if (event.event === 'synk-leader-task-submit') {
            if (!this.#isLeader || this.#status === 'closed') {
                return;
            }
            const result = await this.#handleLeaderTaskSubmit(event);
            this.#eventBus.publish({
                event: 'synk-leader-task-submitted',
                requestId: event.requestId,
                sourceTabId: this.#tabId,
                targetTabId: event.sourceTabId,
                status: result.status,
                scheduleId: result.scheduleId
            });
            return;
        }

        if (event.event === 'synk-leader-task-submitted') {
            if (event.targetTabId !== this.#tabId) {
                return;
            }
            const resolve = this.#pendingTaskSubmissions.get(event.requestId);
            if (!resolve) {
                return;
            }
            this.#pendingTaskSubmissions.delete(event.requestId);
            resolve({ status: event.status, scheduleId: event.scheduleId });
            return;
        }

        if (event.event === 'synk-leader-task-failed') {
            this.#emitTaskFailure(event);
            return;
        }

        if (event.event === 'synk-leader-task-skipped') {
            this.#emitTaskSkipped(event);
            return;
        }

        if (event.event === 'synk-leader-status') {
            this.#leaderTabId = event.leaderTabId;
            this.#emitLeaderStatus(event);
        }
    }

    async #handleLeaderTaskSubmit(
        event: LeaderTaskSubmitEvent
    ): Promise<{ status: LeaderTaskSubmittedStatus; scheduleId?: string }> {
        if (this.#status === 'closed') {
            return { status: 'closed' };
        }

        if (event.kind === 'run') {
            const status = this.#startLeaderTaskExecution(event.task, event.key, event.payload);
            return { status };
        }

        if (event.kind === 'schedule-timeout') {
            if (!Number.isFinite(event.delayMs) || event.delayMs < 0) {
                return { status: 'invalid-schedule' };
            }
            return await this.#createScheduledTask({
                type: 'timeout',
                task: event.task,
                key: event.key,
                payload: event.payload,
                nextRunAt: Date.now() + (event.delayMs ?? 0)
            });
        }

        // reaching this means that the event kind is 'schedule-interval'
        // as such a zero interval cannot be accepted, and must be rejected
        if (!Number.isFinite(event.intervalMs) || event.intervalMs <= 0) {
            return { status: 'invalid-schedule' };
        }
        return await this.#createScheduledTask({
            type: 'interval',
            task: event.task,
            key: event.key,
            payload: event.payload,
            intervalMs: event.intervalMs,
            nextRunAt: Date.now() + (event.intervalMs ?? 0)
        });
    }

    async #startLeaderLoop(): Promise<void> {
        while (!this.#leaderLoopAbortController.signal.aborted && this.#status !== 'closed') {
            const lockResult = await requestWebLock(
                LEADER_LOCK_NAME,
                async (lock) => {
                    if (!lock || this.#status === 'closed') {
                        return;
                    }
                    this.#isLeader = true;
                    this.#leaderTabId = this.#tabId;
                    const leaderStatusEvent: LeaderStatusEvent = {
                        event: 'synk-leader-status',
                        sourceTabId: this.#tabId,
                        leaderTabId: this.#tabId
                    };
                    this.#eventBus.publish(leaderStatusEvent);
                    this.#emitLeaderStatus(leaderStatusEvent);
                    this.#leaderSessionAbortController = new AbortController();
                    await this.#recoverScheduledTasksOnLeadershipChange();
                    this.#startScheduleTick();
                    await new Promise<void>((resolve) => {
                        this.#leaderCloseResolver = resolve;
                    });
                    this.#stopScheduleTick();
                    this.#leaderSessionAbortController?.abort();
                    // Reset in-flight keys when leadership ends to avoid stale duplicate locks
                    // if any task failed to settle cleanly before this tab loses leadership.
                    this.#leaderTaskInFlight.clear();
                    this.#leaderSessionAbortController = undefined;
                    this.#leaderCloseResolver = undefined;
                    this.#isLeader = false;
                    this.#leaderTabId = null;
                    const leaderStatusClearedEvent: LeaderStatusEvent = {
                        event: 'synk-leader-status',
                        sourceTabId: this.#tabId,
                        leaderTabId: null
                    };
                    this.#eventBus.publish(leaderStatusClearedEvent);
                    this.#emitLeaderStatus(leaderStatusClearedEvent);
                },
                { signal: this.#leaderLoopAbortController.signal }
            );

            if (!lockResult.available) {
                break;
            }
        }
    }

    #startLeaderTaskExecution(
        taskName: string,
        key: string,
        payload: unknown
    ): LeaderTaskSubmittedStatus {
        const acquired = this.#acquireTaskKey(taskName, key);
        if (acquired.status !== 'accepted') {
            return acquired.status;
        }

        const handler = acquired.handler;
        if (!handler) {
            this.#releaseTaskKey(taskName, key);
            return 'task-not-found';
        }

        void this.#runTaskHandler(handler, taskName, key, payload, undefined).finally(() => {
            this.#releaseTaskKey(taskName, key);
        });
        return 'accepted';
    }

    async #createScheduledTask(params: {
        type: ScheduledTaskType;
        task: string;
        key: string;
        payload: unknown;
        nextRunAt: number;
        intervalMs?: number;
    }): Promise<CreateScheduledTaskResult> {
        if (!this.#leaderTasks.has(params.task)) {
            return { status: 'task-not-found' };
        }

        const scheduleId = createId();
        const accepted = await this.#mutateScheduledState(async (state) => {
            const hasDuplicate = Object.values(state.tasks).some(
                (task) => task.task === params.task && task.key === params.key
            );
            if (hasDuplicate) {
                return false;
            }

            state.tasks[scheduleId] = {
                id: scheduleId,
                task: params.task,
                key: params.key,
                payload: params.payload,
                type: params.type,
                intervalMs: params.intervalMs,
                nextRunAt: params.nextRunAt,
                status: 'scheduled'
            };
            return true;
        });
        if (!accepted) {
            return { status: 'duplicate' };
        }

        this.#startScheduleTick();
        return { status: 'accepted', scheduleId };
    }

    #startScheduleTick(): void {
        if (!this.#isLeader || this.#status === 'closed' || this.#scheduleTickTimer) {
            return;
        }

        const run = async () => {
            this.#scheduleTickTimer = undefined;
            if (!this.#isLeader || this.#status === 'closed') {
                return;
            }
            await this.#processScheduledTasks();
            if (this.#isLeader) {
                this.#scheduleTickTimer = setTimeout(run, this.#schedulerTickMs);
            }
        };

        this.#scheduleTickTimer = setTimeout(run, 0);
    }

    #stopScheduleTick(): void {
        if (!this.#scheduleTickTimer) {
            return;
        }
        clearTimeout(this.#scheduleTickTimer);
        this.#scheduleTickTimer = undefined;
    }

    async #recoverScheduledTasksOnLeadershipChange(): Promise<void> {
        const failures: LeaderTaskFailedEvent[] = [];
        await this.#mutateScheduledState(async (state) => {
            const now = Date.now();
            for (const [id, task] of Object.entries(state.tasks)) {
                if (task.status !== 'running') {
                    continue;
                }

                failures.push({
                    event: 'synk-leader-task-failed',
                    sourceTabId: this.#tabId,
                    task: task.task,
                    key: task.key,
                    scheduleId: id,
                    reason: 'leader-changed'
                });

                if (task.type === 'interval') {
                    task.status = 'scheduled';
                    task.nextRunAt = now + (task.intervalMs ?? 1000);
                    task.runningByTabId = undefined;
                    task.runStartedAt = undefined;
                } else {
                    delete state.tasks[id];
                }
            }
        });

        for (const failure of failures) {
            this.#emitTaskFailure(failure);
            this.#eventBus.publish(failure);
        }
    }

    async #processScheduledTasks(): Promise<void> {
        type TaskToRun = ScheduledTaskRecord;
        const failures: LeaderTaskFailedEvent[] = [];
        const skipped: LeaderTaskSkippedEvent[] = [];
        const tasksToRun = await this.#mutateScheduledState(async (state) => {
            const now = Date.now();
            const result: TaskToRun[] = [];
            for (const [id, task] of Object.entries(state.tasks)) {
                if (task.status !== 'scheduled' || task.nextRunAt > now) {
                    continue;
                }

                if (!this.#leaderTasks.has(task.task)) {
                    failures.push({
                        event: 'synk-leader-task-failed',
                        sourceTabId: this.#tabId,
                        task: task.task,
                        key: task.key,
                        scheduleId: id,
                        reason: 'task-not-found'
                    });
                    delete state.tasks[id];
                    continue;
                }

                if (this.#isTaskKeyInFlight(task.task, task.key)) {
                    if (task.type === 'interval') {
                        skipped.push({
                            event: 'synk-leader-task-skipped',
                            sourceTabId: this.#tabId,
                            task: task.task,
                            key: task.key,
                            scheduleId: id,
                            reason: 'interval-too-short'
                        });
                    } else {
                        failures.push({
                            event: 'synk-leader-task-failed',
                            sourceTabId: this.#tabId,
                            task: task.task,
                            key: task.key,
                            scheduleId: id,
                            reason: 'duplicate'
                        });
                    }
                    // The next interval cannot run because the current exxecution is still in progress
                    if (task.type === 'interval') {
                        task.nextRunAt = now + (task.intervalMs ?? 1000);
                    } else {
                        delete state.tasks[id];
                    }
                    continue;
                }

                task.status = 'running';
                task.runningByTabId = this.#tabId;
                task.runStartedAt = now;
                result.push({ ...task });
            }
            return result;
        });

        for (const failure of failures) {
            this.#emitTaskFailure(failure);
            this.#eventBus.publish(failure);
        }
        for (const event of skipped) {
            this.#emitTaskSkipped(event);
            this.#eventBus.publish(event);
        }

        for (const task of tasksToRun) {
            const acquired = this.#acquireTaskKey(task.task, task.key);
            if (acquired.status !== 'accepted' || !acquired.handler) {
                await this.#finalizeScheduledTask(
                    task,
                    false,
                    acquired.status === 'task-not-found' ? 'task-not-found' : 'handler-error'
                );
                continue;
            }

            const result = await this.#runTaskHandler(
                acquired.handler,
                task.task,
                task.key,
                task.payload,
                task.id
            );
            this.#releaseTaskKey(task.task, task.key);
            await this.#finalizeScheduledTask(
                task,
                result.ok,
                result.reason ?? 'handler-error',
                result.error
            );
        }
    }

    async #finalizeScheduledTask(
        task: ScheduledTaskRecord,
        succeeded: boolean,
        reason: LeaderTaskFailedEvent['reason'],
        error?: unknown
    ): Promise<void> {
        const failureMessage =
            error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
        const failureEvent: LeaderTaskFailedEvent = {
            event: 'synk-leader-task-failed',
            sourceTabId: this.#tabId,
            task: task.task,
            key: task.key,
            scheduleId: task.id,
            reason,
            error: failureMessage
        };

        await this.#mutateScheduledState(async (state) => {
            const current = state.tasks[task.id];
            if (!current) {
                return;
            }

            if (succeeded) {
                if (current.type === 'interval') {
                    current.status = 'scheduled';
                    current.nextRunAt = Date.now() + (current.intervalMs ?? 1000);
                    current.runningByTabId = undefined;
                    current.runStartedAt = undefined;
                    return;
                }

                delete state.tasks[task.id];
                return;
            }

            if (current.type === 'interval') {
                current.status = 'scheduled';
                current.nextRunAt = Date.now() + (current.intervalMs ?? 1000);
                current.runningByTabId = undefined;
                current.runStartedAt = undefined;
            } else {
                delete state.tasks[task.id];
            }
        });

        if (!succeeded) {
            this.#emitTaskFailure(failureEvent);
            this.#eventBus.publish(failureEvent);
        }
    }

    #acquireTaskKey(
        taskName: string,
        key: string
    ): { status: LeaderTaskSubmittedStatus; handler?: LeaderTaskHandler } {
        if (this.#status === 'closed') {
            return { status: 'closed' };
        }

        const task = this.#leaderTasks.get(taskName);
        if (!task) {
            return { status: 'task-not-found' };
        }

        const existingKeys = this.#leaderTaskInFlight.get(taskName);
        const keys = existingKeys ?? new Set<string>();
        if (keys.has(key)) {
            return { status: 'duplicate' };
        }
        keys.add(key);
        if (!existingKeys) {
            this.#leaderTaskInFlight.set(taskName, keys);
        }
        return { status: 'accepted', handler: task };
    }

    #releaseTaskKey(taskName: string, key: string): void {
        const keys = this.#leaderTaskInFlight.get(taskName);
        if (!keys) {
            return;
        }
        keys.delete(key);
        if (keys.size === 0) {
            this.#leaderTaskInFlight.delete(taskName);
        }
    }

    #isTaskKeyInFlight(taskName: string, key: string): boolean {
        const keys = this.#leaderTaskInFlight.get(taskName);
        return !!keys?.has(key);
    }

    async #runTaskHandler(
        handler: LeaderTaskHandler,
        taskName: string,
        key: string,
        payload: unknown,
        scheduleId?: string
    ): Promise<{ ok: boolean; reason?: LeaderTaskFailedEvent['reason']; error?: unknown }> {
        const signal = this.#leaderSessionAbortController?.signal ?? AbortSignal.abort();
        try {
            await handler({ key, payload, signal });
            return { ok: true };
        } catch (error) {
            console.error(`Leader task "${taskName}" failed for key "${key}".`, error);
            // Scheduled runs report failures in #finalizeScheduledTask to avoid duplicate events here.
            if (!scheduleId) {
                const failure: LeaderTaskFailedEvent = {
                    event: 'synk-leader-task-failed',
                    sourceTabId: this.#tabId,
                    task: taskName,
                    key,
                    reason: 'handler-error',
                    error: error instanceof Error ? error.message : String(error)
                };
                this.#emitTaskFailure(failure);
                this.#eventBus.publish(failure);
            }
            return { ok: false, reason: 'handler-error', error };
        }
    }

    #emitTaskFailure(event: LeaderTaskFailedEvent): void {
        for (const handler of this.#leaderTaskFailureHandlers) {
            handler(event);
        }
    }

    #emitTaskSkipped(event: LeaderTaskSkippedEvent): void {
        for (const handler of this.#leaderTaskSkippedHandlers) {
            handler(event);
        }
    }

    #emitLeaderStatus(event: LeaderStatusEvent): void {
        for (const handler of this.#leaderStatusHandlers) {
            handler(event);
        }
    }

    async #loadScheduledState(): Promise<ScheduledTaskState> {
        const loaded = await this.#scheduledTasksStore.load();
        if (!loaded.found || !loaded.data || typeof loaded.data !== 'object') {
            return { tasks: {} };
        }
        if (
            !('tasks' in loaded.data) ||
            typeof loaded.data.tasks !== 'object' ||
            loaded.data.tasks === null
        ) {
            return { tasks: {} };
        }
        return loaded.data;
    }

    async #saveScheduledState(state: ScheduledTaskState): Promise<void> {
        await this.#scheduledTasksStore.save(state);
    }

    async #mutateScheduledState<T>(
        mutator: (state: ScheduledTaskState) => Promise<T> | T
    ): Promise<T> {
        const operation = async (): Promise<T> => {
            const state = await this.#loadScheduledState();
            const result = await mutator(state);
            await this.#saveScheduledState(state);
            return result;
        };

        const run = this.#scheduleMutationQueue.then(operation, operation);
        this.#scheduleMutationQueue = run.then(
            () => undefined,
            () => undefined
        );
        return await run;
    }
}
