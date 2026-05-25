import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://null0NULL123.github.io',
  output: 'static',
  build: {
    assets: '_assets',
  },
  integrations: [sitemap()],
});
