<script lang="ts">
    import { onDestroy } from 'svelte';
    import { fromStore } from 'svelte/store';
    import { getSynk } from '../lib/synkContext.ts';
    import { createId } from '../lib/runtimeHelpers.ts';
    import { InterceptableStore } from '../lib/interceptableStore.ts';
    import { ValidatableStore } from '../lib/validatableStore.ts';

    const synk = getSynk();

    const textStore = synk.createStore('text', '');
    const timeoutSecondsStore = synk.createStore('timeout-seconds', 5);
    const intervalSecondsStore = synk.createStore('interval-seconds', 2);
    const sessionNoteStore = synk.createStore('session-note', '', { lifetime: 'session' });
    const pingCounterStore = synk.createStore('ping-counter', 0);

    const text = textStore.value;
    const stepper = synk.createStore('stepper', 0).value;
    const timeoutSeconds = timeoutSecondsStore.value;
    const timeoutRunning = synk.createStore('timeout-running', false).value;
    const timeoutDone = synk.createStore('timeout-done', false).value;
    const timeoutToken = synk.createStore<string | null>('timeout-token', null).value;
    const intervalSeconds = intervalSecondsStore.value;
    const intervalRunning = synk.createStore('interval-running', false).value;
    const intervalCounter = synk.createStore('interval-counter', 0).value;
    const intervalToken = synk.createStore<string | null>('interval-token', null).value;
    const sessionNote = sessionNoteStore.value;
    const pingCounter = pingCounterStore.value;

    const textMetadataStore = textStore.metadata;
    const timeoutMetadataStore = timeoutSecondsStore.metadata;
    const intervalMetadataStore = intervalSecondsStore.metadata;
    const sessionNoteMetadataStore = sessionNoteStore.metadata;
    const pingCounterMetadataStore = pingCounterStore.metadata;
    const validatableDemoStore = new ValidatableStore<number>(0, (value) => {
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100) {
            return { success: true, data: value };
        }
        return { success: false, error: 'value must be an integer in range 0..100' };
    });
    const validatableDemo = fromStore(validatableDemoStore);
    const interceptableDemoStore = new InterceptableStore<string>('hello');
    interceptableDemoStore.onWrite = (value) => value.trim().toUpperCase();
    interceptableDemoStore.onRead = (value) => `read:${value}`;
    const interceptableDemo = fromStore(interceptableDemoStore);

    let lastTaskStatus = $state('');
    let lastTaskEvent = $state('');
    let cleanupStatus = $state('');
    let validatableInput = $state('0');
    let validatableFeedback = $state('Try numbers 0..100. Out-of-range values are ignored.');
    let interceptableInput = $state('hello');
    const currentTabId = synk.tabId;
    let isLeader = $state(synk.isLeader);
    let leaderTabId = $state<string | null>(synk.leaderTabId);

    function parseInteger(value: string, fallback: number): number {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
            return fallback;
        }
        return Math.trunc(parsed);
    }

    synk.registerLeaderTask('timeout-task', async ({ payload }) => {
        const token = (payload as { token?: string } | null)?.token;
        if (!token || !timeoutRunning.current || token !== timeoutToken.current) {
            return;
        }

        timeoutDone.current = true;
        timeoutRunning.current = false;
        lastTaskEvent = 'timeout completed';
    });

    synk.registerLeaderTask('interval-task', async ({ payload }) => {
        const token = (payload as { token?: string } | null)?.token;
        if (!token || !intervalRunning.current || token !== intervalToken.current) {
            return;
        }

        intervalCounter.current += 1;
        lastTaskEvent = 'interval tick';
    });
    synk.registerLeaderTask('ping-task', async () => {
        pingCounter.current += 1;
        lastTaskEvent = 'ping run';
    });

    const stopFailedListener = synk.onLeaderTaskFailed((event) => {
        lastTaskEvent = `failed: ${event.task} (${event.reason})`;
    });
    const stopSkippedListener = synk.onLeaderTaskSkipped((event) => {
        lastTaskEvent = `skipped: ${event.task} (${event.reason})`;
    });
    const stopLeaderStatusListener = synk.onLeaderStatusChanged((event) => {
        leaderTabId = event.leaderTabId;
        isLeader = event.leaderTabId === currentTabId;
    });

    async function startTimeoutTask(): Promise<void> {
        if (timeoutRunning.current) {
            return;
        }

        const seconds = Math.max(0, timeoutSeconds.current);
        const token = createId();
        timeoutDone.current = false;
        timeoutRunning.current = true;
        timeoutToken.current = token;

        const result = await synk.scheduleLeaderTimeoutTask(
            'timeout-task',
            `timeout:${token}`,
            seconds * 1000,
            { token }
        );
        lastTaskStatus = `timeout start -> ${result.status}`;
        if (result.status !== 'accepted') {
            timeoutRunning.current = false;
        }
    }

    function resetTimeoutTask(): void {
        timeoutRunning.current = false;
        timeoutDone.current = false;
        timeoutToken.current = null;
    }

    async function startIntervalTask(): Promise<void> {
        if (intervalRunning.current) {
            return;
        }

        const seconds = Math.max(1, intervalSeconds.current);
        const token = createId();
        intervalRunning.current = true;
        intervalToken.current = token;

        const result = await synk.scheduleLeaderIntervalTask(
            'interval-task',
            `interval:${token}`,
            seconds * 1000,
            { token }
        );
        lastTaskStatus = `interval start -> ${result.status}`;
        if (result.status !== 'accepted') {
            intervalRunning.current = false;
        }
    }

    function stopIntervalTask(): void {
        intervalRunning.current = false;
    }

    function resetIntervalTask(): void {
        intervalRunning.current = false;
        intervalToken.current = null;
        intervalCounter.current = 0;
    }

    async function runPingTask(): Promise<void> {
        const result = await synk.runLeaderTask('ping-task', 'global');
        lastTaskStatus = `ping run -> ${result.status}`;
    }

    async function clearUnregisteredStores(): Promise<void> {
        const removedKeys = await synk.clearUnregisteredUserStores();
        cleanupStatus =
            removedKeys.length > 0
                ? `Removed user-data keys: ${removedKeys.join(', ')}`
                : 'No unregistered user-data keys found.';
    }

    async function clearEverything(): Promise<void> {
        await synk.clearAllPersistedStores();
        cleanupStatus = 'Cleared all persisted stores (user, user-session, system).';
    }

    function applyValidatableInput(): void {
        const parsed = Number(validatableInput);
        if (!Number.isFinite(parsed)) {
            validatableFeedback = 'Not a number. Current value unchanged.';
            return;
        }
        const previous = validatableDemo.current;
        validatableDemoStore.set(parsed);
        validatableFeedback =
            validatableDemo.current === previous && parsed !== previous
                ? 'Rejected by validator (must be integer 0..100).'
                : 'Accepted by validator.';
    }

    function resetValidatable(): void {
        validatableDemoStore.reset();
        validatableFeedback = 'Reset to initial value.';
    }

    function applyInterceptableInput(): void {
        interceptableDemoStore.set(interceptableInput);
    }

    function clearInterceptors(): void {
        interceptableDemoStore.clearInterceptors();
    }

    onDestroy(() => {
        stopFailedListener();
        stopSkippedListener();
        stopLeaderStatusListener();
    });
</script>

<main>
    <h1>Svelte Synk Demo</h1>
    <p>
        Open this page in multiple tabs and interact with controls. Values and timer outcomes should
        stay in sync across tabs.
    </p>
    <h2 class="group-title">Synced Stores and Leader Tasks</h2>

    <section>
        <h3>Cross-tab text synchronisation</h3>
        <p class="case-note">Edit in one tab and confirm the same value appears in other tabs.</p>
        <input
            type="text"
            value={text.current}
            oninput={(event) => textStore.set((event.currentTarget as HTMLInputElement).value)}
        />
    </section>

    <section>
        <h3>Shared numeric state mutations</h3>
        <p class="case-note">
            Use direct input and +/-/clear buttons to verify synced write/update flows.
        </p>
        <div class="row">
            <input
                type="number"
                value={stepper.current}
                oninput={(event) =>
                    (stepper.current = parseInteger(
                        (event.currentTarget as HTMLInputElement).value,
                        stepper.current
                    ))}
            />
            <button onclick={() => (stepper.current += 1)}>+</button>
            <button onclick={() => (stepper.current -= 1)}>-</button>
            <button onclick={() => (stepper.current = 0)}>Clear</button>
        </div>
    </section>

    <section>
        <h3>Leader-only one-shot timeout</h3>
        <p class="case-note">
            Start once, wait for Done banner, and verify only leader runs the task.
        </p>
        <div class="row">
            <input
                type="number"
                min="0"
                value={timeoutSeconds.current}
                disabled={timeoutRunning.current}
                oninput={(event) =>
                    timeoutSecondsStore.set(
                        Math.max(
                            0,
                            parseInteger(
                                (event.currentTarget as HTMLInputElement).value,
                                timeoutSeconds.current
                            )
                        )
                    )}
            />
            <button disabled={timeoutRunning.current} onclick={startTimeoutTask}>Start</button>
            <button onclick={resetTimeoutTask}>Reset</button>
            {#if timeoutDone.current}
                <span class="done">Done</span>
            {/if}
        </div>
    </section>

    <section>
        <h3>Leader interval scheduling and counter sync</h3>
        <p class="case-note">
            Run interval ticks on leader while all tabs observe the same counter updates.
        </p>
        <div class="row">
            <input
                type="number"
                min="1"
                value={intervalSeconds.current}
                disabled={intervalRunning.current}
                oninput={(event) =>
                    intervalSecondsStore.set(
                        Math.max(
                            1,
                            parseInteger(
                                (event.currentTarget as HTMLInputElement).value,
                                intervalSeconds.current
                            )
                        )
                    )}
            />
            <button disabled={intervalRunning.current} onclick={startIntervalTask}>Start</button>
            <button disabled={!intervalRunning.current} onclick={stopIntervalTask}>Stop</button>
            <button onclick={resetIntervalTask}>Reset</button>
            <span>Counter: {intervalCounter.current}</span>
        </div>
    </section>

    <section>
        <h3>Session-lifetime store behaviour</h3>
        <p class="case-note">
            This value is scoped to the current session lifetime, not persistent lifetime.
        </p>
        <div class="row">
            <input
                type="text"
                value={sessionNote.current}
                oninput={(event) =>
                    sessionNoteStore.set((event.currentTarget as HTMLInputElement).value)}
                placeholder="Session-scoped note"
            />
            <small>Lifetime: {$sessionNoteMetadataStore.lifetime}</small>
        </div>
    </section>

    <section>
        <h3>Direct leader task submission API</h3>
        <p class="case-note">Runs a keyed leader task immediately and reports submission status.</p>
        <div class="row">
            <button onclick={runPingTask}>Run ping task on leader</button>
            <span>Ping counter: {pingCounter.current}</span>
            <small>Lifetime: {$pingCounterMetadataStore.lifetime}</small>
        </div>
    </section>

    <h2 class="group-title">Local Utility Stores (Not Synced)</h2>
    <section>
        <h3>ValidatableStore acceptance and rejection</h3>
        <p class="case-note">Applies only values that pass validation (integer range 0..100).</p>
        <div class="row">
            <input
                type="number"
                value={validatableInput}
                oninput={(event) =>
                    (validatableInput = (event.currentTarget as HTMLInputElement).value)}
            />
            <button onclick={applyValidatableInput}>Apply</button>
            <button onclick={resetValidatable}>Reset</button>
            <span>Current value: {validatableDemo.current}</span>
            <span>Is initial: {validatableDemoStore.isInitialValue ? 'yes' : 'no'}</span>
        </div>
        <p>{validatableFeedback}</p>
    </section>

    <section>
        <h3>InterceptableStore read/write transforms</h3>
        <p class="case-note">
            Demonstrates write interception and read mapping in a local-only store.
        </p>
        <div class="row">
            <input
                type="text"
                value={interceptableInput}
                oninput={(event) =>
                    (interceptableInput = (event.currentTarget as HTMLInputElement).value)}
            />
            <button onclick={applyInterceptableInput}>Apply (write interceptor)</button>
            <button onclick={() => interceptableDemoStore.reset()}>Reset</button>
            <button onclick={clearInterceptors}>Clear interceptors</button>
        </div>
        <p>Readable output: <code>{interceptableDemo.current}</code></p>
        <p>Is initial: {interceptableDemoStore.isInitialValue ? 'yes' : 'no'}</p>
    </section>

    <h2 class="group-title">Maintenance and Diagnostics</h2>
    <section>
        <h3>Maintenance APIs</h3>
        <p class="case-note">Runs cleanup operations for user-data or all persisted stores.</p>
        <div class="row">
            <button onclick={clearUnregisteredStores}>Clear unregistered user stores</button>
            <button onclick={clearEverything}>Clear all persisted stores</button>
        </div>
        <p>{cleanupStatus || 'No maintenance action run yet.'}</p>
    </section>

    <section>
        <h3>Debug</h3>
        <p class="case-note">
            Inspect leadership, session id, and hydration/source/lifetime metadata.
        </p>
        <ul>
            <li>Runtime status: {synk.status}</li>
            <li>Is leader: {isLeader ? 'yes' : 'no'}</li>
            <li>Current tab id: {currentTabId}</li>
            <li>Leader tab id: {leaderTabId ?? 'unknown'}</li>
            <li>Session id: {synk.sessionId}</li>
            <li>
                Text metadata: {$textMetadataStore.hydration} / {$textMetadataStore.source} / {$textMetadataStore.lifetime}
            </li>
            <li>
                Timeout metadata: {$timeoutMetadataStore.hydration} / {$timeoutMetadataStore.source} /
                {$timeoutMetadataStore.lifetime}
            </li>
            <li>
                Interval metadata: {$intervalMetadataStore.hydration} / {$intervalMetadataStore.source}
                / {$intervalMetadataStore.lifetime}
            </li>
            <li>
                Session note metadata: {$sessionNoteMetadataStore.hydration} / {$sessionNoteMetadataStore.source}
                / {$sessionNoteMetadataStore.lifetime}
            </li>
            <li>Last submit status: {lastTaskStatus || 'n/a'}</li>
            <li>Last task event: {lastTaskEvent || 'n/a'}</li>
        </ul>
    </section>
</main>

<style>
    :global(body) {
        font-family: system-ui, sans-serif;
    }

    main {
        margin: 0 auto;
        max-width: 52rem;
        padding: 1.5rem 1rem 3rem;
    }

    section {
        border: 1px solid #d6d6d6;
        border-radius: 0.5rem;
        margin-top: 1rem;
        padding: 1rem;
    }

    h1 {
        margin-bottom: 0.25rem;
    }

    h2 {
        font-size: 1rem;
        margin: 0 0 0.75rem;
    }

    h3 {
        font-size: 1rem;
        margin: 0 0 0.75rem;
    }

    .group-title {
        border-bottom: 1px solid #d6d6d6;
        margin: 1.5rem 0 0.75rem;
        padding-bottom: 0.4rem;
    }

    .case-note {
        color: #4a4a4a;
        margin: 0 0 0.75rem;
    }

    .row {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
    }

    input[type='text'],
    input[type='number'] {
        min-width: 10rem;
        padding: 0.35rem 0.5rem;
    }

    button {
        padding: 0.35rem 0.6rem;
    }

    .done {
        color: #137333;
        font-weight: 600;
    }

    ul {
        margin: 0.5rem 0 0;
        padding-left: 1.1rem;
    }
</style>
