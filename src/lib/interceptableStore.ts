import { writable, type Subscriber, type Unsubscriber, type Writable } from 'svelte/store';

export class InterceptableStore<T> implements Writable<T> {
    #store: Writable<T>;
    onRead: ((value: T) => T) | undefined;
    onWrite: ((value: T) => T) | undefined;
    #isInitialValue: boolean = true;
    #initialState: T;

    constructor(initialValue: T) {
        this.#store = writable(initialValue);
        this.#initialState = structuredClone(initialValue);
    }

    subscribe(run: Subscriber<T>): Unsubscriber {
        return this.#store.subscribe((value) => {
            if (this.onRead) {
                run(this.onRead(value));
            } else {
                run(value);
            }
        });
    }

    get isInitialValue(): boolean {
        return this.#isInitialValue;
    }

    set(value: T): void {
        this.#isInitialValue = false;
        if (this.onWrite) {
            const interceptedValue = this.onWrite(value);
            this.#store.set(interceptedValue);
        } else {
            this.#store.set(value);
        }
    }

    // only set true if you are certain that the interceptor triggering is required
    reset(triggerOnWrite: boolean = false): void {
        if (triggerOnWrite) {
            this.set(this.#initialState);
        } else {
            this.#store.set(this.#initialState);
        }
        this.#isInitialValue = true;
    }

    update(updater: (state: T) => T): void {
        this.#isInitialValue = false;
        this.#store.update((currentValue) => {
            const newValue = updater(currentValue);
            if (this.onWrite) {
                return this.onWrite(newValue);
            } else {
                return newValue;
            }
        });
    }

    clearInterceptors(): void {
        this.onRead = undefined;
        this.onWrite = undefined;
    }
}
