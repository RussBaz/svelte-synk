<script lang="ts">
    import { onDestroy } from 'svelte';
    import { initSynk, type SynkOptions } from './synkStore.ts';
    import { setSynkContext } from './synkContext.ts';
    import type { Snippet } from 'svelte';

    let { options, children } = $props<{
        options?: SynkOptions;
        children?: Snippet;
    }>();

    const createSynk = () => initSynk(options);
    const synk = createSynk();
    const context = { synk };
    setSynkContext(context);

    onDestroy(() => {
        void synk.close();
    });
</script>

{@render children?.()}
