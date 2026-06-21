/** @type {import('next').NextConfig} */

// Intro editor proxy: when NEXT_PUBLIC_INTRO_EDITOR_URL points at the running
// editor (e.g. the droplet's http://IP:5174), serve it under THIS dashboard's own
// origin at /editor-app/* — Vercel terminates TLS and forwards over http, so no
// https/cert setup is needed on the droplet and there's no mixed-content block.
// The editor's own requests are relative, so they resolve under /editor-app/.
const editorOrigin = (process.env.NEXT_PUBLIC_INTRO_EDITOR_URL || '').replace(/\/+$/, '');

const nextConfig = {
  reactStrictMode: true,
  // Allow importing the shared workspace package directly.
  transpilePackages: ['@slate/shared'],
  async rewrites() {
    if (!editorOrigin) return [];
    // The editor page is served at /editor-app; its API calls are root-absolute
    // (/probe, /render, /upload, /presets) so proxy those exact paths too — this
    // avoids any trailing-slash / relative-URL fragility inside the iframe.
    return [
      { source: '/editor-app', destination: `${editorOrigin}/` },
      { source: '/editor-app/:path*', destination: `${editorOrigin}/:path*` },
      { source: '/probe', destination: `${editorOrigin}/probe` },
      { source: '/render', destination: `${editorOrigin}/render` },
      { source: '/upload', destination: `${editorOrigin}/upload` },
      { source: '/presets', destination: `${editorOrigin}/presets` },
      { source: '/presets/:id*', destination: `${editorOrigin}/presets/:id*` },
    ];
  },
};

module.exports = nextConfig;
