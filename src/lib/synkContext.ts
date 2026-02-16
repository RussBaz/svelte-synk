import { createContext } from 'svelte';
import type { SynkPublicStore, SynkStore, SynkStoreOptions } from './synkStore.ts';

export type SynkContextValue = {
    synk: SynkStore;
};

export const [getSynkContext, setSynkContext] = createContext<SynkContextValue>();
export const getSynk = (): SynkStore => {
    try {
        return getSynkContext().synk;
    } catch {
        throw new Error('Synk context is missing. Wrap your app tree with <SynkProvider>.');
    }
};
