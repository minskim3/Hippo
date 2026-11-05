import { EmbedBuilder } from 'discord.js';
import { discordMentionByName } from './members.js';

// 디스코드 임베드 제한: 설명 4096자, 필드 값 1024자.
const FIELD_LIMIT = 1024;

// 줄 단위로 넣다가 넘치면 "…외 N개"로 끊는다.
function fitLines(lines, empty = '없음') {
  if (!lines.length) return empty;
  const out = [];
  let length = 0;
  for (const [i, line] of lines.entries()) {
    const more = `…외 ${lines.length - i}개 (회의록에서 확인)`;
    if (length + line.length + 1 + more.length > FIELD_LIMIT) {
      out.push(more);
      break;
    }
    out.push(line);
    length += line.length + 1;
  }
  return out.join('\n');
}

function formatDue(item) {
  const parts = [];
  if (item.due) parts.push(item.due.slice(5).replace('-', '/')); // 2026-10-25 → 10/25
  if (item.dueText) parts.push(item.dueText);
  return parts.length ? ` · ${parts.join(', ')}` : '';
}

/** 구조화된 회의록 → /회의종료 응답에 붙일 요약 임베드. 임베드 속 멘션은 알림을 보내지 않는다. */
export function buildSummaryEmbed({ title, url, minutes, cost }) {
  return new EmbedBuilder()
    .setTitle(`📝 ${title}`)
    .setURL(url)
    .setDescription(`**📌 요약**\n${minutes.summary}`.slice(0, 4096))
    .addFields(
      { name: '✅ 결정 사항', value: fitLines(minutes.decisions.map((d) => `• ${d}`)) },
      {
        name: '📝 할 일',
        value: fitLines(
          minutes.actionItems.map((item) => `• ${item.assignees.map(discordMentionByName).join(' ')} ${item.task}${formatDue(item)}`),
        ),
      },
      { name: '⏳ 보류', value: fitLines(minutes.pending.map((p) => `• ${p}`)) },
    )
    .setFooter({ text: `제목을 누르면 노션 회의록으로 이동해요${cost ? ` · 비용 ${cost}` : ''}` });
}

/** /물어보기 답변 임베드. 답변 본문에 출처 링크가 들어 있고, 읽은 문서는 아래에 따로 모은다. */
export function buildAnswerEmbed(question, answer, sources) {
  const embed = new EmbedBuilder()
    .setTitle(`🦛 ${question}`.slice(0, 256))
    .setDescription(answer.slice(0, 4096))
    .setFooter({ text: '위키·노션·GitHub 이슈·회의 대본을 바탕으로 답했어요. 틀린 부분이 있으면 원문을 확인해 주세요.' });
  const read = sources.map((s) => (s.url ? `• [${s.title}](${s.url})` : `• ${s.title}`));
  if (read.length) embed.addFields({ name: '📚 읽은 자료', value: fitLines(read) });
  return embed;
}
