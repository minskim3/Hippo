import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`환경변수 ${name}가 설정되지 않았습니다. .env를 확인하세요.`);
  return value;
}

export const config = {
  discord: {
    token: () => required('DISCORD_TOKEN'),
    clientId: () => required('DISCORD_CLIENT_ID'),
    guildId: () => required('DISCORD_GUILD_ID'),
  },
  openrouter: {
    apiKey: () => required('OPENROUTER_API_KEY'),
    sttModel: process.env.STT_MODEL || 'openai/whisper-large-v3',
    // 앞에서부터 시도하고, 실패(한도 초과·장애 등)하면 다음 모델로 넘어간다.
    summaryModels: (process.env.SUMMARY_MODELS || 'anthropic/claude-sonnet-5.5,anthropic/claude-haiku-5.5')
      .split(',')
      .map((m) => m.trim()),
  },
  notion: {
    token: () => required('NOTION_TOKEN'),
    plannerDataSourceId: () => required('NOTION_PLANNER_DATA_SOURCE_ID'), // 회의 항목을 추가할 📍 Moamap Planner
    rootPageId: () => required('NOTION_ROOT_PAGE_ID'), // 세컨드 브레인이 읽을 팀 최상위 페이지
  },
  github: {
    token: () => required('GITHUB_TOKEN'), // Moa-Map 조직 이슈 읽기 권한
    org: process.env.GITHUB_ORG || 'Moa-Map',
  },
  brain: {
    dir: process.env.BRAIN_DIR || './brain',
    model: process.env.BRAIN_MODEL || 'anthropic/claude-haiku-5.5',
    wikiDir: process.env.WIKI_DIR || './wiki',
    // 바뀐 원본을 위키에 반영하는 주기(시간). 바뀐 게 없으면 건너뛴다.
    wikiUpdateHours: Number(process.env.WIKI_UPDATE_HOURS || 24),
    // 주간 위키 점검 결과를 올릴 디스코드 채널. 비워 두면 점검하지 않는다.
    wikiReportChannelId: process.env.WIKI_REPORT_CHANNEL_ID || '',
    // 제목에 이 단어가 들어간 노션 페이지는 하위 페이지까지 통째로 읽지 않는다(민감 정보).
    notionExclude: (process.env.BRAIN_NOTION_EXCLUDE || '개인 연락처,계정,회계,Certificate,.env,API 키,API key,secret,토큰,token,비밀번호,password')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },
  recordingsDir: process.env.RECORDINGS_DIR || './recordings',
  membersFile: process.env.MEMBERS_FILE || './members.json',
};
