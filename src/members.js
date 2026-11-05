import fs from 'node:fs';
import { config } from './config.js';

/**
 * members.json: 디스코드 사용자 ID → 실명·역할.
 * { "<userId>": { "discord": "아이디(참고용)", "name": "실명", "role": "역할(선택)", "notionId": "노션 사용자 ID(선택)" } }
 * name이 비어 있거나 목록에 없으면 디스코드 닉네임을 그대로 쓴다.
 */
function loadMembers() {
  if (!fs.existsSync(config.membersFile)) return {};
  return JSON.parse(fs.readFileSync(config.membersFile, 'utf8'));
}

export function speakerName(userId, meta) {
  return loadMembers()[userId]?.name || meta.speakers[userId] || userId;
}

/** 이름으로 팀원을 찾는다. 팀원이 아니면(예: "전원") undefined. */
export function findMemberByName(name) {
  return Object.values(loadMembers()).find((m) => m.name === name);
}

/** 이름으로 팀원을 찾아 디스코드 멘션(<@id>)으로. 팀원이 아니면 이름 그대로. */
export function discordMentionByName(name) {
  const entry = Object.entries(loadMembers()).find(([, m]) => m.name === name);
  return entry ? `<@${entry[0]}>` : name;
}

/**
 * 참석자·불참자 목록(팀원 객체 { name, notionId? }).
 * 회의 중 음성 채널에 들어왔던 사람은 말을 안 했어도 참석자, members.json 팀원 중 나머지가 불참자다.
 * 예전 녹음은 attendees가 없어 목소리가 잡힌 사람(speakers)만으로 판정한다.
 */
export function attendance(meta) {
  const members = loadMembers();
  const attendees = { ...meta.attendees, ...meta.speakers };
  const present = Object.entries(attendees).map(([userId, displayName]) =>
    members[userId]?.name ? members[userId] : { name: displayName || userId },
  );
  const absent = Object.entries(members)
    .filter(([userId, m]) => m.name && !(userId in attendees))
    .map(([, m]) => m);
  return { present, absent };
}

/** 회의록 작성 시 참고할 팀 구성. 이름이 있는 사람만, "- 이름: 역할" 형태. */
export function teamRoster() {
  return Object.values(loadMembers())
    .filter((m) => m.name)
    .map((m) => `- ${m.name}${m.role ? `: ${m.role}` : ''}`)
    .join('\n');
}
