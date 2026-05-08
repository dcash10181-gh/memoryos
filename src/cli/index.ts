#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';

const program = new Command();

program
  .name('memoryos')
  .description('Institutional memory engine — your company\'s brain')
  .version('1.0.0');

program
  .command('start')
  .description('Start the MemoryOS daemon and MCP server')
  .action(() => { process.argv[2] = 'start'; require('../index'); });

program
  .command('sync')
  .description('Run a data sync')
  .option('--full', 'Full historical backfill (clears cursors and re-indexes everything)')
  .action((opts) => {
    process.argv[2] = 'sync';
    if (opts.full) process.argv.push('--full');
    require('../index');
  });

program
  .command('ask <question>')
  .description('Query your company\'s institutional memory')
  .option('--expert', 'Also find who to ask')
  .action(async (question: string) => {
    const { surfaceProactiveContext } = await import('../tools/proactive.js');
    const result = await surfaceProactiveContext(question, { contextType: 'question', topK: 5, findExperts: true });
    const r = result as { proactive_briefing: string; relevant_artifacts: {title: string; url: string; relevance_score: number}[]; experts: {name: string; email: string}[] };
    console.log(chalk.bold('\n📚 What MemoryOS knows:\n'));
    console.log(r.proactive_briefing);
    if (r.relevant_artifacts.length > 0) {
      console.log(chalk.dim('\nTop related artifacts:'));
      r.relevant_artifacts.slice(0, 3).forEach(a =>
        console.log(`  • ${a.title} — ${a.url ?? 'no url'} (${(a.relevance_score * 100).toFixed(0)}% match)`)
      );
    }
    process.exit(0);
  });

program
  .command('gaps')
  .description('Show knowledge graph gaps found by the reflection engine')
  .action(async () => {
    const { getReflectionStatus } = await import('../reflection/executor.js');
    const status = await getReflectionStatus();
    console.log(JSON.stringify(status, null, 2));
    process.exit(0);
  });

program
  .command('status')
  .description('Show daemon and graph health status')
  .action(async () => {
    const { healthCheck } = await import('../graph/client.js');
    const healthy = await healthCheck();
    console.log(`Neo4j:  ${healthy ? chalk.green('✓ connected') : chalk.red('✗ disconnected')}`);
    console.log(`MCP:    check http://localhost:7890/health`);
    process.exit(0);
  });

program.parse();
