import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * 세컨드 브레인 문서 저장소. 출처별로 brain/<source>.json 하나씩 저장한다.
 * 문서: { id, source: 'notion'|'github'|'meeting', title, url, updated, text, meta? }
 */
const file = (source) => path.join(config.brain.dir, `${source}.json`);

export function loadDocs(source) {
  if (!fs.existsSync(file(source))) return {};
  return JSON.parse(fs.readFileSync(file(source), 'utf8'));
}

// 동기화 중에 /물어보기가 읽어도 반쯤 쓴 파일을 보지 않도록, 임시 파일에 쓴 뒤 한 번에 바꿔치기한다.
export function saveDocs(source, docs) {
  fs.mkdirSync(config.brain.dir, { recursive: true });
  fs.writeFileSync(`${file(source)}.tmp`, JSON.stringify(docs));
  fs.renameSync(`${file(source)}.tmp`, file(source));
}

export function allDocs() {
  return ['notion', 'github', 'meeting'].flatMap((s) => Object.values(loadDocs(s)));
}

/**
 * 저장 전 안전망: 비밀번호·키·토큰처럼 보이는 줄과 인증서/키 블록을 지운다.
 * (민감한 페이지는 제목으로 먼저 걸러내지만, 일반 문서에 섞여 들어간 경우를 대비한다.)
 */
export function redactSecrets(text) {
  return text
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[민감 정보 제거됨]')
    .split('\n')
    .map((line) =>
      /(비밀번호|비번|password|passwd|\bpw\b|secret|api[_ -]?key|access[_ -]?key|token|private[_ -]?key)\s*["']?\s*[:=]/i.test(line) ||
      /\b(sk-[A-Za-z0-9]{20,}|ntn_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[bp]-[A-Za-z0-9-]{20,})\b/.test(line)
        ? '[민감 정보 제거됨]'
        : line,
    )
    .join('\n');
}

// ---- 검색: 문서를 조각으로 나눈 뒤 BM25로 점수를 매긴다. ----

const CHUNK_SIZE = 1200;

// 한국어는 띄어쓰기·조사가 달라도 맞도록 두 글자씩(바이그램)과 한 글자씩 함께 끊고,
// 영문·숫자는 단어 단위로 쓴다. 한 글자 토큰이 없으면 "칩은"·"칩을"이 "칩"과 안 맞는다.
function tokenize(text) {
  const tokens = [];
  for (const word of text.toLowerCase().match(/[가-힣]+|[a-z0-9_]+/g) ?? []) {
    if (/^[가-힣]+$/.test(word)) {
      for (const ch of word) tokens.push(ch);
      for (let i = 0; i < word.length - 1; i++) tokens.push(word.slice(i, i + 2));
    } else {
      tokens.push(word);
    }
  }
  return tokens;
}

function chunk(doc) {
  const parts = [];
  let current = '';
  for (const para of doc.text.split(/\n(?=#|\n)/)) {
    if (current && current.length + para.length > CHUNK_SIZE) {
      parts.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + para;
  }
  if (current.trim()) parts.push(current);
  return parts.map((text, i) => ({ doc, i, text, tokens: tokenize(`${doc.title}\n${text}`) }));
}

export class SearchIndex {
  constructor(docs) {
    this.docs = new Map(docs.map((d) => [d.id, d]));
    this.chunks = docs.flatMap(chunk);
    this.df = new Map();
    for (const c of this.chunks) for (const t of new Set(c.tokens)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgLen = this.chunks.reduce((s, c) => s + c.tokens.length, 0) / Math.max(1, this.chunks.length);
  }

  search(query, { source, limit = 10 } = {}) {
    const terms = [...new Set(tokenize(query))];
    const N = this.chunks.length;
    const scored = [];
    for (const c of this.chunks) {
      if (source && c.doc.source !== source) continue;
      const tf = new Map();
      for (const t of c.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      let score = 0;
      for (const t of terms) {
        const f = tf.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (N - this.df.get(t) + 0.5) / (this.df.get(t) + 0.5));
        score += (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (c.tokens.length / this.avgLen)));
      }
      // 최근 문서일수록 조금 더 위로: 오늘 수정된 문서는 최대 1.5배, 90일 이상 지난 문서는 그대로.
      const ageDays = c.doc.updated ? (Date.now() - Date.parse(c.doc.updated)) / 86_400_000 : 365;
      score *= 1 + 0.5 * Math.max(0, 1 - ageDays / 90);
      if (score > 0) scored.push({ c, score });
    }
    // 같은 문서의 조각이 결과를 독차지하지 않도록 문서당 최고 점수 조각 하나만.
    const best = new Map();
    for (const s of scored.sort((a, b) => b.score - a.score)) if (!best.has(s.c.doc.id)) best.set(s.c.doc.id, s);
    return [...best.values()].slice(0, limit).map(({ c }) => ({ doc: c.doc, snippet: c.text.slice(0, 500) }));
  }

  get(id) {
    return this.docs.get(id);
  }
}
