import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { saveDocs } from './store.js';

/**
 * 녹음 폴더의 회의 대본(transcript.md)을 brain/meeting.json에 저장한다.
 * 회의록 자체는 노션에서 들어오므로, 여기서는 "누가 정확히 뭐라고 했는지" 확인용 원문만 넣는다.
 */
export function syncMeetings(log = console.log) {
  const docs = {};
  if (fs.existsSync(config.recordingsDir)) {
    for (const name of fs.readdirSync(config.recordingsDir)) {
      const dir = path.join(config.recordingsDir, name);
      const transcriptFile = path.join(dir, 'transcript.md');
      const metaFile = path.join(dir, 'meta.json');
      if (!fs.existsSync(transcriptFile) || !fs.existsSync(metaFile)) continue;
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      const date = new Date(meta.startedAt).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);
      const urlFile = path.join(dir, 'notion-url.txt');
      docs[name] = {
        id: name,
        source: 'meeting',
        title: `${date} #${meta.channelName} 회의 대본`,
        url: fs.existsSync(urlFile) ? fs.readFileSync(urlFile, 'utf8').trim() : null,
        updated: meta.endedAt,
        text: fs.readFileSync(transcriptFile, 'utf8'),
      };
    }
  }
  saveDocs('meeting', docs);
  log(`[brain] 회의 대본 ${Object.keys(docs).length}개`);
}
