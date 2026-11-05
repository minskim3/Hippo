import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.NOTION_TOKEN ??= 'test-token';
const { notionFetch } = await import('../src/notion.js');

// fetch를 가짜로 바꿔, 정해 둔 상태 코드를 차례로 돌려준다. retry-after: 0이라 테스트가 기다리지 않는다.
function fakeFetch(statuses) {
  return mock.method(globalThis, 'fetch', async () => {
    const status = statuses.shift();
    return new Response(JSON.stringify({ status }), { status, headers: { 'retry-after': '0' } });
  });
}

test('노션 서버 장애(5xx)는 자동으로 다시 보낸다', async (t) => {
  const fetch = fakeFetch([503, 502, 200]);
  t.after(() => fetch.mock.restore());

  assert.deepEqual(await notionFetch('/pages/abc'), { status: 200 });
  assert.equal(fetch.mock.callCount(), 3);
});

test('권한 오류(4xx)는 다시 보내지 않는다', async (t) => {
  const fetch = fakeFetch([404]);
  t.after(() => fetch.mock.restore());

  await assert.rejects(notionFetch('/pages/abc'), /Notion API 404/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('계속 장애면 몇 번 시도한 뒤 포기한다', async (t) => {
  const fetch = fakeFetch([500, 500, 500, 500, 500, 500]);
  t.after(() => fetch.mock.restore());

  await assert.rejects(notionFetch('/pages/abc'), /Notion API 500/);
  assert.equal(fetch.mock.callCount(), 5);
});
