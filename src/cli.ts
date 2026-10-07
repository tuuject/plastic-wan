#!/usr/bin/env node
import { serve } from './application.ts';
import { parseCli } from './cli-options.ts';
import { runDoctor } from './doctor.ts';
import { runAdminReset } from './ingress/admin/recover.ts';
import { loadConfig } from './platform/config.ts';
import { loadEnvFiles } from './platform/load-env.ts';
import { backupDatabase } from './store/database.ts';
import { runConfigure } from './tui/configure.ts';

try {
  loadEnvFiles();
  const options = parseCli(process.argv.slice(2));
  switch (options.command) {
    case 'check-config': {
      const loaded = await loadConfig(options.configPath);
      console.log(
        JSON.stringify({
          status: 'ok',
          config_hash: loaded.hash,
          warnings: loaded.warnings,
          image_enabled: loaded.config.image !== undefined,
        }),
      );
      break;
    }
    case 'backup': {
      const loaded = await loadConfig(options.configPath);
      const path = await backupDatabase(loaded.config);
      console.log(JSON.stringify({ status: 'ok', backup: path }));
      break;
    }
    case 'doctor':
      await runDoctor(options.configPath, options.outputAgentPrompt);
      break;
    case 'serve':
      await serve(options.configPath, options.takeover);
      break;
    case 'configure':
      await runConfigure(options.configPath);
      break;
    case 'admin-reset': {
      if (options.username === undefined) {
        throw new Error('admin-reset requires --username');
      }
      await runAdminReset({
        configPath: options.configPath,
        username: options.username,
        passwordStdin: options.passwordStdin,
      });
      break;
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ status: 'error', error: message }));
  process.exitCode = 1;
}
