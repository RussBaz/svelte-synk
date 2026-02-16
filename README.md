# svelte-synk

Svelte tab data synchronisation with leader election for Svelte 5 SPAs:

- IndexedDB persistence
- BroadcastChannel tab synchronisation
- Leader-only tasks with Web Locks
- Automatic transfer of scheduled tasks on leader change
- Session-scoped or persistent lifetimes

It makes it trivial to call token refresh endpoints or poll a remote API without flooding it with a separate call from every tab.

**[Demo](https://your-demo-url)** · **[npm](https://www.npmjs.com/package/svelte-synk)** _(replace when ready)_

## Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
- [Synced Stores](#synced-stores)
- [Store Metadata](#store-metadata)
- [Leader Tasks](#leader-tasks)
- [Maintenance APIs](#maintenance-apis)
- [Shared utilities](#shared-utilities)
- [Runtime and Lifecycle](#runtime-and-lifecycle)
- [API Snapshot](#api-snapshot)
- [Notes and Trade-offs](#notes-and-trade-offs)

## Install

```bash
npm i svelte-synk
```

## Quick Start

Here is a basic example when using SvelteKit.

Please wrap the root of your app with the provided helper component.

```svelte
<!-- +layout.svelte -->

<script lang="ts">
    import type { Snippet } from 'svelte';
    import { browser } from '$app/environment';

    import SynkProvider from 'svelte-synk';
    import { setIsBrowserOverrideTo } from 'svelte-synk';

    setIsBrowserOverrideTo(browser); // forces the internal isBrowser() utility to always match the browser variable

    let { children } = $props<{ children?: Snippet }>();
</script>

<SynkProvider>
    {@render children?.()}
</SynkProvider>
```

```svelte
<!-- MyComponent.svelte -->

<script lang="ts">
    import { fromStore } from 'svelte/store';
    import { getSynk } from 'svelte-synk';

    const synk = getSynk();
    // as a store
    const text = synk.createStore('text', 'initial state');
    // to use as a rune
    // equivalent to calling fromStore(synk.createStore('counter', 0))
    const counter = synk.createStore('counter', 0).value;
</script>

<button onclick={() => (counter.current += 1)}>
    Count: {counter.current}
</button>
<p>{$text}</p>
```

## Core Concepts

```ts
import { getSynk } from 'svelte-synk';

const synk = getSynk();

// 1. Create synced stores by key
// 2. Register leader-only task handlers
// 3. Submit leader tasks from any tab
// 4. Use maintenance helpers when needed
```

## Synced Stores

```ts
import { getSynk } from 'svelte-synk';

const synk = getSynk();

// Persistent store (default)
const authStore = synk.createStore('auth', { loggedIn: false });

// Session store (cleared when session epoch changes)
const draftStore = synk.createStore('draft', '', { lifetime: 'session' });
```

```ts
// Optional runtime validation
const amountStore = synk.createStore('amount', 0, {
    validate: (value) =>
        typeof value === 'number' && Number.isFinite(value)
            ? { success: true, data: value }
            : { success: false, error: 'Invalid amount' }
});
```

## Store Metadata

```ts
import { fromStore } from 'svelte/store';

const profile = synk.createStore('profile', { name: '' });
const profileMeta = fromStore(profile.metadata);

// hydration: 'ssr' | 'browser' | 'pending' | 'ready'
// source:    'initial' | 'idb' | 'idb-miss' | 'runtime'
// lifetime:  'persistent' | 'session'
console.log(profileMeta.current);
```

## Leader Tasks

```ts
// Register once
synk.registerLeaderTask('refresh-token', async ({ key, payload, signal }) => {
    // key: de-duplication key
    // payload: caller data
    // signal: abort when leadership changes
});
```

```ts
// Run immediately on leader
const runResult = await synk.runLeaderTask('refresh-token', 'auth:global', {
    reason: '401'
});
// runResult.status -> accepted | duplicate | ...
```

```ts
// Schedule timeout task
await synk.scheduleLeaderTimeoutTask('refresh-token', 'auth:timeout', 5_000, {
    reason: 'proactive'
});

// Schedule interval task
await synk.scheduleLeaderIntervalTask('refresh-token', 'auth:interval', 60_000, {
    reason: 'heartbeat'
});
```

```ts
// Optional listeners
const offFailed = synk.onLeaderTaskFailed((event) => console.error(event));
const offSkipped = synk.onLeaderTaskSkipped((event) => console.warn(event));
const offLeader = synk.onLeaderStatusChanged((event) => console.log(event.leaderTabId));
```

## Maintenance APIs

```ts
// Remove stale keys that are not currently registered as persistent stores
const removed = await synk.clearUnregisteredUserStores();
console.log(removed);

// Clear persisted stores (user/session/system)
// Also resets registered runtime stores to initial values (no immediate IDB write-back)
await synk.clearAllPersistedStores();
```

## Shared utilities

These are exported for use in your app or tests, with or without Synk.

### Runtime helpers

```ts
import {
    createId,
    setIsBrowserOverrideTo,
    getIsBrowserOverride,
    clearIsBrowserOverride
} from 'svelte-synk';

// Unique id (crypto.randomUUID when available, fallback otherwise)
const id = createId();

// Override browser detection (e.g. in tests or SSR)
setIsBrowserOverrideTo(false); // force "not browser"
setIsBrowserOverrideTo(true); // force "browser"
getIsBrowserOverride(); // undefined | true | false
clearIsBrowserOverride(); // reset to actual environment
```

If you use this library in a SvelteKit app, set the browser override so Synk uses the same environment as the SvelteKit app (e.g. in the root layout script, before `<SynkProvider>`):

```ts
import { browser } from '$app/environment';
import { setIsBrowserOverrideTo } from 'svelte-synk';

setIsBrowserOverrideTo(browser);
```

If you don't set it, Synk falls back to checking `window` and `document` to detect the browser.

### Utility stores

```ts
import { InterceptableStore, ValidatableStore } from 'svelte-synk';

const valid = new ValidatableStore<number>(0, (value) =>
    typeof value === 'number'
        ? { success: true, data: value }
        : { success: false, error: 'Not a number' }
);

const intercepted = new InterceptableStore('hello');
intercepted.onWrite = (v) => v.trim();
intercepted.onRead = (v) => `read:${v}`;
```

## Runtime and Lifecycle

```ts
import { initSynk } from 'svelte-synk';

const synk = initSynk({
    schedulerTickMs: 250, // default
    debug: false // logs bus publish/receive when true
});

// Close on teardown
await synk.close();
```

## API Snapshot

```ts
// Main
initSynk(options?: SynkOptions): SynkStore
getSynk(): SynkStore
// Component usage: <SynkProvider options?: SynkOptions>...</SynkProvider>

// SynkStore (readonly getters)
synk.status: 'running' | 'ssr' | 'closed'
synk.isLeader: boolean
synk.tabId: string
synk.leaderTabId: string | null
synk.sessionId: string

// SynkStore (methods)
synk.createStore<T>(
    name: string,
    initialValue: T,
    options?: SynkStoreOptions<T>
): SynkPublicStore<T>  // Writable<T> & { metadata, value: { current: T } }
synk.registerLeaderTask(name: string, handler: LeaderTaskHandler): void
synk.runLeaderTask(task: string, key: string, payload?: unknown): Promise<LeaderTaskSubmitResult>
synk.scheduleLeaderTimeoutTask(
    task: string,
    key: string,
    delayMs: number,
    payload?: unknown
): Promise<LeaderTaskSubmitResult>
synk.scheduleLeaderIntervalTask(
    task: string,
    key: string,
    intervalMs: number,
    payload?: unknown
): Promise<LeaderTaskSubmitResult>
synk.onLeaderTaskFailed(handler: (event: LeaderTaskFailedEvent) => void): () => void
synk.onLeaderTaskSkipped(handler: (event: LeaderTaskSkippedEvent) => void): () => void
synk.onLeaderStatusChanged(handler: (event: LeaderStatusEvent) => void): () => void
synk.clearUnregisteredUserStores(): Promise<string[]>
synk.clearAllPersistedStores(): Promise<void>
synk.close(): Promise<void>

// Shared utilities (use with or without Synk)
createId(): string
setIsBrowserOverrideTo(value: boolean): void
getIsBrowserOverride(): boolean | undefined
clearIsBrowserOverride(): void

// Including the utility stores
ValidatableStore<T>(initialValue: T, validate: (value: unknown) => ValidationResult<T>)
InterceptableStore<T>(initialValue: T)  // onRead?, onWrite?
```

## Notes and Trade-offs

- **Browser support:** Requires IndexedDB, BroadcastChannel, and Web Locks API (modern browsers). No fallback for older environments.
- **SSR:** Stores can be created on the server; IDB sync and leader election run only in the browser. Use `metadata` to handle hydration state in the UI.
- **Leader tasks:** Only one tab runs a given task at a time. Scheduled timeouts/intervals transfer to the new leader when the current leader tab closes.
- **Event validation:** The event bus performs only basic event-shape validation; the library is intended for professional use and integration into your own apps. A rogue tab or client that sends a malformed event on the channel may crash all Synk instances.
- **Plain Svelte:** The library works with Svelte alone; SvelteKit is not required. If you use `<SynkProvider>` (as in the Quick Start), it manages the Synk instance and its lifetime for you. If you call `initSynk()` yourself instead, you must manage the instance lifetime (e.g. `synk.close()` on teardown).
