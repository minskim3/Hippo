import { config } from '../config.js';
import { openrouter } from '../openrouter.js';
import { allDocs } from './store.js';
import { listPages, readPage, loadWikiState, saveWikiState } from './wiki.js';

const REPORT_LIMIT = 1800; // 보고 길이 목표(디스코드 메시지 한 개가 2000자)

const SYSTEM_PROMPT = `너는 모아맵 팀 위키를 점검한다. 위키 전체와 자동 점검 결과를 보고, 팀이 손봐야 할 것을 디스코드 메시지로 짧게 보고한다.

찾을 것:
- 페이지끼리 서로 다른 내용(예: 한 페이지는 완료, 다른 페이지는 진행 중)
- 오래돼 보이는 정보: 지난 날짜인데 "예정"·"진행 중"으로 남은 것, 자동 점검이 찾은 닫힌 이슈·머지된 PR이 🚧로 남은 것
- conflicts.md의 "확인 필요" 중 팀이 결정해야 할 것(가장 중요한 것 위주)
- 출처 링크가 없는 문장이 많은 페이지

보고 형식:
- 한국어 존댓말, 개조식, 전체 ${REPORT_LIMIT}자 이내.
- "🧹 이번 주 위키 점검" 제목 한 줄 뒤에 "모순", "오래된 정보", "팀 결정이 필요한 것" 순서로, 해당 없는 묶음은 빼고 쓴다.
- 항목마다 어느 페이지인지(경로) 적는다. 중요한 것부터 최대 10개.
- 손볼 게 없으면 "이번 주는 손볼 곳이 없어요."라고만 쓴다.`;

// 🚧(진행 중)로 적혀 있는데 원본에서는 이미 닫혔거나 머지된 GitHub 항목을 찾는다.
function staleItems(pages) {
  const byId = new Map(allDocs().filter((d) => d.source === 'github').map((d) => [d.id, d]));
  const found = [];
  for (const page of pages) {
    for (const line of readPage(page).split('\n')) {
      if (!line.includes('🚧')) continue;
      for (const [, repo, number] of line.matchAll(/github\.com\/Moa-Map\/([\w-]+)\/(?:issues|pull)\/(\d+)/g)) {
        const doc = byId.get(`${repo}#${number}`);
        if (doc && doc.meta.state !== 'open') found.push(`${page}: ${repo}#${number}는 원본에서 ${doc.meta.state}`);
      }
    }
  }
  return [...new Set(found)];
}

function unindexedPages(pages) {
  const index = readPage('index.md') ?? '';
  const special = new Set(['WIKI.md', 'index.md', 'log.md']);
  return pages.filter((p) => !special.has(p) && !index.includes(`(${p})`));
}

/** 위키를 점검해 디스코드에 올릴 보고문을 만든다. 위키는 고치지 않는다. */
export async function lintWiki(log = console.log) {
  const pages = listPages();
  const checks = [
    ...staleItems(pages).map((s) => `닫혔는데 🚧: ${s}`),
    ...unindexedPages(pages).map((p) => `목차에 없는 페이지: ${p}`),
  ];
  const wiki = pages.map((p) => `<page path="${p}">\n${readPage(p)}\n</page>`).join('\n\n');
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

  const completion = await openrouter.chat.completions.create({
    model: config.openrouter.summaryModels[0],
    models: config.openrouter.summaryModels,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `오늘: ${today}\n\n자동 점검 결과:\n${checks.join('\n') || '없음'}\n\n위키 전체:\n${wiki}` },
    ],
  });
  const report = completion.choices[0].message.content?.trim() ?? '';
  const state = loadWikiState();
  state.lastLint = new Date().toISOString();
  saveWikiState(state);
  log(`[wiki] 점검 완료 (자동 점검 ${checks.length}건, $${(completion.usage?.cost ?? 0).toFixed(4)})`);
  return report;
}

// 직접 실행: npm run wiki-lint (디스코드에는 올리지 않고 출력만)
if (import.meta.url === `file://${process.argv[1]}`) console.log(await lintWiki());
