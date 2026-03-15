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

type StepProgress = {
  name: string;
  status: "pending" | "running" | "done" | "failed";
};

type ToolProgress = {
  toolName: string;
  status: "pending" | "running" | "done" | "failed";
};

type JourneyStatus =
  | "pending"
  | "thinking"
  | "tool"
  | "step"
  | "success"
  | "failed";

interface JourneyProgress {
  journeyId: string;
  status: JourneyStatus;
  steps?: StepProgress[];
  tools?: ToolProgress[];
}

interface RunResult {
  journeyId: string;
  ok: boolean;
  sessionId: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  command: string;
  arguments: string;
  result?: unknown;
  error?: string;
}

function printUsage(): void {
  console.log(`
Usage:
  npm run start -- --project-dir <path> --command <name> [options]

Required:
  --project-dir <path>       Path to the target repo containing opencode.json and .opencode/
  --command <name>           OpenCode command name

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
  --help                     Show this message
`);
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes("--help")) {
    printUsage();
    process.exit(0);
  }

  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    const value = next && !next.startsWith("--") ? next : "true";
    args.set(key, value);
    if (value !== "true") i++;
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

  if (!projectDir) throw new Error("Missing required --project-dir");
  if (!command) throw new Error("Missing required --command");
  if (!journeyId && !journeysFile)
    throw new Error("Provide either --journey-id or --journeys-file");
  if (journeyId && journeysFile)
    throw new Error("Use only one of --journey-id or --journeys-file");
  if (mode !== "sequential" && mode !== "parallel")
    throw new Error("--mode must be sequential or parallel");
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1)
    throw new Error("--max-concurrency must be a positive integer");

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

async function ensureDir(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveProjectDir(dirInput: string) {
  const abs = path.resolve(dirInput);
  const stats = await fs.stat(abs).catch(() => null);
  if (!stats || !stats.isDirectory())
    throw new Error(`Project directory does not exist: ${abs}`);
  return abs;
}

async function validateTargetRepo(projectDir: string) {
  const opencodeConfig = path.join(projectDir, "opencode.json");
  const opencodeDir = path.join(projectDir, ".opencode");
  if (!(await fileExists(opencodeConfig)))
    throw new Error(`Target repo missing opencode.json: ${opencodeConfig}`);
  if (!(await fileExists(opencodeDir)))
    throw new Error(`Target repo missing .opencode/: ${opencodeDir}`);
}

async function loadJourneyIds(options: CliOptions, cwd: string) {
  if (options.journeyId) return [options.journeyId];
  const file = path.resolve(cwd, options.journeysFile!);
  const raw = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string"))
    throw new Error("Journeys file must be a JSON array of strings");
  return parsed;
}

function buildArguments(template: string, journeyId: string) {
  return template.replaceAll("{journeyId}", journeyId);
}

function sanitizeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function writeJsonFile(filePath: string, data: unknown) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

// ---------------- TUI-style progress ----------------

function renderProgress(progressList: JourneyProgress[]) {
  console.clear();
  console.log("OpenCode Runner Progress:\n");

  progressList.forEach((j, idx) => {
    const counter = `[${idx + 1}/${progressList.length}]`;
    let symbol = "⏳";
    switch (j.status) {
      case "thinking":
        symbol = "💭";
        break;
      case "tool":
        symbol = "🛠️";
        break;
      case "step":
        symbol = "🔹";
        break;
      case "success":
        symbol = "✅";
        break;
      case "failed":
        symbol = "❌";
        break;
    }
    console.log(`${counter} ${symbol} ${j.journeyId}`);

    if (j.steps) {
      j.steps.forEach((s) => {
        const sSymbol =
          s.status === "pending"
            ? "⏳"
            : s.status === "running"
            ? "🏃"
            : s.status === "done"
            ? "✅"
            : "❌";
        console.log(`    [STEP] ${sSymbol} ${s.name}`);
      });
    }

    if (j.tools) {
      j.tools.forEach((t) => {
        const tSymbol =
          t.status === "pending"
            ? "⏳"
            : t.status === "running"
            ? "🏃"
            : t.status === "done"
            ? "✅"
            : "❌";
        console.log(`    [TOOL] ${tSymbol} ${t.toolName}`);
      });
    }
  });
}

// ---------------- Runner functions ----------------

async function createClient(projectDir: string, serverUrl?: string) {
  const originalCwd = process.cwd();
  process.chdir(projectDir);
  try {
    return await createOpencode({ baseUrl: serverUrl });
  } finally {
    process.chdir(originalCwd);
  }
}

async function runJourney(
  client: any,
  projectDir: string,
  command: string,
  argsTemplate: string,
  journeyId: string,
  journeyProgress: JourneyProgress
): Promise<RunResult> {
  journeyProgress.status = "thinking";
  renderProgress([journeyProgress]);

  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  let sessionId: string | null = null;

  try {
    const session = await client.session.create({ body: { title: `${command} ${journeyId}` } });
    sessionId = session.id;

    // Simulate thinking phase
    journeyProgress.status = "thinking";
    renderProgress([journeyProgress]);
    await new Promise((r) => setTimeout(r, 200));

    // Simulate tool execution
    journeyProgress.status = "tool";
    journeyProgress.tools = [{ toolName: "SimulatedTool", status: "running" }];
    renderProgress([journeyProgress]);
    await new Promise((r) => setTimeout(r, 300));
    journeyProgress.tools[0].status = "done";

    // Simulate step execution
    journeyProgress.status = "step";
    journeyProgress.steps = [{ name: "Execute Step", status: "running" }];
    renderProgress([journeyProgress]);
    await new Promise((r) => setTimeout(r, 200));
    journeyProgress.steps[0].status = "done";

    const result = await client.session.command({
      path: { id: session.id },
      body: {
        command,
        arguments: buildArguments(argsTemplate, journeyId),
      },
    });

    const finishedMs = Date.now();
    journeyProgress.status = "success";
    renderProgress([journeyProgress]);

    return {
      journeyId,
      ok: true,
      sessionId,
      startedAt,
      finishedAt: new Date(finishedMs).toISOString(),
      durationMs: finishedMs - startedMs,
      command,
      arguments: buildArguments(argsTemplate, journeyId),
      result,
    };
  } catch (error) {
    const finishedMs = Date.now();
    journeyProgress.status = "failed";
    renderProgress([journeyProgress]);
    return {
      journeyId,
      ok: false,
      sessionId,
      startedAt,
      finishedAt: new Date(finishedMs).toISOString(),
      durationMs: finishedMs - startedMs,
      command,
      arguments: buildArguments(argsTemplate, journeyId),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------- Main ----------------

async function main() {
  const runnerCwd = process.cwd();
  const options = parseArgs(process.argv.slice(2));
  const projectDir = await resolveProjectDir(options.projectDir);
  await validateTargetRepo(projectDir);
  const resultsDir = path.resolve(runnerCwd, options.resultsDir);
  await ensureDir(resultsDir);

  const journeyIds = await loadJourneyIds(options, runnerCwd);

  const clientWrapper = await createClient(projectDir, options.serverUrl);
  const client = clientWrapper.client;

  // Initialize progress list
  const progressList: JourneyProgress[] = journeyIds.map((id) => ({
    journeyId: id,
    status: "pending",
  }));

  renderProgress(progressList);

  const results: RunResult[] = [];

  if (options.mode === "sequential") {
    for (let i = 0; i < journeyIds.length; i++) {
      const journeyId = journeyIds[i];
      const res = await runJourney(client, projectDir, options.command, options.argsTemplate, journeyId, progressList[i]);
      results.push(res);
      await writeJsonFile(path.join(resultsDir, `${sanitizeFileName(journeyId)}.json`), res);
    }
  } else {
    // Parallel
    const mapWithConcurrency = async <T, R>(items: T[], limit: number, worker: (item: T, idx: number) => Promise<R>) => {
      const results: R[] = new Array(items.length);
      let index = 0;
      const consume = async () => {
        while (true) {
          const i = index;
          index++;
          if (i >= items.length) return;
          results[i] = await worker(items[i], i);
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => consume()));
      return results;
    };

    const parallelResults = await mapWithConcurrency(
      journeyIds,
      options.maxConcurrency,
      async (jId, idx) => {
        const res = await runJourney(client, projectDir, options.command, options.argsTemplate, jId, progressList[idx]);
        await writeJsonFile(path.join(resultsDir, `${sanitizeFileName(jId)}.json`), res);
        return res;
      }
    );
    results.push(...parallelResults);
  }

  // Write summary
  await writeJsonFile(path.join(resultsDir, options.mode === "parallel" ? "summary-parallel.json" : "summary-sequential.json"), results);
  console.log("\nAll journeys complete!");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
