import { syncNotion } from './sync-notion.js';
import { syncGithub } from './sync-github.js';
import { syncMeetings } from './sync-meetings.js';
import { allDocs } from './store.js';
import { loadWikiState, saveWikiState } from './wiki.js';

/**
 * 세 출처를 모두 동기화한다. 한 출처가 실패해도 나머지는 계속한다.
 * 새로 생기거나 바뀐 문서는 위키에 반영할 대기 목록(wiki-state.json)에 쌓는다.
 */
export async function syncBrain(log = console.log) {
  const before = new Map(allDocs().map((d) => [d.id, d.updated]));
  for (const [name, run] of [['노션', syncNotion], ['GitHub', syncGithub], ['회의 대본', syncMeetings]]) {
    try {
      await run(log);
    } catch (err) {
      log(`[brain] ${name} 동기화 실패: ${err.message}`);
    }
  }
  const changed = allDocs().filter((d) => before.get(d.id) !== d.updated).map((d) => d.id);
  if (changed.length) {
    const state = loadWikiState();
    state.pending = [...new Set([...state.pending, ...changed])];
    saveWikiState(state);
    log(`[brain] 위키 반영 대기 ${state.pending.length}개 (이번에 바뀜 ${changed.length})`);
  }
}

// 직접 실행: npm run brain-sync
if (import.meta.url === `file://${process.argv[1]}`) await syncBrain();
