module.exports = {
  apps: [
    {
      name: 'tdrive-app',
      cwd: __dirname,
      script: 'src/app.js',
      instances: 1, // Menggunakan 1 instance (disarankan untuk pool koneksi GramJS)
      autorestart: true,
      watch: false, // Set true jika ingin auto-restart saat ada file source code yang berubah
      max_memory_restart: '800M', // Restart otomatis jika memori melebihi batas ini
      // Keep PM2 limited to process-management settings. Application settings,
      // including NODE_ENV and secrets, are loaded by dotenv from the project .env.
      // Pin only the listener required by the Nginx upstream.
      env: {
        PORT: 3101,
      },
      // Kustomisasi logging PM2
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
