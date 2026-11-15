import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CanonicalRequest } from '../core/types';
import { loadCredentialPool } from '../credentials/pool';
import { defaultAdapterMap } from '../providers/defaults';
import { MockProviderAdapter } from '../providers/mock';
import type { Credential, ProviderAdapter } from '../providers/types';
import { grade, type BucketName, type EvalPrompt, type GradeResult } from './grade';

export const BUCKET_NAMES: ReadonlyArray<BucketName> = [
  'json_extraction',
  'math',
  'code_generation',
  'structured_extraction',
];

export interface EvalRunOptions {
  adapter?: ProviderAdapter;
  promptsDir?: string;
  runsPerPrompt?: number;
  buckets?: BucketName[];
  model?: string;
  onProgress?: (progress: {
    bucket: BucketName;
    promptIndex: number;
    totalPrompts: number;
    runIndex: number;
    runsPerPrompt: number;
  }) => void;
}

export interface BucketStats {
  bucket: BucketName;
  promptsCount: number;
  runsPerPrompt: number;
  totalRuns: number;
  passedRuns: number;
  passAt1: number;
  avgScore: number;
}

export interface EvalReport {
  model: string;
  runsPerPrompt: number;
  buckets: Record<BucketName, BucketStats>;
  overall: {
    totalPrompts: number;
    totalRuns: number;
    totalPassed: number;
    passAt1: number;
    avgScore: number;
  };
  markdown: string;
}

/**
 * Load all prompt JSON files from the prompts directory.
 */
export function loadPrompts(
  promptsDir?: string,
  targetBuckets?: ReadonlyArray<BucketName>,
): EvalPrompt[] {
  const rootDir = promptsDir ?? path.join(__dirname, 'prompts');
  const bucketsToLoad = targetBuckets ?? BUCKET_NAMES;
  const prompts: EvalPrompt[] = [];

  for (const bucket of bucketsToLoad) {
    const bucketDir = path.join(rootDir, bucket);
    if (!fs.existsSync(bucketDir)) continue;

    const files = fs
      .readdirSync(bucketDir)
      .filter((f) => f.endsWith('.json'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    for (const file of files) {
      const fullPath = path.join(bucketDir, file);
      const raw = fs.readFileSync(fullPath, 'utf8');
      const parsed = JSON.parse(raw) as EvalPrompt;
      prompts.push(parsed);
    }
  }

  return prompts;
}

/**
 * Render evaluation report as GitHub-flavored Markdown tables stating n=3 per cell.
 */
export function formatMarkdownReport(report: Omit<EvalReport, 'markdown'>): string {
  const { model, runsPerPrompt, buckets, overall } = report;

  const lines: string[] = [];

  lines.push(`# Eval Benchmark Results (n=${runsPerPrompt} per cell)`);
  lines.push('');
  lines.push(`**Model:** \`${model}\`  `);
  lines.push(`**Runs per prompt (n):** ${runsPerPrompt}  `);
  lines.push(`**Total prompts:** ${overall.totalPrompts} (25 per bucket)  `);
  lines.push(`**Total runs:** ${overall.totalRuns}  `);
  lines.push('');
  lines.push('### Bucket Performance (n=' + runsPerPrompt + ' per cell)');
  lines.push('');
  lines.push(
    '| Bucket | Prompts | Runs (n=' +
      runsPerPrompt +
      '/cell) | Pass Count | pass@1 Rate (n=' +
      runsPerPrompt +
      '/cell) | Avg Score |',
  );
  lines.push('|---|---|---|---|---|---|');

  for (const bucket of BUCKET_NAMES) {
    const stat = buckets[bucket];
    if (!stat) continue;
    const passPercent = (stat.passAt1 * 100).toFixed(1) + '%';
    const passCell = `${passPercent} (n=${runsPerPrompt})`;
    lines.push(
      `| \`${stat.bucket}\` | ${stat.promptsCount} | ${stat.totalRuns} | ${stat.passedRuns} | ${passCell} | ${stat.avgScore.toFixed(3)} |`,
    );
  }

  const overallPassPercent = (overall.passAt1 * 100).toFixed(1) + '%';
  lines.push(
    `| **Overall** | **${overall.totalPrompts}** | **${overall.totalRuns}** | **${overall.totalPassed}** | **${overallPassPercent} (n=${runsPerPrompt})** | **${overall.avgScore.toFixed(3)}** |`,
  );
  lines.push('');

  lines.push('### Model Matrix (n=' + runsPerPrompt + ' per cell)');
  lines.push('');
  lines.push(
    '| Model | json_extraction (n=' +
      runsPerPrompt +
      ') | math (n=' +
      runsPerPrompt +
      ') | code_generation (n=' +
      runsPerPrompt +
      ') | structured_extraction (n=' +
      runsPerPrompt +
      ') | Overall (n=' +
      runsPerPrompt +
      ') |',
  );
  lines.push('|---|---|---|---|---|---|');

  const jsonPass =
    ((buckets['json_extraction']?.passAt1 ?? 0) * 100).toFixed(1) + '% (n=' + runsPerPrompt + ')';
  const mathPass =
    ((buckets['math']?.passAt1 ?? 0) * 100).toFixed(1) + '% (n=' + runsPerPrompt + ')';
  const codePass =
    ((buckets['code_generation']?.passAt1 ?? 0) * 100).toFixed(1) + '% (n=' + runsPerPrompt + ')';
  const structPass =
    ((buckets['structured_extraction']?.passAt1 ?? 0) * 100).toFixed(1) +
    '% (n=' +
    runsPerPrompt +
    ')';
  const overallCell = overallPassPercent + ' (n=' + runsPerPrompt + ')';

  lines.push(
    `| \`${model}\` | ${jsonPass} | ${mathPass} | ${codePass} | ${structPass} | ${overallCell} |`,
  );
  lines.push('');

  return lines.join('\n');
}

/**
 * Execute evaluation suite across all prompts.
 */
export async function runEval(options: EvalRunOptions = {}): Promise<EvalReport> {
  const runsPerPrompt = options.runsPerPrompt ?? 3;
  const modelName = options.model ?? 'mock-model';
  const prompts = loadPrompts(options.promptsDir, options.buckets);

  if (prompts.length === 0) {
    throw new Error('No prompts found to evaluate');
  }

  // Bucket trackers
  const bucketResults: Record<
    BucketName,
    {
      promptsCount: number;
      passedRuns: number;
      totalRuns: number;
      scores: number[];
    }
  > = {
    json_extraction: { promptsCount: 0, passedRuns: 0, totalRuns: 0, scores: [] },
    math: { promptsCount: 0, passedRuns: 0, totalRuns: 0, scores: [] },
    code_generation: { promptsCount: 0, passedRuns: 0, totalRuns: 0, scores: [] },
    structured_extraction: { promptsCount: 0, passedRuns: 0, totalRuns: 0, scores: [] },
  };

  const defaultCred: Credential = {
    id: 'eval-cred',
    provider: 'mock',
    secret: 'eval-secret',
  };

  let promptCounter = 0;
  for (const prompt of prompts) {
    promptCounter++;
    const bTracker = bucketResults[prompt.bucket];
    bTracker.promptsCount++;

    for (let r = 0; r < runsPerPrompt; r++) {
      options.onProgress?.({
        bucket: prompt.bucket,
        promptIndex: promptCounter,
        totalPrompts: prompts.length,
        runIndex: r + 1,
        runsPerPrompt,
      });

      // Construct adapter per prompt if using default mock adapter
      const adapter: ProviderAdapter =
        options.adapter ??
        new MockProviderAdapter({
          id: 'mock',
          model: modelName,
          content: prompt.referenceAnswer,
        });

      const request: CanonicalRequest = {
        model: modelName,
        messages: [{ role: 'user', content: prompt.prompt }],
      };

      const response = await adapter.chat(request, defaultCred);
      const choice = response.choices[0];
      const outputText = choice?.message.content ?? '';

      const gradeResult: GradeResult = grade(prompt, outputText);

      bTracker.totalRuns++;
      if (gradeResult.passed) {
        bTracker.passedRuns++;
      }
      bTracker.scores.push(gradeResult.score);
    }
  }

  // Build summary stats
  const buckets: Record<BucketName, BucketStats> = {} as Record<BucketName, BucketStats>;
  let totalPrompts = 0;
  let totalRuns = 0;
  let totalPassed = 0;
  let totalScoreSum = 0;

  for (const b of BUCKET_NAMES) {
    const data = bucketResults[b];
    const passAt1 = data.totalRuns > 0 ? data.passedRuns / data.totalRuns : 0;
    const sumScores = data.scores.reduce((acc, s) => acc + s, 0);
    const avgScore = data.scores.length > 0 ? sumScores / data.scores.length : 0;

    buckets[b] = {
      bucket: b,
      promptsCount: data.promptsCount,
      runsPerPrompt,
      totalRuns: data.totalRuns,
      passedRuns: data.passedRuns,
      passAt1,
      avgScore,
    };

    totalPrompts += data.promptsCount;
    totalRuns += data.totalRuns;
    totalPassed += data.passedRuns;
    totalScoreSum += sumScores;
  }

  const overall = {
    totalPrompts,
    totalRuns,
    totalPassed,
    passAt1: totalRuns > 0 ? totalPassed / totalRuns : 0,
    avgScore: totalRuns > 0 ? totalScoreSum / totalRuns : 0,
  };

  const reportWithoutMd = {
    model: modelName,
    runsPerPrompt,
    buckets,
    overall,
  };

  const markdown = formatMarkdownReport(reportWithoutMd);

  return {
    ...reportWithoutMd,
    markdown,
  };
}

/**
 * Parse CLI flags for running eval.
 */
export function parseArgs(args: string[]): {
  runs: number;
  model: string;
  provider?: string;
  quiet: boolean;
} {
  let runs = 3;
  let model = 'mock-model';
  let provider: string | undefined;
  let quiet = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--runs' && i + 1 < args.length) {
      runs = parseInt(args[++i] ?? '3', 10);
    } else if (arg === '--model' && i + 1 < args.length) {
      model = args[++i] ?? 'mock-model';
    } else if (arg === '--provider' && i + 1 < args.length) {
      provider = args[++i];
    } else if (arg === '--quiet') {
      quiet = true;
    }
  }

  return { runs, model, provider, quiet };
}

/**
 * CLI Entry point.
 */
export async function main(): Promise<void> {
  const { runs, model, provider, quiet } = parseArgs(process.argv.slice(2));

  let adapter: ProviderAdapter | undefined;

  if (provider) {
    const adapters = defaultAdapterMap();
    adapter = adapters.get(provider);
    if (!adapter) {
      console.error(`Error: Provider "${provider}" not found in default adapters.`);
      process.exitCode = 1;
      return;
    }
    const pool = loadCredentialPool(process.env);
    const creds = pool.getCandidates(provider);
    if (creds.length === 0) {
      console.error(`Error: No credentials found in environment for provider "${provider}".`);
      process.exitCode = 1;
      return;
    }
  }

  if (!quiet) {
    console.log(`Starting eval run (n=${runs} per cell)...`);
  }

  const report = await runEval({
    runsPerPrompt: runs,
    model,
    adapter,
  });

  console.log(report.markdown);

  const resultsDir = process.cwd();
  fs.writeFileSync(path.join(resultsDir, 'eval-results.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(resultsDir, 'eval-results.md'), report.markdown);

  if (!quiet) {
    console.log('\nEval results written to eval-results.json and eval-results.md');
  }
}

if (require.main === module) {
  void main().catch((err) => {
    console.error('Eval harness failed:', err);
    process.exitCode = 1;
  });
}
