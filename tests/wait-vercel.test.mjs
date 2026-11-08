import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForVercel } from '../scripts/wait-vercel.mjs';

const config = { repository: 'owner/repo', sha: 'a'.repeat(40), token: 'test-token', timeoutMs: 30, intervalMs: 10 };
const status = state => ({ context: 'Vercel', state });

function harness(responses) {
  let time = 0;
  const calls = [], logs = [];
  return {
    calls, logs,
    dependencies: {
      async fetchImpl(url, options) {
        calls.push({ url: String(url), options });
        const next = responses.shift() ?? { statuses: [] };
        if (next instanceof Error) throw next;
        return { ok: !next.http || next.http < 400, status: next.http || 200, json: async () => next };
      },
      sleep: async milliseconds => { time += milliseconds; },
      now: () => time,
      log: line => logs.push(line)
    }
  };
}

test('ожидание читает статус именно записанного коммита и заканчивается после успеха Vercel', async () => {
  const mock = harness([{ statuses: [] }, { statuses: [status('pending')] }, { statuses: [status('success')] }]);
  const result = await waitForVercel(config, mock.dependencies);
  assert.equal(result[0].state, 'success');
  assert.equal(mock.calls.length, 3);
  assert.equal(mock.calls[0].url, `https://api.github.com/repos/owner/repo/commits/${config.sha}/status`);
  assert.equal(mock.calls[0].options.headers.Authorization, 'Bearer test-token');
  assert(!mock.logs.join('\n').includes(config.token));
});

test('успех другой проверки не подменяет успех Vercel', async () => {
  const mock = harness([{ statuses: [{ context: 'tests', state: 'success' }] }]);
  await assert.rejects(waitForVercel(config, mock.dependencies), /не подтвердил деплой/);
});

test('ошибка Vercel останавливает workflow', async () => {
  for (const state of ['failure', 'error']) {
    const mock = harness([{ statuses: [status(state)] }]);
    await assert.rejects(waitForVercel(config, mock.dependencies), /ошибке деплоя/);
    assert.equal(mock.calls.length, 1);
  }
});

test('ожидание ограничено по времени и повторяет временные сетевые ошибки', async () => {
  const mock = harness([new Error('network error'), { http: 503 }, { statuses: [status('success')] }]);
  await waitForVercel(config, mock.dependencies);
  assert.equal(mock.calls.length, 3);
  const pending = harness([{ statuses: [status('pending')] }]);
  await assert.rejects(waitForVercel(config, pending.dependencies), /не подтвердил деплой/);
  assert.equal(pending.calls.length, 3);
});

test('ошибки авторизации и неверные параметры не маскируются ожиданием', async () => {
  const mock = harness([{ http: 401 }]);
  await assert.rejects(waitForVercel(config, mock.dependencies), /HTTP 401/);
  assert.equal(mock.calls.length, 1);
  await assert.rejects(waitForVercel({ ...config, sha: '' }, mock.dependencies), /SHA/);
  await assert.rejects(waitForVercel({ ...config, token: '' }, mock.dependencies), /TOKEN/);
});

test('при нескольких статусах Vercel ожидается успех всех', async () => {
  const mock = harness([
    { statuses: [status('success'), { context: 'Vercel – preview', state: 'pending' }] },
    { statuses: [status('success'), { context: 'Vercel – preview', state: 'success' }] }
  ]);
  await waitForVercel(config, mock.dependencies);
  assert.equal(mock.calls.length, 2);
});
