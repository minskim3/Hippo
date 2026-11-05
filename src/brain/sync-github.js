import { config } from '../config.js';
import { loadDocs, saveDocs, redactSecrets } from './store.js';

async function gh(pathname) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      Authorization: `Bearer ${config.github.token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function paginate(pathname) {
  const all = [];
  for (let page = 1; ; page++) {
    const sep = pathname.includes('?') ? '&' : '?';
    const items = await gh(`${pathname}${sep}per_page=100&page=${page}`);
    all.push(...items);
    if (items.length < 100) return all;
  }
}

// PR 본문·제목에서 연결된 이슈 번호를 찾는다. "Closes #12", "fix #3", 팀 규칙의 "[FEAT] … (#12)" 형식.
function linkedIssues(pr) {
  const text = `${pr.title}\n${pr.body ?? ''}`;
  const numbers = [
    ...[...text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)/gi)].map((m) => m[1]),
    ...[...pr.title.matchAll(/\(#(\d+)\)/g)].map((m) => m[1]),
  ];
  return [...new Set(numbers.map(Number))].filter((n) => n !== pr.number);
}

const ISSUE_STATE = { open: '열림', closed: '닫힘' };
const PR_STATE = { open: '열림', merged: '머지됨', closed: '머지 안 하고 닫힘' };

function issueDoc(repo, issue, comments) {
  return {
    id: `${repo.name}#${issue.number}`,
    source: 'github',
    title: `[${repo.name} #${issue.number}] ${issue.title}`,
    url: issue.html_url,
    updated: issue.updated_at,
    meta: { repo: repo.name, kind: 'issue', state: issue.state },
    text: redactSecrets([
      `저장소: ${repo.name} · 이슈 · 상태: ${ISSUE_STATE[issue.state]}` +
        (issue.closed_at ? ` (닫힌 날짜 ${issue.closed_at.slice(0, 10)})` : ''),
      `라벨: ${issue.labels.map((l) => l.name).join(', ') || '없음'} · 담당: ${issue.assignees.map((a) => a.login).join(', ') || '없음'} · 작성: ${issue.user.login} · 생성 ${issue.created_at.slice(0, 10)}`,
      issue.body ?? '',
      ...comments.map((c) => `\n댓글 (${c.user.login}, ${c.created_at.slice(0, 10)}):\n${c.body}`),
    ].join('\n')),
  };
}

async function prDoc(repo, item, comments) {
  const pr = await gh(`/repos/${repo.full_name}/pulls/${item.number}`);
  const state = pr.merged_at ? 'merged' : pr.state;
  // 리뷰 상태는 열린 PR에서만 의미가 있어서, 열린 PR만 리뷰를 가져온다.
  const reviews = state === 'open' ? await paginate(`/repos/${repo.full_name}/pulls/${pr.number}/reviews`) : [];
  const latestReview = new Map(reviews.filter((r) => r.state !== 'COMMENTED').map((r) => [r.user.login, r.state]));
  const links = linkedIssues(pr);
  return {
    id: `${repo.name}#${pr.number}`,
    source: 'github',
    title: `[${repo.name} PR #${pr.number}] ${pr.title}`,
    url: pr.html_url,
    updated: pr.updated_at,
    meta: { repo: repo.name, kind: 'pr', state, mergedAt: pr.merged_at, draft: pr.draft, linkedIssues: links },
    text: redactSecrets([
      `저장소: ${repo.name} · PR · 상태: ${PR_STATE[state]}${pr.draft ? ' (초안)' : ''}` +
        (pr.merged_at ? ` (머지 ${pr.merged_at.slice(0, 10)}, ${pr.merged_by?.login ?? ''})` : '') +
        (state === 'closed' ? ` (닫힌 날짜 ${pr.closed_at.slice(0, 10)})` : ''),
      `브랜치: ${pr.head.ref} → ${pr.base.ref} · 작성: ${pr.user.login} · 생성 ${pr.created_at.slice(0, 10)} · 변경 파일 ${pr.changed_files}개 (+${pr.additions}/-${pr.deletions})`,
      `연결된 이슈: ${links.map((n) => `#${n}`).join(', ') || '없음'}`,
      state === 'open'
        ? `리뷰: ${[...latestReview].map(([who, s]) => `${who} ${s === 'APPROVED' ? '승인' : s === 'CHANGES_REQUESTED' ? '수정 요청' : s}`).join(', ') || '아직 없음'}` +
          (pr.requested_reviewers.length ? ` · 리뷰 요청: ${pr.requested_reviewers.map((u) => u.login).join(', ')}` : '')
        : '',
      pr.body ?? '',
      ...comments.map((c) => `\n댓글 (${c.user.login}, ${c.created_at.slice(0, 10)}):\n${c.body}`),
    ].filter(Boolean).join('\n')),
  };
}

/**
 * 조직의 모든 저장소 이슈와 PR(댓글 포함)을 brain/github.json에 저장한다.
 * 마지막 동기화 이후 바뀐 것만 다시 가져온다(since).
 */
export async function syncGithub(log = console.log) {
  const docs = loadDocs('github');
  const since = Object.values(docs).reduce((max, d) => (d.updated > max ? d.updated : max), '');
  const repos = await paginate(`/orgs/${config.github.org}/repos?type=all`);
  let changed = 0;

  for (const repo of repos) {
    // /issues는 이슈와 PR을 함께 돌려준다. PR은 pull_request 필드로 구분한다.
    const items = await paginate(`/repos/${repo.full_name}/issues?state=all${since ? `&since=${since}` : ''}`);
    for (const item of items) {
      const comments = item.comments ? await paginate(`/repos/${repo.full_name}/issues/${item.number}/comments`) : [];
      const doc = item.pull_request ? await prDoc(repo, item, comments) : issueDoc(repo, item, comments);
      docs[doc.id] = doc;
      changed++;
    }
  }

  saveDocs('github', docs);
  const prs = Object.values(docs).filter((d) => d.meta.kind === 'pr').length;
  log(`[brain] GitHub 이슈 ${Object.keys(docs).length - prs}개 + PR ${prs}개 (바뀐 것 ${changed}, 저장소 ${repos.length})`);
}
