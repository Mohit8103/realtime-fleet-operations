import { Command } from 'commander';
import crypto from 'node:crypto';
import { createLogger, runWithCorrelationId } from '@fleet/logger';
import { config } from '@fleet/config';

const logger = createLogger({ service: 'simulator' });

const program = new Command();

program
  .name('fleet-sim')
  .description('Device Fleet Telemetry Simulator CLI')
  .version('1.0.0')
  .option('-d, --devices <count>', 'Number of simulated IoT devices', '10')
  .option('-r, --interval <ms>', 'Telemetry emission interval in milliseconds', '1000')
  .option('-t, --target <url>', 'Ingestion endpoint URL', `http://localhost:${config.api.port}/api/v1/telemetry`)
  .option('--dry-run', 'Generate telemetry without sending HTTP requests', false)
  .action((options) => {
    const correlationId = crypto.randomUUID();

    runWithCorrelationId(correlationId, () => {
      const deviceCount = parseInt(options.devices, 10);
      const intervalMs = parseInt(options.interval, 10);
      const targetUrl = options.target;
      const isDryRun = Boolean(options.dryRun);

      logger.info(
        {
          deviceCount,
          intervalMs,
          targetUrl,
          isDryRun
        },
        '🛰️ Fleet Telemetry Simulator CLI initialized'
      );

      logger.info(
        'Simulator engine is standing by. Feature implementation will stream synthetic telemetry to the ingestion endpoint.'
      );
    });
  });

program.parse(process.argv);
