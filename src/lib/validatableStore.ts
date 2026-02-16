import {
    writable,
    type Subscriber,
    type Unsubscriber,
    type Updater,
    type Writable
} from 'svelte/store';

export type ValidationResult<T> =
    | {
          success: true;
          data: T;
      }
    | {
          success: false;
          error: unknown;
      };

export class ValidatableStore<T> implements Writable<T> {
    #store: Writable<T>;
    /**
     * Must return a `ValidationResult` and should not throw.
     * Validation failures are expected to be represented as `{ success: false, error }`.
     */
    #validate: (value: unknown) => ValidationResult<T>;
    #initialValue: T;
    #isInitialValue: boolean = true;

    constructor(initialValue: T, validate: (value: unknown) => ValidationResult<T>) {
        this.#initialValue = structuredClone(initialValue);
        this.#store = writable(this.#initialValue);
        this.#validate = validate;
    }
    set(value: unknown) {
        const validationResult = this.#validate(value);
        if (validationResult.success) {
            this.#isInitialValue = false;
            this.#store.set(validationResult.data);
        }
    }
    update(updater: Updater<T>) {
        this.#store.update((currentValue) => {
            const newValue = updater(currentValue);
            const validated = this.#validate(newValue);
            if (validated.success) {
                this.#isInitialValue = false;
                return validated.data;
            } else {
                return currentValue;
            }
        });
    }
    subscribe(run: Subscriber<T>, invalidate?: () => void): Unsubscriber {
        return this.#store.subscribe(run, invalidate);
    }
    get isInitialValue(): boolean {
        return this.#isInitialValue;
    }
    reset() {
        this.#isInitialValue = true;
        this.#store.set(structuredClone(this.#initialValue));
    }
}
