import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createOpencode } from "@opencode-ai/sdk";

type Mode = "sequential" | "parallel";

type CliOptions = {
  projectDir: string;
  command: string;
  argsTemplate: string;
  journeysFile?: string;
  journeyId?: string;
  mode: Mode;
  maxConcurrency: number;
  resultsDir: string;
  serverUrl?: string;
};

type RunSuccess = {
  journeyId: string;
  ok: true;
  sessionId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  command: string;
  arguments: string;
  result: unknown;
};

type RunFailure = {
  journeyId: string;
  ok: false;
  sessionId: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  command: string;
  arguments: string;
  error: string;
};

type RunResult = RunSuccess | RunFailure;

function printUsage(): void {
  console.log(`
Usage:

  npm run start -- --project-dir <path> --command <name> [options]

Required:
  --project-dir <path>       Path to the target repo that contains opencode.json and .opencode/
  --command <name>           OpenCode command name, e.g. migr-flow

One of:
  --journey-id <id>          Run a single journey ID
  --journeys-file <path>     JSON file containing an array of journey IDs

Optional:
  --args-template <text>     Argument template, default: "{journeyId}"
  --mode <sequential|parallel>
                             Default: sequential
  --max-concurrency <n>      Default: 3
  --results-dir <path>       Default: ./results
  --server-url <url>         Connect to an existing OpenCode server instead of starting one
  --help                     Show help

Examples:

  npm run start -- \
    --project-dir ../migration-repo \
    --command migr-flow \
    --args-template "{journeyId}" \
    --journeys-file ./examples/journeys.json \
    --mode sequential

  npm run start -- \
    --project-dir ../migration-repo \
    --command migr-flow \
    --args-template "--journey {journeyId} --dry-run" \
    --journeys-file ./examples/journeys.json \
    --mode parallel \
    --max-concurrency 4

  npm run start -- \
    --project-dir ../migration-repo \
    --command migr-flow \
    --args-template "{journeyId}" \
    --journey-id journey-001
`.trim());
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes("--help")) {
    printUsage();
    process.exit(0);
  }

  const args = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;

    const key = token.slice(2);
    const next = argv[i + 1];
    const value = next && !next.startsWith("--") ? next : "true";

    args.set(key, value);

    if (value !== "true") {
      i += 1;
    }
  }

  const projectDir = args.get("project-dir");
  const command = args.get("command");
  const argsTemplate = args.get("args-template") ?? "{journeyId}";
  const journeysFile = args.get("journeys-file");
  const journeyId = args.get("journey-id");
  const mode = (args.get("mode") ?? "sequential") as Mode;
  const maxConcurrency = Number(args.get("max-concurrency") ?? "3");
  const resultsDir = args.get("results-dir") ?? "./results";
  const serverUrl = args.get("server-url");

  if (!projectDir) {
    throw new Error("Missing required --project-dir");
  }

  if (!command) {
    throw new Error("Missing required --command");
  }

  if (!journeyId && !journeysFile) {
    throw new Error("Provide either --journey-id or --journeys-file");
  }

  if (journeyId && journeysFile) {
    throw new Error("Use only one of --journey-id or --journeys-file");
  }

  if (mode !== "sequential" && mode !== "parallel") {
    throw new Error("--mode must be either sequential or parallel");
  }

  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error("--max-concurrency must be a positive integer");
  }

  return {
    projectDir,
    command,
    argsTemplate,
    journeysFile,
    journeyId,
    mode,
    maxConcurrency,
    resultsDir,
    serverUrl,
  };
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveProjectDir(projectDirInput: string): Promise<string> {
  const absolute = path.resolve(projectDirInput);
  const stats = await fs.stat(absolute).catch(() => null);

  if (!stats || !stats.isDirectory()) {
    throw new Error(`Project directory does not exist: ${absolute}`);
  }

  return absolute;
}

async function validateTargetRepo(projectDir: string): Promise<void> {
  const opencodeConfig = path.join(projectDir, "opencode.json");
  const opencodeDir = path.join(projectDir, ".opencode");

  const configExists = await fileExists(opencodeConfig);
  const dotDirExists = await fileExists(opencodeDir);

  if (!configExists) {
    throw new Error(
      `Target repo is missing opencode.json: ${opencodeConfig}`
    );
  }

  if (!dotDirExists) {
    throw new Error(
      `Target repo is missing .opencode directory: ${opencodeDir}`
    );
  }
}

async function loadJourneyIds(
  options: CliOptions,
  runnerCwd: string
): Promise<string[]> {
  if (options.journeyId) {
    return [options.journeyId];
  }

  const journeysFile = path.resolve(runnerCwd, options.journeysFile!);
  const raw = await fs.readFile(journeysFile, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
    throw new Error(
      `Journeys file must be a JSON array of strings: ${journeysFile}`
    );
  }

  if (parsed.length === 0) {
    throw new Error(`Journeys file is empty: ${journeysFile}`);
  }

  return parsed;
}

function buildArguments(template: string, journeyId: string): string {
  return template.replaceAll("{journeyId}", journeyId);
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function createClient(projectDir: string, serverUrl?: string) {
  const originalCwd = process.cwd();
  process.chdir(projectDir);

  try {
    if (serverUrl) {
      return await createOpencode({
        baseUrl: serverUrl,
      });
    }

    return await createOpencode();
  } finally {
    process.chdir(originalCwd);
  }
}

async function createSession(
  client: any,
  projectDir: string,
  title: string
): Promise<{ id: string }> {
  const originalCwd = process.cwd();
  process.chdir(projectDir);

  try {
    const session = await client.session.create({
      body: { title },
    });
    return session;
  } finally {
    process.chdir(originalCwd);
  }
}

async function executeCommand(
  client: any,
  projectDir: string,
  sessionId: string,
  command: string,
  commandArguments: string
): Promise<unknown> {
  const originalCwd = process.cwd();
  process.chdir(projectDir);

  try {
    return await client.session.command({
      path: { id: sessionId },
      body: {
        command,
        arguments: commandArguments,
      },
    });
  } finally {
    process.chdir(originalCwd);
  }
}

async function runOneJourney(
  client: any,
  projectDir: string,
  command: string,
  argsTemplate: string,
  journeyId: string
): Promise<RunResult> {
  const title = `${command} ${journeyId}`;
  const commandArguments = buildArguments(argsTemplate, journeyId);
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();

  let sessionId: string | null = null;

  try {
    const session = await createSession(client, projectDir, title);
    sessionId = session.id;

    const result = await executeCommand(
      client,
      projectDir,
      session.id,
      command,
      commandArguments
    );

    const finishedMs = Date.now();

    return {
      journeyId,
      ok: true,
      sessionId: session.id,
      startedAt,
      finishedAt: new Date(finishedMs).toISOString(),
      durationMs: finishedMs - startedMs,
      command,
      arguments: commandArguments,
      result,
    };
  } catch (error) {
    const finishedMs = Date.now();

    return {
      journeyId,
      ok: false,
      sessionId,
      startedAt,
      finishedAt: new Date(finishedMs).toISOString(),
      durationMs: finishedMs - startedMs,
      command,
      arguments: commandArguments,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function writePerJourneyResult(
  resultsDir: string,
  result: RunResult
): Promise<void> {
  const fileName = `${sanitizeFileName(result.journeyId)}.json`;
  const filePath = path.join(resultsDir, fileName);
  await writeJsonFile(filePath, result);
}

async function runSequential(
  client: any,
  projectDir: string,
  command: string,
  argsTemplate: string,
  journeyIds: string[],
  resultsDir: string
): Promise<RunResult[]> {
  const results: RunResult[] = [];

  for (const journeyId of journeyIds) {
    console.log(`Starting ${command} ${journeyId}`);
    const result = await runOneJourney(
      client,
      projectDir,
      command,
      argsTemplate,
      journeyId
    );
    await writePerJourneyResult(resultsDir, result);

    if (result.ok) {
      console.log(`Finished ${journeyId}`);
    } else {
      console.error(`Failed ${journeyId}: ${result.error}`);
    }

    results.push(result);
  }

  return results;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function consume(): Promise<void> {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;

      if (current >= items.length) {
        return;
      }

      results[current] = await worker(items[current]);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => consume()
  );

  await Promise.all(workers);
  return results;
}

async function runParallel(
  client: any,
  projectDir: string,
  command: string,
  argsTemplate: string,
  journeyIds: string[],
  maxConcurrency: number,
  resultsDir: string
): Promise<RunResult[]> {
  return await mapWithConcurrency(journeyIds, maxConcurrency, async (journeyId) => {
    console.log(`Starting ${command} ${journeyId}`);

    const result = await runOneJourney(
      client,
      projectDir,
      command,
      argsTemplate,
      journeyId
    );

    await writePerJourneyResult(resultsDir, result);

    if (result.ok) {
      console.log(`Finished ${journeyId}`);
    } else {
      console.error(`Failed ${journeyId}: ${result.error}`);
    }

    return result;
  });
}

async function main(): Promise<void> {
  const runnerCwd = process.cwd();
  const options = parseArgs(process.argv.slice(2));
  const projectDir = await resolveProjectDir(options.projectDir);
  const resultsDir = path.resolve(runnerCwd, options.resultsDir);

  await validateTargetRepo(projectDir);
  await ensureDir(resultsDir);

  const journeyIds = await loadJourneyIds(options, runnerCwd);

  console.log(`Target repo: ${projectDir}`);
  console.log(`Mode: ${options.mode}`);
  console.log(`Journeys: ${journeyIds.length}`);
  console.log(`Results dir: ${resultsDir}`);

  const opencode = await createClient(projectDir, options.serverUrl);
  const client = opencode.client;

  const results =
    options.mode === "parallel"
      ? await runParallel(
          client,
          projectDir,
          options.command,
          options.argsTemplate,
          journeyIds,
          options.maxConcurrency,
          resultsDir
        )
      : await runSequential(
          client,
          projectDir,
          options.command,
          options.argsTemplate,
          journeyIds,
          resultsDir
        );

  const summary = {
    projectDir,
    mode: options.mode,
    command: options.command,
    argsTemplate: options.argsTemplate,
    total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    generatedAt: new Date().toISOString(),
    results,
  };

  const summaryFile =
    options.mode === "parallel"
      ? path.join(resultsDir, "summary-parallel.json")
      : path.join(resultsDir, "summary-sequential.json");

  await writeJsonFile(summaryFile, summary);

  console.log(`Wrote summary: ${summaryFile}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});