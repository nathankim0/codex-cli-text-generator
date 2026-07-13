<p align="center">
  <img src="./assets/hero.png" alt="여러 프롬프트를 병렬로 처리하는 명령줄 텍스트 공장" width="100%">
</p>

<h1 align="center">Codex CLI Text Generator</h1>

<p align="center">기존 ChatGPT 로그인과 공식 Codex CLI를 이용하는 중단 복구형 대량 텍스트 생성기</p>

<p align="center">
  <a href="./README.md"><img src="https://img.shields.io/badge/README-English-111827?style=for-the-badge" alt="English README"></a>
  <a href="./README.ko.md"><img src="https://img.shields.io/badge/README-%ED%95%9C%EA%B5%AD%EC%96%B4-0F766E?style=for-the-badge" alt="한국어 README"></a>
</p>

OpenAI API 키는 필요하지 않습니다. `codex-text`는 `codex login`에 등록된
ChatGPT 로그인을 사용하며, 공식 명령인 `codex exec`를 실행합니다.

## 주요 기능

- TXT, JSON, JSONL/NDJSON, CSV 입력
- 구조화된 레코드에 `{{field}}` 프롬프트 템플릿 적용
- 병렬 워커, 실패 재시도, 작업별 타임아웃, 배치 간 대기
- 항목별 결과 파일 원자적 저장
- append-only JSONL 체크포인트와 자동 이어서 실행
- 프롬프트·모델·프로필·스키마 지문으로 변경된 작업 자동 감지
- macOS와 Linux의 실제 가용 메모리 확인
- Codex 5시간·주간 한도 감지 후 작업 보류 및 재개
- 작업별 임시 폴더, 읽기 전용 샌드박스, 일회성 세션

## 준비 사항

- Node.js 20 이상
- Codex CLI 설치
- API 키가 아닌 ChatGPT 계정으로 Codex CLI 로그인

```bash
codex login status
# Logged in using ChatGPT
```

## 설치

```bash
npm install -g github:nathankim0/codex-cli-text-generator
```

로컬에서 개발할 때:

```bash
git clone https://github.com/nathankim0/codex-cli-text-generator.git
cd codex-cli-text-generator
npm link
```

## 단일 프롬프트

```bash
codex-text --prompt "달력 앱의 간결한 릴리스 노트를 작성해줘."
codex-text --prompt "title과 summary가 있는 JSON 객체만 반환해줘." \
  --schema ./examples/article.schema.json \
  --output ./article.json
```

## 대량 생성

TXT는 비어 있지 않은 한 줄을 작업 하나로 읽습니다.

```bash
codex-text --input prompts.txt --concurrency 3
```

JSONL에서는 안정적인 ID와 프롬프트를 지정할 수 있습니다.

```jsonl
{"id":"welcome-ko","prompt":"한국어 환영 이메일을 작성해줘."}
{"id":"welcome-en","prompt":"Write an English welcome email."}
```

```bash
codex-text --input jobs.jsonl --output-dir output/emails
```

CSV 같은 구조화 데이터에는 템플릿을 결합할 수 있습니다. `products.csv`:

```csv
id,name,audience,tone
starter,Starter Plan,freelancers,friendly
team,Team Plan,small teams,professional
```

`product-prompt.md`:

```markdown
{{name}}의 100단어 제품 설명을 작성해줘.
독자: {{audience}}
어조: {{tone}}
완성된 설명만 반환해줘.
```

실행:

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

## 중단 후 재개

결과 JSONL은 뒤에만 추가되는 체크포인트입니다. 같은 프롬프트 지문으로
성공한 ID는 다음 실행에서 건너뜁니다.

```bash
codex-text --input jobs.jsonl
# 40개 처리 후 중단

codex-text --input jobs.jsonl
# 41번째 작업부터 재개
```

`--no-resume`을 사용하면 성공한 항목도 다시 실행합니다. 기존 ID의 프롬프트,
모델, 프로필, 스키마 경로가 바뀌면 자동으로 다시 생성합니다. ID는 실행 간
고유하고 안정적으로 유지해야 합니다. 프롬프트 원문은 체크포인트에 저장하지
않습니다.

## 주요 옵션

```text
--model <model>           Codex 모델 지정
--profile <name>          Codex 설정 프로필
--schema <file>           구조화 출력용 JSON Schema
--concurrency <n>         병렬 Codex 프로세스 수 (기본값: 2)
--retries <n>             실패 후 재시도 횟수 (기본값: 2)
--batch-size <n>          배치당 작업 수 (기본값: 20)
--batch-delay <seconds>   배치 사이 대기 시간 (기본값: 5)
--min-free-memory <MiB>   실행을 멈출 최소 가용 메모리 (기본값: 1024)
--memory-per-worker <MiB> 활성 작업당 확보할 메모리 (기본값: 512)
--memory-poll <seconds>   메모리 재확인 주기 (기본값: 15)
--timeout <seconds>       작업별 제한 시간 (기본값: 300)
--no-resume               성공한 ID도 다시 실행
--extension <ext>         결과 파일 확장자 (기본값: txt)
--quiet                   작업별 진행 상황 숨김
```

전체 옵션은 `codex-text --help`에서 확인할 수 있습니다.

## 비용, 메모리, 사용 한도

`codex-text`는 `OPENAI_API_KEY`를 설정하거나 읽지 않습니다. 인증과 사용량은
`codex login status`에 표시되는 계정을 따릅니다. ChatGPT 플랜 한도는 그대로
적용되므로 처음에는 기본값인 워커 2개로 실행하는 편이 안전합니다.

Codex가 5시간 또는 주간 한도 소진을 알리면 해당 항목을 `deferred`로 기록하고
새 작업 예약을 중단한 뒤 종료 코드 `2`로 끝납니다. 한도가 초기화된 후 같은
명령을 실행하면 성공한 항목은 건너뛰고 보류되거나 시작하지 못한 항목부터
자동으로 계속합니다.

각 Codex 프로세스를 시작하기 전에 운영체제의 가용 메모리를 확인합니다.
macOS에서는 free, inactive, speculative, purgeable 페이지를 포함하고 Linux에서는
`MemAvailable`을 사용합니다. 설정한 최소 메모리와 활성 워커 예약분 아래에서는
기다립니다. 이 보호 기능은 `--min-free-memory 0 --memory-per-worker 0`으로 끌 수
있습니다.

## 보안

- 프롬프트는 명령줄 인수가 아닌 stdin으로 `codex exec`에 전달합니다.
- 각 작업은 새 임시 폴더의 `--sandbox read-only` 환경에서 실행됩니다.
- `--ephemeral` 세션을 사용해 Codex 세션 기록을 채우지 않습니다.
- `~/.codex/auth.json`을 직접 읽지 않습니다.
- 생성 결과가 민감하다면 출력 파일과 체크포인트를 별도로 보호해야 합니다.

## 라이브러리 API

```javascript
import { checkCodex, generateText, loadJobs, runBulk } from 'codex-cli-text-generator';

await checkCodex();
const jobs = await loadJobs('./jobs.jsonl');
const summary = await runBulk({ jobs, concurrency: 2 });
console.log(summary);
```

## 라이선스

MIT
