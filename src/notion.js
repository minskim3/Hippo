import { config } from './config.js';

const NOTION_VERSION = '2026-03-11';

export async function notionFetch(pathname, { method = 'GET', body } = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.notion.com/v1${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.notion.token()}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: body && JSON.stringify(body),
    });
    // 노션은 초당 약 3회 제한이 있다. 동기화처럼 연달아 부를 때 429가 나면 기다렸다 다시 시도.
    // 5xx(노션 서버 장애)도 대부분 잠깐이라 같은 방식으로 다시 보낸다. retry-after가 없으면 1·2·3·4초씩 늘려 기다린다.
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await new Promise((r) => setTimeout(r, Number(res.headers.get('retry-after') ?? attempt) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Notion API ${res.status}: ${await res.text()}`);
    return res.json();
  }
}

// 속성 값 헬퍼. rich_text 한 덩어리는 2000자 제한이 있다.
export const text = (content) => [{ type: 'text', text: { content: String(content).slice(0, 2000) } }];
