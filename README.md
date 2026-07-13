<p align="center">
  <img src="./assets/hero.png" alt="A command-line text factory processing prompts in parallel" width="100%">
</p>

<h1 align="center">Codex CLI Text Generator</h1>

<p align="center">Resumable bulk text generation through the official Codex CLI and your existing ChatGPT login.</p>

<p align="center">
  <a href="./README.md"><img src="https://img.shields.io/badge/README-English-111827?style=for-the-badge" alt="English README"></a>
  <a href="./README.ko.md"><img src="https://img.shields.io/badge/README-%ED%95%9C%EA%B5%AD%EC%96%B4-0F766E?style=for-the-badge" alt="한국어 README"></a>
</p>

No OpenAI API key is required. `codex-text` uses the ChatGPT login already
configured by `codex login` and runs the documented `codex exec` command.

## What it handles

- TXT, JSON, JSONL/NDJSON, and CSV input
- `{{field}}` prompt templates for structured records
- concurrent workers, retries, timeouts, and configurable batches
- one atomic output file per item
- append-only JSONL checkpoints with automatic resume
- prompt/model/profile/schema fingerprints to detect changed jobs
- macOS and Linux available-memory guards
- Codex 5-hour and weekly usage-limit detection with deferred resume
- isolated temporary directories, read-only sandboxes, and ephemeral sessions

## Requirements

- Node.js 20+
- Codex CLI installed
- Codex CLI logged in with ChatGPT, not an API key

```bash
codex login status
# Logged in using ChatGPT
```

## Install

```bash
npm install -g codex-cli-text-generator
```

For local development:

```bash
git clone https://github.com/nathankim0/codex-cli-text-generator.git
cd codex-cli-text-generator
npm link
```

## Single prompt

```bash
codex-text --prompt "Write a concise release note for a calendar app."
codex-text --prompt "Return a JSON object with title and summary." \
  --schema ./examples/article.schema.json \
  --output ./article.json
```

## Bulk prompts

Plain text uses one non-empty line per job:

```bash
codex-text --input prompts.txt --concurrency 3
```

JSONL can provide stable IDs and prompts:

```jsonl
{"id":"welcome-ko","prompt":"Write a Korean welcome email."}
{"id":"welcome-en","prompt":"Write an English welcome email."}
```

```bash
codex-text --input jobs.jsonl --output-dir output/emails
```

Structured records can be combined with a template. Given `products.csv`:

```csv
id,name,audience,tone
starter,Starter Plan,freelancers,friendly
team,Team Plan,small teams,professional
```

And `product-prompt.md`:

```markdown
Write a 100-word product description for {{name}}.
Audience: {{audience}}
Tone: {{tone}}
Return only the finished description.
```

Run:

```bash
codex-text --input products.csv \
  --template-file product-prompt.md \
  --output-dir output/descriptions \
  --results output/descriptions.jsonl \
  --concurrency 2 \
  --retries 2 \
  --batch-size 20 \
  --batch-delay 5
```

## Resume behavior

The results JSONL file is an append-only checkpoint. A later invocation skips
IDs that already have a successful record with the same prompt fingerprint:

```bash
codex-text --input jobs.jsonl
# interrupted after 40 jobs

codex-text --input jobs.jsonl
# resumes with job 41
```

Use `--no-resume` to run every item again. If an existing ID's prompt, model,
profile, or schema path changes, it is regenerated automatically. Keep IDs
unique and stable across runs. Prompt text itself is not stored in checkpoints.

## Options

```text
--model <model>           Codex model override
--profile <name>          Codex config profile
--schema <file>           JSON Schema for structured output
--concurrency <n>         parallel Codex processes (default: 2)
--retries <n>             retries after failure (default: 2)
--batch-size <n>          jobs per batch (default: 20)
--batch-delay <seconds>   pause between batches (default: 5)
--min-free-memory <MiB>   pause below available memory (default: 1024)
--memory-per-worker <MiB> reserve per active job (default: 512)
--memory-poll <seconds>   memory recheck interval (default: 15)
--timeout <seconds>       per-job timeout (default: 300)
--no-resume               rerun successful IDs
--extension <ext>         output file extension (default: txt)
--quiet                   hide per-job progress
```

Run `codex-text --help` for the complete CLI reference.

## Cost, memory, and usage limits

`codex-text` does not set or read `OPENAI_API_KEY`. Authentication and usage
follow the account shown by `codex login status`. Your ChatGPT plan limits still
apply, so begin with the default two workers.

When Codex reports that the 5-hour or weekly limit is exhausted, the affected
item is checkpointed as `deferred`, new work stops, and the process exits with
status `2`. Run the same command after reset; completed items are skipped and
deferred or unstarted items continue automatically.

Before launching each process, the memory guard checks OS-available memory. On
macOS it includes free, inactive, speculative, and purgeable VM pages; on Linux
it uses `MemAvailable`. It waits below the configured floor plus the active
worker reservation. Use `--min-free-memory 0 --memory-per-worker 0` to disable it.

## Security

- Prompts go to `codex exec` over stdin, not command-line arguments.
- Jobs run under `--sandbox read-only` in a new empty temporary directory.
- Sessions use `--ephemeral` and do not fill Codex session history.
- The CLI never reads `~/.codex/auth.json` directly.
- Protect output and checkpoint files if generated content is sensitive.

## Library API

```javascript
import { checkCodex, generateText, loadJobs, runBulk } from 'codex-cli-text-generator';

await checkCodex();
const jobs = await loadJobs('./jobs.jsonl');
const summary = await runBulk({ jobs, concurrency: 2 });
console.log(summary);
```

## License

MIT
