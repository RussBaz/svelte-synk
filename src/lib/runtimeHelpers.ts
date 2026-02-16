let isBrowserOverride: boolean | undefined;

export function setIsBrowserOverrideTo(value: boolean): void {
    isBrowserOverride = value;
}

export function getIsBrowserOverride(): boolean | undefined {
    return isBrowserOverride;
}

export function clearIsBrowserOverride(): void {
    isBrowserOverride = undefined;
}

export function isBrowser(): boolean {
    const override = getIsBrowserOverride();
    if (override !== undefined) {
        return override;
    }

    // Keep environment detection conservative. Feature checks should gate specific APIs.
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

export function createId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
