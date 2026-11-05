import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { redactSecrets } from './store.js';

/**
 * 위키(wiki/ 폴더의 마크다운 페이지). 규칙은 wiki/WIKI.md, 목차는 wiki/index.md.
 * 페이지 이름은 wiki 폴더 기준 상대 경로(예: "features/auth.md").
 */
const root = () => path.resolve(config.brain.wikiDir);

function resolvePage(page) {
  const full = path.resolve(root(), page);
  if (!full.startsWith(root() + path.sep) || !full.endsWith('.md')) throw new Error(`위키 페이지 이름이 올바르지 않습니다: ${page}`);
  return full;
}

export function listPages() {
  if (!fs.existsSync(root())) return [];
  return fs
    .readdirSync(root(), { recursive: true })
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.split(path.sep).join('/'))
    .sort();
}

export function readPage(page) {
  const full = resolvePage(page);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}

export function writePage(page, content) {
  const full = resolvePage(page);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, redactSecrets(content).trimEnd() + '\n');
}

/** 검색 색인에 넣을 문서 형태. 위키 페이지는 원본 URL이 없어 출처 표시는 제목만 한다. */
export function wikiDocs() {
  return listPages().map((page) => {
    const text = readPage(page);
    const title = text.match(/^# (.+)$/m)?.[1] ?? page;
    return {
      id: `wiki/${page}`,
      source: 'wiki',
      title: `위키: ${title}`,
      updated: fs.statSync(resolvePage(page)).mtime.toISOString(),
      text,
      meta: { page },
    };
  });
}

// 위키 갱신·점검 작업의 상태: 아직 위키에 반영하지 않은 원본 문서 id, 마지막 실행 시각.
const stateFile = () => path.join(config.brain.dir, 'wiki-state.json');

export function loadWikiState() {
  if (!fs.existsSync(stateFile())) return { pending: [], lastUpdate: null, lastLint: null };
  return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
}

export function saveWikiState(state) {
  fs.mkdirSync(config.brain.dir, { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
}
