README.md
# opencode-runner

A flag-driven TypeScript runner for automating OpenCode commands against a separate target repo.

This repo is the orchestration layer.
Your actual OpenCode commands, skills, and config stay in the target repo.

## Expected target repo structure

```text
target-repo/
├─ opencode.json
└─ .opencode/
   ├─ commands/
   │  └─ migr-flow.md
   └─ skills/
      └─ ...
Install
npm install
Build
npm run build
Run
Sequential mode with a journeys file
npm run start -- \
  --project-dir ../target-repo \
  --command migr-flow \
  --args-template "{journeyId}" \
  --journeys-file ./examples/journeys.json \
  --mode sequential
Parallel mode with a journeys file
npm run start -- \
  --project-dir ../target-repo \
  --command migr-flow \
  --args-template "{journeyId}" \
  --journeys-file ./examples/journeys.json \
  --mode parallel \
  --max-concurrency 4
Single journey
npm run start -- \
  --project-dir ../target-repo \
  --command migr-flow \
  --args-template "{journeyId}" \
  --journey-id journey-001
Different argument shape
npm run start -- \
  --project-dir ../target-repo \
  --command migr-flow \
  --args-template "--journey {journeyId} --dry-run" \
  --journeys-file ./examples/journeys.json \
  --mode parallel \
  --max-concurrency 2
Flags

--project-dir <path>: path to the target repo

--command <name>: OpenCode command name

--args-template <text>: argument template, default is {journeyId}

--journeys-file <path>: JSON file containing an array of strings

--journey-id <id>: run one journey ID

--mode <sequential|parallel>: execution mode

--max-concurrency <n>: concurrency limit for parallel mode

--results-dir <path>: where result files are written, default ./results

--server-url <url>: connect to an existing OpenCode server instead of starting one

Output

The runner writes:

one file per journey in the results directory

one summary file:

summary-sequential.json

or summary-parallel.json

Notes

This repo does not own your OpenCode commands or skills.
They remain in the target repo.

This runner changes into the target repo before creating sessions and executing commands so that the target repo's opencode.json and .opencode resources are used.


## How this co-exists with your target repo

Use a sibling layout like this:

```text
workspace/
├─ target-repo/
│  ├─ opencode.json
│  └─ .opencode/
│     ├─ commands/
│     │  └─ migr-flow.md
│     └─ skills/
│        └─ ...
└─ opencode-runner/
   ├─ package.json
   └─ src/runner.ts

Then run:

cd opencode-runner

npm install

npm run start -- \
  --project-dir ../target-repo \
  --command migr-flow \
  --args-template "{journeyId}" \
  --journeys-file ./examples/journeys.json \
  --mode sequential

Two practical notes:

The code intentionally does not hardcode the command name, skill behavior, or parameter values. Those all come from flags and your target repo’s existing OpenCode command definitions.

The only place you may need to adjust for your installed SDK version is the exact shape of createOpencode() or client.session.command(...) if your local package types differ. The overall structure stays the same.

