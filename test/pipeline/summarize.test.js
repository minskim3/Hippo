import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 팀원 목록은 테스트에 필요 없으니 없는 파일을 가리킨다.
process.env.MEMBERS_FILE = path.join(os.tmpdir(), 'hippo-test-no-members.json');

// OpenRouter를 가짜로 바꾼다. 테스트마다 modelOutput에 모델이 돌려줄 내용을 넣는다.
let modelOutput;
let requestOptions; // create()에 넘긴 두 번째 인자(재시도 횟수 등)
mock.module(new URL('../../src/openrouter.js', import.meta.url).href, {
  namedExports: {
    openrouter: {
      chat: {
        completions: {
          create: async (_body, options) => {
            requestOptions = options;
            return { model: 'fake-model', choices: [{ message: { content: modelOutput } }], usage: {} };
          },
        },
      },
    },
  },
});
const { summarizeMeeting } = await import('../../src/pipeline/summarize.js');

function meetingDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-test-'));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ startedAt: '2026-11-05T13:01:58.771Z', speakers: {} }));
  return dir;
}

const validMinutes = { summary: '요약', decisions: [], actionItems: [], pending: [], parts: [], agenda: [] };

test('모델이 필드가 빠진 회의록을 주면 실패하고, 캐시에 남기지 않는다', async () => {
  const dir = meetingDir();
  const { agenda, ...withoutAgenda } = validMinutes;
  modelOutput = JSON.stringify(withoutAgenda);

  await assert.rejects(summarizeMeeting(dir, '[00:00:01] 준규: 안녕하세요'), /형식/);
  // 남아 있으면 "다시 시도"를 눌러도 이 잘못된 결과를 계속 읽는다.
  assert.equal(fs.existsSync(path.join(dir, 'minutes.json')), false);
});

test('올바른 회의록은 minutes.json에 저장한다', async () => {
  const dir = meetingDir();
  modelOutput = JSON.stringify(validMinutes);

  assert.deepEqual(await summarizeMeeting(dir, '[00:00:01] 준규: 안녕하세요'), validMinutes);
  assert.equal(fs.existsSync(path.join(dir, 'minutes.json')), true);
});

test('요약 요청은 일시적인 오류에 대비해 5번까지 자동으로 다시 보낸다', async () => {
  modelOutput = JSON.stringify(validMinutes);
  await summarizeMeeting(meetingDir(), '[00:00:01] 준규: 안녕하세요');
  assert.equal(requestOptions?.maxRetries, 5);
});
