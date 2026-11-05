import { config } from '../config.js';
import { openrouter } from '../openrouter.js';
import { teamRoster } from '../members.js';
import { SearchIndex, allDocs } from './store.js';
import { readPage, wikiDocs } from './wiki.js';

const MAX_TURNS = 8;
const READ_LIMIT = 12000;

const SYSTEM_PROMPT = `너는 모아맵 팀의 세컨드 브레인 "Hippo"다. 팀 위키, 노션 문서, GitHub 이슈·PR(Moa-Map 조직), 회의 대본을 도구로 찾아 읽고 질문에 답한다.

위키 먼저: 위키는 원본을 주제별로 정리하고 결정 이력·충돌을 모아 둔 요약본이다. 아래 위키 목차에서 관련 페이지를 골라 read_wiki로 먼저 읽는다. 위키에 답이 있으면 위키 문장 옆의 원본 링크를 그 원본 이름 그대로([android#155](url)처럼) 근거로 붙인다. 위키 페이지 자체에는 URL이 없으니 "위키: …"에 링크를 달지 않는다. 위키에 없거나, 위키의 원본 기준일 이후 바뀌었을 수 있는 현황 질문(열림/닫힘, 머지 여부, 최근 일)이면 원본 도구로 확인한다. 위키와 원본이 다르면 원본을 따른다.

답변 규칙:
- 도구로 찾은 자료에 근거해서만 답한다. 자료에서 못 찾으면 모른다고 말하고, 어디를 찾아봤는지 짧게 알려 준다.
- 한국어 존댓말(~요/~습니다)로, 디스코드 메시지에 맞게 짧게 답한다. 핵심 먼저, 필요하면 개조식.
- 개수를 말할 때는 직접 세지 말고, 목록 도구가 준 total을 쓴다. total이 shown보다 크면 일부만 받은 것이니 전체 개수는 total로 말한다.
- 근거가 된 자료는 본문에 [제목](url) 형태 링크로 붙인다. 도구 결과의 url을 그대로 쓰고, url이 없는 자료(예: 회의 대본)는 링크 없이 제목만 쓴다. 링크를 추측해서 만들지 않는다.
- 날짜가 다른 자료끼리 내용이 다르면 최신 자료를 따르고, 바뀐 이력이 중요하면 함께 알려 준다.
- GitHub 이슈는 열림/닫힘, PR은 열림/머지됨/머지 안 하고 닫힘 상태를 함께 말한다. "끝났어?", "반영됐어?" 질문은 이슈가 닫혔는지만 보지 말고 연결된 PR이 머지됐는지로 판단한다.
- 비밀번호, API 키, 토큰, 개인 연락처 같은 민감 정보는 자료에 있더라도 알려 주지 않는다.

찾는 요령: search_docs는 키워드 검색이라 질문을 핵심 단어로 바꿔 여러 번 검색해 본다.
"정했어?", "결정됐어?" 같은 결정·합의 질문은 회의록(노션의 "N차 회의" 문서, 그 안의 "Hippo 회의록" 결정 사항)과 회의 대본을 먼저 확인한다. 회의 결정이 이슈·명세보다 최신이면 회의 결정을 답으로 하고, 예전 자료와 달라졌다면 그 차이도 알려 준다. 검색 결과의 일부만으로 부족하면 read_doc으로 문서 전체를 읽는다(이슈를 읽으면 연결된 PR도 함께 나온다). 이슈 목록·현황 질문에는 list_issues, PR·머지 현황 질문에는 list_prs를 쓴다.`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_wiki',
      description: '위키 페이지 하나를 읽는다. page는 위키 목차에 있는 경로(예: features/auth.md).',
      parameters: { type: 'object', properties: { page: { type: 'string' } }, required: ['page'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_docs',
      description: '위키·노션 문서·GitHub 이슈·회의 대본에서 키워드로 검색해 관련 문서와 일부 내용을 돌려준다.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '검색어(핵심 단어 위주)' },
          source: { type: 'string', enum: ['wiki', 'notion', 'github', 'meeting'], description: '출처를 하나로 좁힐 때만' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_doc',
      description: '문서 id로 문서 전체 내용을 읽는다.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_issues',
      description: 'GitHub 이슈 목록을 저장소·상태로 걸러서 최신순으로 돌려준다.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: '예: moamap-backend, moamap-iOS, moamap-android, moamap-web, design-system. 생략하면 전체' },
          state: { type: 'string', enum: ['open', 'closed', 'all'] },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_prs',
      description: 'GitHub PR 목록을 저장소·상태·기간으로 걸러서 최신순으로 돌려준다. 머지 날짜와 연결된 이슈 번호를 포함한다.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: '저장소 이름. 생략하면 전체' },
          state: { type: 'string', enum: ['open', 'merged', 'closed', 'all'], description: 'closed는 머지 안 하고 닫힌 PR' },
          since: { type: 'string', description: 'YYYY-MM-DD. 이 날짜 이후 수정(머지된 PR은 머지)된 것만' },
          limit: { type: 'number' },
        },
      },
    },
  },
];

function listResult(items, limit, toItem) {
  return { total: items.length, shown: Math.min(limit, items.length), items: items.slice(0, limit).map(toItem) };
}

const isPr = (d) => d.source === 'github' && d.meta.kind === 'pr';
const isIssue = (d) => d.source === 'github' && d.meta.kind !== 'pr';

/** 질문 → { answer, sources }. 모델이 도구를 쓰며 자료를 찾고, 읽은 문서를 출처로 돌려준다. */
export async function askBrain(question) {
  const docs = allDocs();
  const index = new SearchIndex([...docs, ...wikiDocs()]);
  const read = new Map();

  const handlers = {
    read_wiki: ({ page }) => {
      const doc = index.get(`wiki/${page}`);
      if (!doc) return { error: '없는 위키 페이지. 목차의 경로를 그대로 쓰세요.' };
      read.set(doc.id, doc);
      return { page, text: doc.text.slice(0, READ_LIMIT) };
    },
    search_docs: ({ query, source }) =>
      index.search(query, { source }).map(({ doc, snippet }) => ({
        id: doc.id,
        source: doc.source,
        title: doc.title,
        // "조정운"처럼 제목만으로는 어느 문서인지 모르는 노션 하위 페이지가 많아 위치(상위 페이지)를 함께 준다.
        where: doc.meta?.path?.slice(-2).join(' > ') || undefined,
        url: doc.url,
        updated: doc.updated?.slice(0, 10),
        snippet,
      })),
    read_doc: ({ id }) => {
      const doc = index.get(id);
      if (!doc) return { error: '없는 문서 id' };
      read.set(doc.id, doc);
      const result = { title: doc.title, url: doc.url, updated: doc.updated?.slice(0, 10), text: doc.text.slice(0, READ_LIMIT) };
      // 이슈를 읽으면 그 이슈를 닫거나 언급한 PR을 함께 알려 준다(머지 여부 판단용).
      if (isIssue(doc)) {
        const number = Number(doc.id.split('#')[1]);
        result.linkedPrs = docs
          .filter((d) => isPr(d) && d.meta.repo === doc.meta.repo && d.meta.linkedIssues.includes(number))
          .map((d) => ({ id: d.id, title: d.title, state: d.meta.state, mergedAt: d.meta.mergedAt?.slice(0, 10), url: d.url }));
      }
      return result;
    },
    // 목록은 잘라서 주되 전체 개수(total)를 함께 준다. 모델이 잘린 목록을 전체로 착각해 개수를 틀리지 않게.
    list_issues: ({ repo, state = 'open', limit = 50 }) =>
      listResult(
        docs
          .filter(isIssue)
          .filter((d) => !repo || d.meta.repo.toLowerCase() === repo.toLowerCase())
          .filter((d) => state === 'all' || d.meta.state === state)
          .sort((a, b) => b.updated.localeCompare(a.updated)),
        limit,
        (d) => ({ id: d.id, title: d.title, state: d.meta.state, url: d.url, updated: d.updated.slice(0, 10) }),
      ),
    list_prs: ({ repo, state = 'open', since, limit = 50 }) =>
      listResult(
        docs
          .filter(isPr)
          .filter((d) => !repo || d.meta.repo.toLowerCase() === repo.toLowerCase())
          .filter((d) => state === 'all' || d.meta.state === state)
          .filter((d) => !since || (d.meta.mergedAt ?? d.updated) >= since)
          .sort((a, b) => (b.meta.mergedAt ?? b.updated).localeCompare(a.meta.mergedAt ?? a.updated)),
        limit,
        (d) => ({
          id: d.id,
          title: d.title,
          state: d.meta.state,
          draft: d.meta.draft || undefined,
          mergedAt: d.meta.mergedAt?.slice(0, 10),
          linkedIssues: d.meta.linkedIssues,
          url: d.url,
          updated: d.updated.slice(0, 10),
        }),
      ),
  };

  const today = new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'full' });
  const messages = [
    // 위키 목차는 자주 바뀌지 않아 지시문과 함께 캐시된다. 오늘 날짜는 캐시를 깨지 않도록 맨 뒤에 둔다.
    {
      role: 'system',
      content: `${SYSTEM_PROMPT}\n\n팀 구성:\n${teamRoster()}\n\n위키 목차:\n${readPage('index.md') ?? '(위키 없음)'}\n\n오늘: ${today}`,
    },
    { role: 'user', content: question },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const completion = await openrouter.chat.completions.create({
      model: config.brain.model,
      models: [config.brain.model, ...config.openrouter.summaryModels.filter((m) => m !== config.brain.model)],
      messages,
      tools: TOOLS,
      // 자동 프롬프트 캐싱: 차례마다 앞부분(지시문·도구·이미 읽은 문서)을 다시 보내므로, 캐시로 읽어 입력 비용을 줄인다.
      cache_control: { type: 'ephemeral' },
      ...(turn === MAX_TURNS - 1 && { tool_choice: 'none' }), // 마지막 차례에는 반드시 답하게 한다
    });
    const message = completion.choices[0].message;
    messages.push(message);
    if (!message.tool_calls?.length) {
      // 위키 페이지에는 URL이 없는데 모델이 엉뚱한 링크를 붙일 때가 있어, "[위키: …](…)"는 글자만 남긴다.
      const answer = message.content?.trim().replace(/\[(위키[^\]]*)\]\([^)]*\)/g, '$1');
      return { answer: answer || '답을 만들지 못했어요.', sources: [...read.values()] };
    }
    for (const call of message.tool_calls) {
      let result;
      try {
        result = handlers[call.function.name](JSON.parse(call.function.arguments || '{}'));
      } catch (err) {
        result = { error: err.message };
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return { answer: '자료를 찾다가 시간이 너무 오래 걸렸어요. 질문을 조금 더 구체적으로 해 주세요.', sources: [...read.values()] };
}

// 직접 실행: npm run ask -- "질문"
if (import.meta.url === `file://${process.argv[1]}`) {
  const { answer, sources } = await askBrain(process.argv.slice(2).join(' '));
  console.log(answer);
  console.log('\n읽은 문서:', sources.map((s) => s.title).join(' | ') || '없음');
}
