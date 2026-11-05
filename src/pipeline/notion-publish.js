import { config } from '../config.js';
import { notionFetch, text } from '../notion.js';
import { attendance, findMemberByName } from '../members.js';

// Notion-flavored Markdown에서 서식으로 해석될 수 있는 문자를 이스케이프한다.
const esc = (s) => String(s).replace(/([\\*_~`<>[\]|])/g, '\\$1');

// 노션 사용자 멘션. 노션 ID가 없으면 이름 텍스트로.
function userMention(member) {
  return member.notionId ? `<mention-user url="user://${member.notionId}"/>` : esc(member.name);
}

function nameMention(name) {
  const member = findMemberByName(name);
  return member ? userMention(member) : esc(name);
}

const bullets = (items) => (items.length ? items.map((item) => `- ${esc(item)}`).join('\n') : '- 없음');

function todo(item) {
  const who = item.assignees.map(nameMention).join(' ');
  const due = [item.due && `<mention-date start="${item.due}"/>`, item.dueText && esc(item.dueText)].filter(Boolean).join(' ');
  return `- [ ] ${who} ${esc(item.task)}${due ? ` · ${due}` : ''}`;
}

const HIPPO_MARK = '(Hippo 작성)';
const pageTitle = (page) => page.properties['이름'].title.map((t) => t.plain_text).join('');
const meetingNumber = (title) => Number(title.match(/(\d+)\s*차/)?.[1]) || 0;

// Planner의 "N차 ..." 회의 항목 중 가장 큰 N 다음 번호.
async function nextMeetingNumber() {
  let max = 0;
  let cursor;
  do {
    const res = await notionFetch(`/data_sources/${config.notion.plannerDataSourceId()}/query`, {
      method: 'POST',
      body: { filter: { property: '태그', multi_select: { contains: '회의' } }, page_size: 100, start_cursor: cursor },
    });
    for (const page of res.results) max = Math.max(max, meetingNumber(pageTitle(page)));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return max + 1;
}

// 같은 날짜(YYYY-MM-DD)에 사람이 쓴 회의 항목. Hippo가 만든 페이지는 뺀다.
async function findHumanMeetingOn(date) {
  const nextDay = new Date(new Date(`${date}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
  const res = await notionFetch(`/data_sources/${config.notion.plannerDataSourceId()}/query`, {
    method: 'POST',
    body: {
      filter: {
        and: [
          { property: '태그', multi_select: { contains: '회의' } },
          { property: '날짜', date: { on_or_after: date } },
          { property: '날짜', date: { before: nextDay } },
        ],
      },
      page_size: 20,
    },
  });
  return res.results.find((page) => !pageTitle(page).includes('Hippo'));
}

/**
 * 📍 Moamap Planner에 회의록을 올린다.
 * 사람이 쓰는 회의록과 섞이지 않게 항상 "N차 회의 (Hippo 작성)" 페이지를 새로 만든다.
 * 차수는 같은 날 사람이 쓴 회의록의 차수를 따르고, 그런 페이지가 없으면 다음 차수를 쓴다.
 * 본문: 요약·결정·할 일(체크박스)이 위, 그 아래는 팀 양식(파트별 진행 상황 → 안건 → 다음 논의 내용).
 */
export async function publishToNotion({ meta, minutes, date, time }) {
  const { present, absent } = attendance(meta);
  const presentIds = present.filter((m) => m.notionId).map((m) => m.notionId);

  // 결론(요약·결정·할 일·다음 논의)은 펼쳐 두고, 안건별 논의와 파트별 진행 상황은 토글 제목 아래에 접어 둔다.
  // 토글 안의 내용은 탭으로 한 단계 들여쓴다.
  const body = [
    '<callout icon="🦛">',
    `\t${date} ${time} · 디스코드 #${esc(meta.channelName)} · 녹음 기반 자동 작성`,
    `\t**참석** ${present.map(userMention).join(' ')}${absent.length ? ` · **불참** ${absent.map(userMention).join(' ')}` : ''}`,
    '</callout>',
    '## 📌 요약',
    esc(minutes.summary),
    '## ✅ 결정 사항',
    bullets(minutes.decisions),
    '## 📝 할 일',
    minutes.actionItems.length ? minutes.actionItems.map(todo).join('\n') : '- 없음',
    '## ⏳ 다음 논의 내용',
    bullets(minutes.pending),
    '## 💬 안건별 논의 {toggle="true"}',
    ...minutes.agenda.flatMap((item) => [
      `\t**${esc(item.title)}** · 발제 ${item.presenter ? nameMention(item.presenter) : '-'}`,
      ...item.points.map((p) => `\t- ${esc(p)}`),
    ]),
    '## 🔄 파트별 진행 상황 {toggle="true"}',
    ...minutes.parts.flatMap((part) => [
      `\t**${esc(part.name)}**`,
      ...part.mainWork.map((w) => `\t- ${esc(w)}`),
      ...part.upcoming.map((w) => `\t- 예정: ${esc(w)}`),
    ]),
  ];

  const human = await findHumanMeetingOn(date);
  const number = (human && meetingNumber(pageTitle(human))) || (await nextMeetingNumber());
  const title = `${number}차 회의 ${HIPPO_MARK}`;
  const page = await notionFetch('/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: config.notion.plannerDataSourceId() },
      icon: { type: 'emoji', emoji: '🦛' },
      properties: {
        이름: { title: text(title) },
        날짜: { date: { start: meta.startedAt } },
        태그: { multi_select: [{ name: '회의' }, { name: '비대면' }] },
        참석자: { people: presentIds.map((id) => ({ id })) },
      },
      markdown: body.join('\n'),
    },
  });
  return { title, url: page.url };
}
