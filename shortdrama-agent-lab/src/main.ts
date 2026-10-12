import { createApp } from './app';
import { readConfig } from './config';
import { PostgresDatabase } from './db/client';
import { readDatabaseConfig } from './db/config';
import { PostgresBreakdownRepository } from './breakdown/repository';
import { BreakdownService, UnavailableBreakdownService } from './breakdown/service';
import { ExtractFactsStageRunner } from './breakdown/execution';
import { PiExtractFactsStageExecutor } from './breakdown/pi-executor';
import { LocalProxyStageModelAdapter } from './breakdown/model-adapter';
import { StoryboardService } from './breakdown/storyboard';

async function main() {
  const config = readConfig();
  const databaseConfig = readDatabaseConfig();
  let database: PostgresDatabase | undefined;
  let breakdownService: BreakdownService | UnavailableBreakdownService | undefined;
  let stageRunner: ExtractFactsStageRunner | undefined;
  let storyboardService: StoryboardService | undefined;
  if (databaseConfig) {
    database = new PostgresDatabase(databaseConfig);
    try {
      await database.verifyConnection();
      if (await database.hasMigrations(['001', '002', '003', '004', '005', '006'])) {
        const repository = new PostgresBreakdownRepository(database);
        breakdownService = new BreakdownService(repository, config);
        stageRunner = new ExtractFactsStageRunner(repository, breakdownService,
          new PiExtractFactsStageExecutor(), new LocalProxyStageModelAdapter(config));
        storyboardService = new StoryboardService(database, breakdownService, config);
      } else {
        breakdownService = new UnavailableBreakdownService(
          'PERSISTENCE_MIGRATION_REQUIRED',
          '拆解持久化尚未迁移；请先执行 npm run db:migrate。',
        );
      }
    } catch (error) {
      await database.close().catch(() => undefined);
      throw error;
    }
  }
  const app = await createApp(config, fetch, {
    breakdownService,
    stageRunner,
    storyboardService,
    close: database ? () => database.close() : undefined,
  });
  app.enableShutdownHooks();
  await app.listen(config.port, '127.0.0.1');
  const persistence = breakdownService instanceof BreakdownService ? 'PostgreSQL ready' : 'breakdown persistence unavailable';
  console.log(`Local backend ready: http://127.0.0.1:${config.port} (${persistence}, local only)`);
}
main().catch(() => {
  console.error('本机后端启动失败：请检查 .env、本机 PostgreSQL 和端口占用。未输出凭据或原始错误。');
  process.exitCode = 1;
});
