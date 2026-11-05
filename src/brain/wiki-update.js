import { config } from '../config.js';
import { openrouter } from '../openrouter.js';
import { allDocs } from './store.js';
import { listPages, readPage, writePage, loadWikiState, saveWikiState } from './wiki.js';

const MAX_TURNS = 20;
const DOCS_PER_BATCH = 20;
const DOC_LIMIT = 5000; // 바뀐 원본 하나당 모델에 보낼 최대 글자 수

const SYSTEM_PROMPT = `너는 모아맵 팀 위키의 관리자다. 팀 원본 자료(노션, GitHub 이슈·PR, 회의 대본) 중 새로 생기거나 바뀐 문서를 받아, 위키의 관련 페이지에 반영한다.

할 일:
1. 바뀐 원본마다 위키 목차에서 영향을 받는 페이지를 고르고 read_page로 읽는다.
2. 고칠 내용이 있으면 페이지 전체를 고친 뒤 write_page로 저장한다. 바뀐 부분만 고치고 나머지 문장·출처 링크는 그대로 둔다. "마지막 갱신" 줄의 날짜도 오늘로 바꾼다.
3. 새 결정이면 decisions.md 표 끝에 행을 추가하고, 자료끼리 다르면 conflicts.md에 항목을 추가한다. 이미 있는 충돌이 해결됐으면 "해결됨"으로 옮긴다.
4. 어느 페이지에도 맞지 않는 새 주제면 새 페이지를 만들고 index.md에 한 줄 추가한다.
5. 마지막에 append_log로 무엇을 반영했는지 한 줄 남기고, 한두 문장으로 요약해 답한다.

지킬 것:
- 위키 규칙(WIKI.md)을 따른다. 모든 사실에 원본 링크를 붙이고, 링크는 받은 원본의 url만 쓴다.
- 오타 수정, 템플릿만 바뀐 것, 이미 위키에 있는 내용처럼 반영할 게 없는 변경은 건너뛴다.
- 이슈가 닫히거나 PR이 머지되면 상태 표시(🚧→✅ 등)를 바꾼다.
- 비밀번호, API 키, 토큰, 개인 연락처, 계정 정보, 회계 내역은 원본에 있어도 쓰지 않는다.`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_page',
      description: '위키 페이지 전체를 읽는다. page는 목차의 경로(예: features/auth.md).',
      parameters: { type: 'object', properties: { page: { type: 'string' } }, required: ['page'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_page',
      description: '위키 페이지 전체를 이 내용으로 저장한다(부분이 아니라 페이지 전체를 보낸다). 없는 페이지면 새로 만든다.',
      parameters: {
        type: 'object',
        properties: { page: { type: 'string' }, content: { type: 'string' } },
        required: ['page', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_log',
      description: 'log.md에 변경 기록 한 줄을 추가한다(날짜는 자동으로 붙는다).',
      parameters: { type: 'object', properties: { line: { type: 'string' } }, required: ['line'] },
    },
  },
];

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

function docForPrompt(doc) {
  const head = [`[${doc.source}] ${doc.title}`, doc.url && `url: ${doc.url}`, `수정: ${doc.updated?.slice(0, 10)}`];
  if (doc.meta?.state) head.push(`상태: ${doc.meta.state}${doc.meta.mergedAt ? ` (머지 ${doc.meta.mergedAt.slice(0, 10)})` : ''}`);
  return `<doc>\n${head.filter(Boolean).join('\n')}\n\n${doc.text.slice(0, DOC_LIMIT)}\n</doc>`;
}

/** 바뀐 원본 몇 개를 위키에 반영한다. 고친 페이지 목록과 모델의 요약을 돌려준다. */
async function updateBatch(docs, log) {
  const written = new Set();
  let cost = 0;
  const handlers = {
    read_page: ({ page }) => readPage(page) ?? { error: '없는 페이지' },
    write_page: ({ page, content }) => {
      if (page === 'WIKI.md') return { error: '규칙 파일은 고칠 수 없습니다.' };
      const old = readPage(page);
      // 모델이 페이지 일부만 보내 나머지를 날리는 사고를 막는다.
      if (old && content.length < old.length * 0.6) {
        return { error: `기존 페이지(${old.length}자)보다 너무 짧습니다(${content.length}자). 고친 페이지 전체를 보내세요.` };
      }
      writePage(page, content);
      written.add(page);
      return { ok: true };
    },
    append_log: ({ line }) => {
      writePage('log.md', `${(readPage('log.md') ?? '# 위키 변경 기록\n').trimEnd()}\n- ${today()} — ${line.trim()}`);
      return { ok: true };
    },
  };

  const messages = [
    {
      role: 'system',
      content: `${SYSTEM_PROMPT}\n\n<WIKI.md>\n${readPage('WIKI.md')}\n</WIKI.md>\n\n<index.md>\n${readPage('index.md')}\n</index.md>\n\n전체 페이지: ${listPages().join(', ')}`,
    },
    { role: 'user', content: `오늘: ${today()}\n바뀐 원본 ${docs.length}개:\n\n${docs.map(docForPrompt).join('\n\n')}` },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const completion = await openrouter.chat.completions.create({
      model: config.openrouter.summaryModels[0],
      models: config.openrouter.summaryModels,
      messages,
      tools: TOOLS,
      cache_control: { type: 'ephemeral' },
      ...(turn === MAX_TURNS - 1 && { tool_choice: 'none' }),
    });
    cost += completion.usage?.cost ?? 0; // OpenRouter가 알려 주는 실제 비용(달러)
    const message = completion.choices[0].message;
    messages.push(message);
    if (!message.tool_calls?.length) return { pages: [...written], summary: message.content?.trim() ?? '', cost };
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
  log('[wiki] 반영 작업이 차례 제한에 걸렸습니다.');
  return { pages: [...written], summary: '', cost };
}

/** 대기 목록의 원본을 위키에 반영한다. 반영한 원본은 대기 목록에서 지운다. */
export async function updateWiki(log = console.log) {
  const state = loadWikiState();
  const byId = new Map(allDocs().map((d) => [d.id, d]));
  const pending = state.pending.filter((id) => byId.has(id)); // 그사이 지워진 문서는 버린다
  const pages = new Set();
  const summaries = [];
  let cost = 0;

  for (let i = 0; i < pending.length; i += DOCS_PER_BATCH) {
    const ids = pending.slice(i, i + DOCS_PER_BATCH);
    const result = await updateBatch(ids.map((id) => byId.get(id)), log);
    result.pages.forEach((p) => pages.add(p));
    if (result.summary) summaries.push(result.summary);
    cost += result.cost;
    // 한 묶음이 끝날 때마다 저장해서, 중간에 실패해도 끝난 묶음은 다시 하지 않는다.
    state.pending = state.pending.filter((id) => !ids.includes(id));
    saveWikiState(state);
  }
  state.pending = [];
  state.lastUpdate = new Date().toISOString();
  saveWikiState(state);
  log(`[wiki] 원본 ${pending.length}개 반영, 고친 페이지 ${pages.size}개: ${[...pages].join(', ') || '없음'} ($${cost.toFixed(4)})`);
  return { docs: pending.length, pages: [...pages], summary: summaries.join('\n') };
}

// 직접 실행: npm run wiki-update
if (import.meta.url === `file://${process.argv[1]}`) {
  const { summary } = await updateWiki();
  if (summary) console.log(summary);
}
