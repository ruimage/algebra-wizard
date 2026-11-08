import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export async function waitForVercel(
  { repository, sha, token, apiUrl = 'https://api.github.com', timeoutMs = 600000, intervalMs = 15000 },
  { fetchImpl = fetch, sleep = setTimeout, now = Date.now, log = console.log } = {}
) {
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository || ''), 'GITHUB_REPOSITORY не задан или имеет неверный формат');
  assert(/^[a-f0-9]{40,64}$/.test(sha || ''), 'Не задан SHA проверенного коммита');
  assert(token, 'Не задан автоматический GITHUB_TOKEN');
  const endpoint = new URL(`/repos/${repository}/commits/${sha}/status`, apiUrl);
  const deadline = now() + timeoutMs;
  let previousState;
  while (now() < deadline) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        headers: {
          Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        signal: AbortSignal.timeout(20000), redirect: 'error'
      });
    } catch {
      log('GitHub API временно недоступен; повторная проверка статуса Vercel.');
    }
    if (response) {
      if (response.status >= 500 || response.status === 429) {
        log(`GitHub API HTTP ${response.status}; повторная проверка статуса Vercel.`);
      } else {
        assert(response.ok, `Не удалось прочитать статус деплоя: GitHub API HTTP ${response.status}`);
        const { statuses } = await response.json();
        assert(Array.isArray(statuses), 'GitHub API не вернул список статусов');
        const vercel = statuses.filter(status => status.context === 'Vercel' || status.context?.startsWith('Vercel – '));
        const failure = vercel.find(status => status.state === 'failure' || status.state === 'error');
        assert(!failure, `Vercel сообщил об ошибке деплоя коммита ${sha}`);
        if (vercel.length && vercel.every(status => status.state === 'success')) {
          log(`Vercel подтвердил успешный деплой коммита ${sha}.`);
          return vercel;
        }
        const state = vercel.length ? 'pending' : 'not-reported';
        if (state !== previousState) {
          log(vercel.length ? 'Vercel выполняет деплой.' : 'Ожидается статус от Vercel Git integration.');
          previousState = state;
        }
      }
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  throw new Error(`Vercel не подтвердил деплой коммита ${sha} за ${timeoutMs / 60000} мин.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await waitForVercel({
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.DEPLOYMENT_SHA,
    token: process.env.GH_TOKEN,
    apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com'
  });
}
