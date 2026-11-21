import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
//
// `base: './'` makes every asset and data URL relative to index.html, so the
// same build works at the site root, at a GitHub Pages project path
// (https://<user>.github.io/<repo>/), or opened from any sub-folder. The app
// has no client-side router, so relative URLs are safe.
export default defineConfig({
  base: './',
  plugins: [react()],
})
