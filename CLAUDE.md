# CLAUDE.md

Hippo(🦛, 패키지명 `moamap-secretary`): 모아맵 팀 디스코드 봇. 음성 회의를 녹음해 노션 회의록을 만들고(`/회의시작`·`/회의종료`), 노션·GitHub·회의 대본으로 질문에 답하고(`/물어보기`), `wiki/`를 자동으로 관리한다. 전체 구조와 흐름은 README.md의 "아키텍처"와 "코드 구조"를 본다.

## 명령

```bash
npm start                 # 봇 실행. .bot.pid로 중복 실행을 막는다
npm test                  # node:test 단위 테스트
npm run deploy-commands   # 슬래시 커맨드를 바꿨을 때만 다시 등록
npm run process -- recordings/<폴더>   # 녹음 하나로 회의록을 수동 생성 (실패한 단계부터 이어서)
npm run brain-sync | ask -- "질문" | wiki-update | wiki-lint
```

- 실행 중인 봇은 코드를 바꿔도 반영되지 않는다. 코드를 고친 뒤에는 봇을 다시 켜야 한다.
- 빌드 단계와 TypeScript가 없다. ESM(`"type": "module"`)이며, `import`에는 `.js` 확장자까지 쓴다.

## 데이터와 민감 정보

- `.env`, `members.json`(디스코드 ID → 실명·노션 ID), `recordings/`(음성), `/brain/`(노션·GitHub 사본), `wiki/`(팀 내부 문서)는 git에 올리지 않는다. GitHub 저장소가 **공개**다.
- `.gitignore`의 `/brain/`은 앞의 `/`가 있어야 한다. 빠지면 `src/brain/` 소스까지 무시된다.
- 녹음 폴더(`recordings/<ISO 시각>/`)는 단계별 캐시 겸 기록이다: `meta.json` → `*.wav` → `stt-partial.json`/`transcript.md` → `minutes.json` → `notion.json`. 캐시 파일이 있으면 그 단계를 건너뛰므로, 잘못된 결과는 캐시에 쓰기 전에 걸러야 한다(재시도해도 같은 결과를 읽는다).
- `meta.json`에 `endedAt`이 없으면 녹음 중이거나 중단된 회의다. 봇이 시작할 때 `closeInterruptedMeetings()`가 이것을 정리한다.

## 코드 관례

- 주석, 로그, 사용자에게 보이는 메시지는 모두 한국어로 쓴다. 주석에는 "무엇"보다 "왜"를 쓴다.
- 디스코드에 보내는 실패 안내는 개발자가 아닌 팀원이 읽는다. 어느 단계에서, 왜 멈췄고, 무엇을 하면 되는지를 쓴다(`failureMessage`, `failureReason` 참고).
- 외부 API는 SDK 대신 얇은 래퍼를 쓴다: OpenRouter는 OpenAI SDK에 baseURL만 바꿔서(`src/openrouter.js`), 노션은 `fetch` 래퍼(`src/notion.js`, Notion-Version `2026-03-11`, 페이지 생성은 `markdown` 본문)를 쓴다.
- `config.js`의 필수 값은 함수(`config.notion.token()`)라 호출할 때 검사한다. 선택 값은 모듈을 불러올 때 `process.env`에서 읽는다.
- 이벤트를 내보내는 객체(디스코드 음성 연결, 스트림)에는 `error` 리스너를 꼭 단다. 없으면 오류 하나로 프로세스가 꺼진다.

## 테스트

- `test/` 아래에 `src/`와 같은 경로로 `*.test.js`를 둔다(예: `src/pipeline/summarize.js` → `test/pipeline/summarize.test.js`).
- 외부 의존성(디스코드 음성, OpenRouter)은 `mock.module()`로 바꾼다. 실험 기능이라 `npm test`에 `--experimental-test-module-mocks` 플래그가 들어 있다.
- 순서가 중요하다: `process.env` 설정 → `mock.module()` → `await import('../src/...')`. `config.js`가 불러올 때 env를 읽고, 정적 `import`는 맨 위로 끌어올려지기 때문이다.
- `RECORDINGS_DIR`와 `MEMBERS_FILE`은 임시 경로로 돌려서 실제 데이터를 건드리지 않는다.
- 버그를 고칠 때는 먼저 재현 테스트를 쓰고, 실패하는 것을 확인한 다음 고친다.

## 알려진 제약

- WAV를 48kHz 모노로 저장해 1분에 약 5.5MB다. Whisper 업로드 한도가 25MB라서, 한 사람이 쉬지 않고 약 4분 반 넘게 말하면 그 발화의 STT가 실패한다.
- 봇은 개인 Mac에서 `npm start`로 돈다. 프로세스 관리자도, 잠자기 방지도 아직 없다.
- STT 동시 요청은 2개(`CONCURRENCY`)다. 늘리면 OpenRouter가 429를 낸다.
