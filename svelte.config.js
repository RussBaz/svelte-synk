import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
    kit: {
        adapter: adapter(),
        paths: {
            // GitHub Pages: set BASE_PATH=/svelte-synk in the deploy workflow; leave unset for local dev
            base: process.env.BASE_PATH || ''
        }
    }
};

export default config;
