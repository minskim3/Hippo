import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureReason, canRetry } from '../src/failure.js';

// OpenAI SDK 오류처럼 status가 붙은 오류를 만든다.
const apiError = (status, message = 'error') => Object.assign(new Error(message), { status });

const cases = [
  // [상황, 오류, 디스코드 안내에 들어가야 할 말]
  ['OpenRouter 잔액 부족', apiError(402), /잔액이 부족/],
  ['OpenRouter 요청 몰림', apiError(429), /잠시 막혔/],
  ['OpenRouter 키 오류', apiError(401), /API 키/],
  ['OpenRouter 서버 장애', apiError(503), /일시적인 문제/],
  ['녹음 파일이 너무 큼', apiError(413), /너무 길어서/],
  ['모델 이름이 잘못됨', apiError(404), /모델을 찾지 못했/],
  ['OpenRouter가 요청 거절', apiError(400), /요청을 거절/],
  ['회의록 JSON 해석 실패', new Error('회의록 JSON을 해석하지 못했습니다 (모델: x)'), /형식.*다시 시도/],
  ['회의록 필드 누락', new Error('회의록 형식이 올바르지 않습니다 (모델: x)'), /형식.*다시 시도/],
  ['음성 채널 연결 시간 초과', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }), /음성 채널에 들어가지 못했/],
  ['노션 권한 없음', new Error('Notion API 404: not found'), /노션 연결 권한/],
  ['노션 장애', new Error('Notion API 502: bad gateway'), /노션 서버/],
  ['녹음된 말이 없음', new Error('녹음된 발화가 없습니다.'), /말소리가 없/],
];

for (const [name, err, expected] of cases) {
  test(`안내 문구: ${name}`, () => {
    assert.match(failureReason(err), expected);
  });
}

test('모르는 오류는 개발자에게 알리라고 한다', () => {
  assert.match(failureReason(new Error('뭔지 모를 오류')), /개발자/);
});

// 다시 시도 버튼은 눌러서 결과가 달라질 수 있을 때만 붙인다.
test('다시 시도해도 결과가 같은 오류에는 다시 시도를 권하지 않는다', () => {
  assert.equal(canRetry(apiError(413)), false);
  assert.equal(canRetry(new Error('녹음된 발화가 없습니다.')), false);
});

test('일시적인 오류나 설정을 고치면 되는 오류는 다시 시도할 수 있다', () => {
  for (const status of [402, 429, 503, 401, 404]) assert.equal(canRetry(apiError(status)), true, `status ${status}`);
  assert.equal(canRetry(new Error('회의록 형식이 올바르지 않습니다 (모델: x)')), true);
});
