# god-tibo-text

Bulk text generation through the official Codex CLI and your existing ChatGPT
login. No OpenAI API key is required.

This project is inspired by
[`god-tibo-imagen`](https://github.com/NomaDamas/god-tibo-imagen), but uses the
documented `codex exec` command instead of a private ChatGPT backend endpoint.

## Why

`gtt` turns a file of prompts or structured records into resumable Codex jobs:

- uses the ChatGPT login already configured by `codex login`
- reads TXT, JSON, JSONL/NDJSON, and CSV
- renders `{{field}}` prompt templates
- runs jobs concurrently with retries and per-job timeouts
- divides large runs into rate-limit-friendly batches with a configurable pause
- writes one output file per item
- records an append-only JSONL checkpoint and resumes completed IDs
- runs every job in an isolated temporary directory with a read-only sandbox
- uses ephemeral Codex sessions so bulk jobs do not fill session history

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
npm install -g god-tibo-text
```

For local development:

```bash
git clone https://github.com/nathankim0/god-tibo-text.git
cd god-tibo-text
npm link
```

## Single prompt

```bash
gtt --prompt "Write a concise release note for a calendar app."
gtt --prompt "Return a JSON object with title and summary." \
  --schema ./examples/article.schema.json \
  --output ./article.json
```

## Bulk prompts

Plain text uses one non-empty line per job:

```bash
gtt --input prompts.txt --concurrency 3
```

JSONL can provide stable IDs and prompts:

```jsonl
{"id":"welcome-ko","prompt":"Write a Korean welcome email."}
{"id":"welcome-en","prompt":"Write an English welcome email."}
```

```bash
gtt --input jobs.jsonl --output-dir output/emails
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
gtt --input products.csv \
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
gtt --input jobs.jsonl
# interrupted after 40 jobs

gtt --input jobs.jsonl
# resumes with job 41
```

Use `--no-resume` to run every item again. If an existing ID's prompt, model,
profile, or schema path changes, it is regenerated automatically. Keep IDs
unique and stable across runs; generated output filenames are based on those
IDs. Prompt text itself is not stored in the checkpoint.

## Options

```text
--model <model>         Codex model override
--profile <name>        Codex config profile
--schema <file>         JSON Schema for structured output
--concurrency <n>       parallel Codex processes (default: 2)
--retries <n>           retries after failure (default: 2)
--batch-size <n>        jobs per batch (default: 20)
--batch-delay <seconds> pause between batches (default: 5)
--timeout <seconds>     per-job timeout (default: 300)
--no-resume             rerun successful IDs
--extension <ext>       output file extension (default: txt)
--quiet                 hide per-job progress
```

Run `gtt --help` for the complete CLI reference.

## Cost and limits

`gtt` does not set or read `OPENAI_API_KEY`. Authentication and usage follow
the Codex CLI account currently shown by `codex login status`. Your ChatGPT plan
limits still apply. High concurrency can hit those limits quickly, so start
with the default of two workers.

## Security

- Prompts are passed to `codex exec` over stdin, not command-line arguments.
- Jobs run under `--sandbox read-only` in a new empty temporary directory.
- Sessions use `--ephemeral`.
- The CLI does not read `~/.codex/auth.json` itself.
- Output and checkpoint files may contain sensitive generated content; protect
  them accordingly.

## Library API

```javascript
import { checkCodex, generateText, loadJobs, runBulk } from 'god-tibo-text';

await checkCodex();
const jobs = await loadJobs('./jobs.jsonl');
const summary = await runBulk({ jobs, concurrency: 2 });
console.log(summary);
```

## License

MIT
