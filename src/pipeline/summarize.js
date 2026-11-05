import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { openrouter } from '../openrouter.js';
import { teamRoster } from '../members.js';
import { saveCost } from './cost.js';

const SYSTEM_PROMPT = `너는 팀 회의록 작성자다. 화자와 시간이 붙은 회의 대본을 받아 한국어 회의록을 JSON으로 작성한다.
읽는 사람은 요약·결정·할 일·다음 논의만 보고 회의 결과를 파악하고, 안건별 논의와 파트별 진행 상황은 접힌 상세 영역에서 필요할 때만 본다.

문체: 짧은 개조식으로 쓴다("~함", "~로 결정", 명사형). "~하기로 했다" 같은 서술형 문장과 수식어는 빼고, 한 줄은 되도록 40자 안쪽으로.
중복 금지: 한 내용은 한 곳에만 쓴다. 결정된 것은 decisions에만, 미정인 것은 pending에만 쓰고, agenda에서는 그 결론을 되풀이하지 않는다.

각 필드:
- summary: 회의 핵심 2문장.
- decisions: 확정된 것만, 한 줄에 하나씩. 사소한 것은 빼고 많아야 7개. 없으면 빈 배열.
- actionItems: 회의에서 누군가 맡기로 한 일.
  - assignees: 담당자 이름 배열. 팀원이면 <team>의 이름 그대로 쓴다. 전원이면 ["전원"].
  - task: 할 일을 짧은 한 줄로.
  - due: 기한을 <meeting_date> 기준으로 계산할 수 있으면 "YYYY-MM-DD"(예: "내일", "이번 주 금요일", "25일"), 아니면 null.
  - dueText: due로 못 바꾸는 기한 표현(예: "회의 직후", "출시 전까지"). 기한 언급이 없거나 due로 충분하면 null.
- pending: 결론이 나지 않아 다음에 다시 다룰 것("다음 논의 내용"). 무엇이 미정인지 한 줄씩. 없으면 빈 배열.
- parts: 회의 중 각 파트가 공유한 진행 상황. 실제로 공유된 파트만, 파트당 각 2~3줄.
  - name: 파트 이름. 팀에서 쓰는 이름을 쓴다: "FE - iOS", "FE - 안드", "BE", "디자인", "기획", "마케팅".
  - mainWork: 한 일·진행 중인 일·이슈.
  - upcoming: 앞으로 할 일과 일정.
- agenda: 다룬 안건. 비슷한 주제는 하나로 묶어(예: 지도 회전·초기 위치·애니메이션 → "지도 UX") 많아야 6개.
  - title: 안건 이름.
  - presenter: 그 안건을 꺼낸 사람의 이름(<team>의 이름). 분명하지 않으면 null.
  - points: 결론에 이르기까지 누가 어떤 의견을 냈는지만 2~3줄(예: "조정운: 긴 이름 때문에 옆 배치 어려움").

대본에 없는 내용은 지어내지 않는다. 음성 인식 오류로 보이는 단어는 문맥상 명확할 때만 바로잡는다.
화자 이름(대본의 "이름:" 부분)은 오타처럼 보여도 한 글자도 바꾸지 말고 대본 표기 그대로 쓴다.
<team>이 주어지면 팀원 이름과 역할을 참고한다. 대본 속 호칭(예: "중희님")이 음성 인식 오류로 조금 틀려 보여도 팀원 이름과 명확히 대응되면 그 이름으로 쓰고, "디자인 쪽"처럼 역할로 지칭된 담당자는 해당 역할의 팀원으로 적는다. 대응이 애매하면 추측하지 말고 대본 표현을 그대로 둔다.`;

const stringList = { type: 'array', items: { type: 'string' } };
const MINUTES_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    decisions: stringList,
    actionItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          assignees: stringList,
          task: { type: 'string' },
          due: { type: ['string', 'null'] },
          dueText: { type: ['string', 'null'] },
        },
        required: ['assignees', 'task', 'due', 'dueText'],
        additionalProperties: false,
      },
    },
    pending: stringList,
    parts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, mainWork: stringList, upcoming: stringList },
        required: ['name', 'mainWork', 'upcoming'],
        additionalProperties: false,
      },
    },
    agenda: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, presenter: { type: ['string', 'null'] }, points: stringList },
        required: ['title', 'presenter', 'points'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'decisions', 'actionItems', 'pending', 'parts', 'agenda'],
  additionalProperties: false,
};

// 노션 업로드가 쓰는 필드가 모두 있는지 확인한다.
function isValidMinutes(m) {
  const strings = (a) => Array.isArray(a) && a.every((s) => typeof s === 'string');
  const list = (a, check) => Array.isArray(a) && a.every((item) => item && check(item));
  return (
    typeof m?.summary === 'string' &&
    strings(m.decisions) &&
    strings(m.pending) &&
    list(m.actionItems, (a) => strings(a.assignees) && typeof a.task === 'string') &&
    list(m.parts, (p) => typeof p.name === 'string' && strings(p.mainWork) && strings(p.upcoming)) &&
    list(m.agenda, (a) => typeof a.title === 'string' && strings(a.points))
  );
}

/** 대본 → 구조화된 회의록 객체. minutes.json으로 캐시한다. */
export async function summarizeMeeting(dir, transcript) {
  const cached = path.join(dir, 'minutes.json');
  if (fs.existsSync(cached)) return JSON.parse(await fsp.readFile(cached, 'utf8'));

  const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
  const meetingDate = new Date(meta.startedAt).toLocaleDateString('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });
  const team = teamRoster();
  const [primary, ...fallbacks] = config.openrouter.summaryModels;
  const completion = await openrouter.chat.completions.create({
    model: primary,
    models: [primary, ...fallbacks], // OpenRouter 폴백: 앞 모델이 실패하면 다음 모델로
    response_format: { type: 'json_schema', json_schema: { name: 'minutes', strict: true, schema: MINUTES_SCHEMA } },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `<meeting_date>${meetingDate}</meeting_date>\n\n${team ? `<team>\n${team}\n</team>\n\n` : ''}<transcript>\n${transcript}\n</transcript>`,
      },
    ],
  });

  const content = completion.choices[0]?.message?.content ?? '';
  console.log(`[summarize] 사용 모델: ${completion.model}`);
  // 구조화 출력을 지원하지 않는 폴백 모델이 코드 블록으로 감싸 보낼 수도 있어 첫 { ~ 마지막 }만 파싱한다.
  const json = content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
  let minutes;
  try {
    minutes = JSON.parse(json);
  } catch {
    throw new Error(`회의록 JSON을 해석하지 못했습니다 (모델: ${completion.model})`);
  }
  // 구조화 출력을 지키지 않는 폴백 모델이 필드를 빼먹을 수 있다. 그대로 캐시하면 다시 시도해도 계속 실패하므로 저장 전에 거른다.
  if (!isValidMinutes(minutes)) throw new Error(`회의록 형식이 올바르지 않습니다 (모델: ${completion.model})`);

  await saveCost(dir, 'summary', {
    model: completion.model,
    inputTokens: completion.usage?.prompt_tokens,
    outputTokens: completion.usage?.completion_tokens,
    cost: completion.usage?.cost ?? 0,
  });
  await fsp.writeFile(cached, JSON.stringify(minutes, null, 2));
  return minutes;
}
