import { isBrowser } from './runtimeHelpers.ts';

function getLockManager(): LockManager | undefined {
    if (
        !isBrowser() ||
        typeof navigator === 'undefined' ||
        typeof navigator.locks === 'undefined'
    ) {
        return undefined;
    }

    return navigator.locks;
}

export function isWebLocksApiAvailable(): boolean {
    return getLockManager() !== undefined;
}

export type WebLockRequestResult<T> = { available: true; value: T } | { available: false };

export async function requestWebLock<T>(
    name: string,
    callback: (lock: Lock | null) => Promise<T> | T,
    options?: LockOptions
): Promise<WebLockRequestResult<T>> {
    const lockManager = getLockManager();
    if (!lockManager) {
        return { available: false };
    }

    if (options) {
        return {
            available: true,
            value: await lockManager.request(name, options, callback)
        };
    }

    return {
        available: true,
        value: await lockManager.request(name, callback)
    };
}
