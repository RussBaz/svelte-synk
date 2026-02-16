import { isBrowser } from './runtimeHelpers.ts';

export const EVENT_BUS_NAME = 'synk-event-bus';

export type SynkStoreChangedEvent = {
    event: 'synk-store-changed';
    sourceTabId: string;
    keys: string[];
    store: string;
    changeId: string;
};

type LeaderTaskSubmitEventBase = {
    event: 'synk-leader-task-submit';
    requestId: string;
    sourceTabId: string;
    task: string;
    key: string;
    payload: unknown;
};

export type LeaderTaskSubmitEvent =
    | (LeaderTaskSubmitEventBase & {
          kind: 'run';
      })
    | (LeaderTaskSubmitEventBase & {
          kind: 'schedule-timeout';
          delayMs: number;
      })
    | (LeaderTaskSubmitEventBase & {
          kind: 'schedule-interval';
          intervalMs: number;
      });

export type LeaderTaskSubmittedStatus =
    | 'accepted'
    | 'duplicate'
    | 'task-not-found'
    | 'leader-unavailable'
    | 'invalid-schedule'
    | 'closed';

export type LeaderTaskSubmittedEvent = {
    event: 'synk-leader-task-submitted';
    requestId: string;
    sourceTabId: string;
    targetTabId: string;
    status: LeaderTaskSubmittedStatus;
    scheduleId?: string;
};

export type LeaderTaskFailedEvent = {
    event: 'synk-leader-task-failed';
    sourceTabId: string;
    task: string;
    key: string;
    scheduleId?: string;
    reason: 'handler-error' | 'leader-changed' | 'task-not-found' | 'duplicate';
    error?: string;
};

export type LeaderTaskSkippedEvent = {
    event: 'synk-leader-task-skipped';
    sourceTabId: string;
    task: string;
    key: string;
    scheduleId?: string;
    reason: 'interval-too-short';
};

export type LeaderStatusEvent = {
    event: 'synk-leader-status';
    sourceTabId: string;
    leaderTabId: string | null;
};

export type BusEvent =
    | SynkStoreChangedEvent
    | LeaderTaskSubmitEvent
    | LeaderTaskSubmittedEvent
    | LeaderTaskFailedEvent
    | LeaderTaskSkippedEvent
    | LeaderStatusEvent;
const BUS_EVENT_NAMES = new Set<BusEvent['event']>([
    'synk-store-changed',
    'synk-leader-task-submit',
    'synk-leader-task-submitted',
    'synk-leader-task-failed',
    'synk-leader-task-skipped',
    'synk-leader-status'
]);
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isValidBusEventShape(value: unknown): value is BusEvent {
    if (!isRecord(value) || typeof value.event !== 'string') {
        return false;
    }
    return BUS_EVENT_NAMES.has(value.event as BusEvent['event']);
}

export function getBroadcastChannelConstructor(): typeof BroadcastChannel | undefined {
    if (!isBrowser() || typeof globalThis.BroadcastChannel !== 'function') {
        return undefined;
    }

    return globalThis.BroadcastChannel;
}

export function createBroadcastChannel(name: string): BroadcastChannel | undefined {
    const BroadcastChannelConstructor = getBroadcastChannelConstructor();
    if (!BroadcastChannelConstructor) {
        return undefined;
    }

    return new BroadcastChannelConstructor(name);
}

export class SynkEventBus {
    #channel: BroadcastChannel | undefined;
    #handlers = new Set<(event: BusEvent) => void>();
    #isListening = false;
    #debug: boolean;
    #log(direction: 'published' | 'received', payload: unknown): void {
        if (!this.#debug) {
            return;
        }
        console.info(`[synk:event-bus] ${direction}`, payload);
    }
    #logSeverity(event: BusEvent): void {
        if (event.event === 'synk-leader-task-skipped') {
            console.warn('[synk:event-bus] skipped event', event);
            return;
        }
        if (event.event === 'synk-leader-task-failed') {
            console.error('[synk:event-bus] error event', event);
        }
    }
    #onMessage = (event: MessageEvent<unknown>): void => {
        this.#log('received', event.data);
        const message = event.data;
        if (!isValidBusEventShape(message)) {
            console.error('SynkEventBus received invalid/unsupported event payload:', message);
            return;
        }

        for (const handler of this.#handlers) {
            try {
                handler(message);
            } catch (error) {
                console.error('SynkEventBus handler failed.', error);
            }
        }
    };
    #closed = false;

    constructor(debug: boolean = false) {
        this.#debug = debug;
        this.#channel = createBroadcastChannel(EVENT_BUS_NAME);
    }

    #ensureOpen(): void {
        if (this.#closed) {
            throw new Error('SynkEventBus is closed and can no longer be used.');
        }
    }

    publish(event: BusEvent): void {
        this.#ensureOpen();
        this.#log('published', event);
        this.#logSeverity(event);
        if (!this.#channel) {
            return;
        }

        this.#channel.postMessage(event);
    }

    subscribe(handler: (event: BusEvent) => void): () => void {
        this.#ensureOpen();
        this.#handlers.add(handler);
        if (!this.#isListening) {
            this.#channel?.addEventListener('message', this.#onMessage);
            this.#isListening = true;
        }

        return () => {
            this.unsubscribe(handler);
        };
    }

    unsubscribe(handler?: (event: BusEvent) => void): void {
        this.#ensureOpen();
        if (handler) {
            this.#handlers.delete(handler);
        } else {
            this.#handlers.clear();
        }

        if (this.#handlers.size === 0) {
            this.#channel?.removeEventListener('message', this.#onMessage);
            this.#isListening = false;
        }
    }

    close(): void {
        if (this.#closed) {
            return;
        }

        this.unsubscribe();
        this.#channel?.close();
        this.#channel = undefined;
        this.#closed = true;
    }
}
