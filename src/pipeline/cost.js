import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// 회의록 한 건에 든 비용을 단계별로 회의 폴더의 cost.json에 남긴다. 금액은 OpenRouter가 응답에 알려 주는 실제 비용(달러).
export async function saveCost(dir, step, entry) {
  const file = path.join(dir, 'cost.json');
  const costs = fs.existsSync(file) ? JSON.parse(await fsp.readFile(file, 'utf8')) : {};
  costs[step] = entry;
  await fsp.writeFile(file, JSON.stringify(costs, null, 2));
}

export async function loadCost(dir) {
  const file = path.join(dir, 'cost.json');
  return fs.existsSync(file) ? JSON.parse(await fsp.readFile(file, 'utf8')) : {};
}

/** "STT $0.031 (66분) + 요약 $0.172 = $0.203" 같은 한 줄. 기록이 없는 단계는 뺀다. */
export function formatCost(costs) {
  const parts = [];
  if (costs.stt) parts.push(`STT $${costs.stt.cost.toFixed(3)} (${costs.stt.audioMinutes}분)`);
  if (costs.summary) parts.push(`요약 $${costs.summary.cost.toFixed(3)}`);
  if (!parts.length) return '';
  const total = (costs.stt?.cost ?? 0) + (costs.summary?.cost ?? 0);
  return `${parts.join(' + ')} = $${total.toFixed(3)}`;
}
