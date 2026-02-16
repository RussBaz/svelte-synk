<script lang="ts">
    import SynkProvider from '../lib/SynkProvider.svelte';
    import type { Snippet } from 'svelte';

    let { children } = $props<{ children?: Snippet }>();
</script>

<SynkProvider>
    {@render children?.()}
</SynkProvider>
