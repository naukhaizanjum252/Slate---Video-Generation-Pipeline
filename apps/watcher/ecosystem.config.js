module.exports = {
  apps: [
    {
      name: 'slate-watcher',
      script: 'dist/index.js',
      cwd: '/root/slate/apps/watcher',
      watch: false,
      restart_delay: 5000,
      max_restarts: 10,
      node_args: '--max-old-space-size=512',
      error_file: '/root/slate/logs/watcher-error.log',
      out_file: '/root/slate/logs/watcher-out.log',
      merge_logs: true,
      env: { NODE_ENV: 'production' },
    },
  ],
};
