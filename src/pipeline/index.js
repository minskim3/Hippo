import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { transcribeMeeting } from './transcribe.js';
import { summarizeMeeting } from './summarize.js';
import { publishToNotion } from './notion-publish.js';
import { loadCost, formatCost } from './cost.js';

/**
 * 녹음 폴더 → 전사 → 요약 → 노션 업로드.
 * 단계마다 결과를 폴더에 저장하므로, 중간에 실패해도 다시 실행하면 이어서 진행된다.
 */
export const STEPS = { transcribe: '1/3 받아쓰기(STT)', summarize: '2/3 회의록 요약', publish: '3/3 노션 업로드' };

export async function processMeeting(dir, onProgress = () => {}) {
  let step = 'transcribe';
  try {
    return await runSteps(dir, onProgress, (s) => (step = s));
  } catch (err) {
    err.step = step; // 어느 단계에서 실패했는지 알려 주려고 붙인다.
    throw err;
  }
}

async function runSteps(dir, onProgress, setStep) {
  const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));

  onProgress('음성을 텍스트로 변환하는 중...');
  const transcript = await transcribeMeeting(dir);
  if (!transcript) throw new Error('녹음된 발화가 없습니다.');

  setStep('summarize');
  onProgress('회의록을 작성하는 중...');
  const minutes = await summarizeMeeting(dir, transcript);

  setStep('publish');
  onProgress('노션에 올리는 중...');
  const started = new Date(meta.startedAt);
  const date = started.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }); // YYYY-MM-DD
  const time = started.toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
  // 이미 올린 회의를 다시 돌려도 노션 페이지가 또 생기지 않게, 올린 기록이 있으면 그걸 쓴다.
  const publishedFile = path.join(dir, 'notion.json');
  const { title, url } = fs.existsSync(publishedFile)
    ? JSON.parse(await fsp.readFile(publishedFile, 'utf8'))
    : await publishToNotion({ meta, minutes, date, time });
  await fsp.writeFile(publishedFile, JSON.stringify({ title, url }));
  await fsp.writeFile(path.join(dir, 'notion-url.txt'), url);
  const cost = formatCost(await loadCost(dir));
  return { title: `${date} ${title}`, url, minutes, cost };
}

// 직접 실행: node src/pipeline/index.js recordings/<회의 폴더>
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('사용법: npm run process -- recordings/<회의 폴더>');
    process.exit(1);
  }
  processMeeting(dir, console.log).then(({ url, cost }) => {
    console.log('완료:', url);
    if (cost) console.log('비용:', cost);
  });
}
