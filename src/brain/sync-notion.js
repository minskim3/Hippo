import fs from 'node:fs';
import { config } from '../config.js';
import { notionFetch } from '../notion.js';
import { loadDocs, saveDocs, redactSecrets } from './store.js';

const plain = (richText) => (richText ?? []).map((t) => t.plain_text).join('');

// 노션 사용자 ID → 이름 (members.json). 마크다운의 멘션을 읽을 수 있는 이름으로 바꾸는 데 쓴다.
function notionNames() {
  if (!fs.existsSync(config.membersFile)) return {};
  const members = Object.values(JSON.parse(fs.readFileSync(config.membersFile, 'utf8')));
  return Object.fromEntries(members.filter((m) => m.notionId).map((m) => [m.notionId, m.name]));
}

function cleanMarkdown(md, names) {
  return md
    .replace(/<mention-user url="user:\/\/([^"]+)"\/>/g, (_, id) => `@${names[id] ?? '사용자'}`)
    .replace(/<mention-date start="([^"]+)"[^>]*\/>/g, '$1')
    .replace(/<mention-page url="[^"]*">([^<]*)<\/mention-page>/g, '$1')
    // 이미지·첨부는 곧 만료되는 서명 URL이라 쓸모가 없어서 표시만 남긴다.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => `[이미지${alt ? `: ${alt}` : ''}]`)
    .replace(/<(file|pdf|video|audio)\s[^>]*>([^<]*)<\/\1>/g, (_, kind, caption) => `[첨부${caption ? `: ${caption}` : ''}]`)
    .replace(/<(unknown|empty-block)[^>]*\/>/g, '')
    .replace(/<\/?(span|callout|details|summary)[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// DB 행의 속성을 "속성: 값" 줄로. 검색과 답변에서 날짜·상태·담당자 같은 정보를 쓸 수 있게 한다.
function propertiesText(properties) {
  const lines = [];
  for (const [name, p] of Object.entries(properties)) {
    let value;
    if (p.type === 'title') continue;
    else if (p.type === 'rich_text') value = plain(p.rich_text);
    else if (p.type === 'select') value = p.select?.name;
    else if (p.type === 'status') value = p.status?.name;
    else if (p.type === 'multi_select') value = p.multi_select.map((o) => o.name).join(', ');
    else if (p.type === 'date') value = p.date && [p.date.start, p.date.end].filter(Boolean).join(' ~ ');
    else if (p.type === 'people') value = p.people.map((u) => u.name).filter(Boolean).join(', ');
    else if (p.type === 'checkbox') value = p.checkbox ? '예' : '아니오';
    else if (p.type === 'number') value = p.number;
    else if (p.type === 'url') value = p.url;
    if (value !== undefined && value !== null && value !== '') lines.push(`${name}: ${value}`);
  }
  return lines.join('\n');
}

const isExcluded = (title) => config.brain.notionExclude.some((word) => title.toLowerCase().includes(word));

/**
 * 팀 최상위 페이지부터 하위 페이지·DB 행을 모두 읽어 brain/notion.json에 저장한다.
 * 바뀐 페이지(last_edited_time 기준)만 다시 가져오고, 사라진 페이지는 지운다.
 * 제외 단어가 제목에 들어간 페이지는 하위까지 통째로 건너뛴다.
 */
export async function syncNotion(log = console.log) {
  const old = loadDocs('notion');
  const docs = {};
  const names = notionNames();
  let fetched = 0;
  let skipped = 0;

  async function savePage({ id, title, url, updated, path, extra = '' }) {
    if (old[id]?.updated === updated) {
      docs[id] = { ...old[id], title, meta: { path } };
      return;
    }
    const { markdown } = await notionFetch(`/pages/${id}/markdown`);
    fetched++;
    docs[id] = {
      id,
      source: 'notion',
      title,
      url,
      updated,
      meta: { path },
      text: redactSecrets([`경로: ${path.join(' > ')}`, extra, cleanMarkdown(markdown, names)].filter(Boolean).join('\n')),
    };
  }

  async function walkDatabase(dbId, path) {
    const db = await notionFetch(`/databases/${dbId}`);
    for (const ds of db.data_sources) {
      let cursor;
      do {
        const res = await notionFetch(`/data_sources/${ds.id}/query`, {
          method: 'POST',
          body: { page_size: 100, start_cursor: cursor },
        });
        for (const row of res.results) {
          const titleProp = Object.values(row.properties).find((p) => p.type === 'title');
          const title = plain(titleProp?.title) || '(제목 없음)';
          if (isExcluded(title)) {
            skipped++;
            continue;
          }
          const rowPath = [...path, ds.name || '데이터베이스'];
          await savePage({
            id: row.id,
            title,
            url: row.url,
            updated: row.last_edited_time,
            path: rowPath,
            extra: propertiesText(row.properties),
          });
          // DB 행도 페이지라서 안에 하위 페이지·DB가 있을 수 있다(예: Planner의 "3차 QA" 안의 QA DB·약관 페이지).
          await walkBlocks(row.id, [...rowPath, title]);
        }
        cursor = res.has_more ? res.next_cursor : undefined;
      } while (cursor);
    }
  }

  async function walkBlocks(blockId, path) {
    let cursor;
    do {
      const res = await notionFetch(`/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
      for (const b of res.results) {
        if (b.type === 'child_page') {
          const title = b.child_page.title || '(제목 없음)';
          if (isExcluded(title)) {
            skipped++;
            continue;
          }
          await savePage({
            id: b.id,
            title,
            url: `https://www.notion.so/${b.id.replace(/-/g, '')}`,
            updated: b.last_edited_time,
            path,
          });
          await walkBlocks(b.id, [...path, title]);
        } else if (b.type === 'child_database') {
          const title = b.child_database.title;
          if (isExcluded(title)) {
            skipped++;
            continue;
          }
          await walkDatabase(b.id, [...path, title]).catch((err) => log(`[brain] DB 건너뜀 (${title}): ${err.message.slice(0, 80)}`));
        } else if (b.has_children) {
          // 열·토글·인용·목록 등 어떤 블록 안에든 하위 페이지·DB가 들어 있을 수 있다.
          await walkBlocks(b.id, path);
        }
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
  }

  const root = await notionFetch(`/pages/${config.notion.rootPageId()}`);
  const rootTitle = plain(Object.values(root.properties).find((p) => p.type === 'title')?.title) || '팀 홈';
  await savePage({ id: root.id, title: rootTitle, url: root.url, updated: root.last_edited_time, path: [] });
  await walkBlocks(root.id, [rootTitle]);

  saveDocs('notion', docs);
  log(`[brain] 노션 ${Object.keys(docs).length}개 (새로 가져옴 ${fetched}, 민감 페이지 제외 ${skipped})`);
}
