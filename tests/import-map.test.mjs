import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { parseMap, validateMap, inspectMap, createJsonSchema } from '../scripts/mermaid-map.mjs';
import { extractMap } from '../scripts/map.mjs';

const fixture = `flowchart LR
subgraph ENTRY["1. Вход"]
  A["Число >= 0<br/>и &lt; 10"]
  B["Результат [x]"]
  Конец[Готово]
  A -->|Да| B
  A -->|Да| B
  B -.->|Повторить| A
  B --> B
  B --> Конец
end`;

test('официальный парсер сохраняет Unicode, переносы, сущности, параллельные стрелки и циклы', async () => {
  const graph = await parseMap(fixture);
  assert.deepEqual(inspectMap(graph), { nodes: 3, edges: 5, sections: 1 });
  assert.equal(graph.nodes[0].label, 'Число >= 0\nи < 10');
  assert.equal(graph.nodes[1].label, 'Результат [x]');
  assert.equal(graph.nodes[2].id, 'Конец');
  assert.equal(new Set(graph.edges.map(edge => edge.id)).size, 5);
  assert.deepEqual(graph.edges.slice(0, 2).map(edge => [edge.sourceId, edge.targetId, edge.label]), [['A', 'B', 'Да'], ['A', 'B', 'Да']]);
  assert.equal(graph.edges[2].data.kind, 'dotted');
  assert.deepEqual(graph.edges.map(edge => edge.data.order), [0, 1, 2, 3, 4]);
  assert.deepEqual(await parseMap(fixture), graph);
  assert.deepEqual(await parseMap(fixture.replaceAll('\n', '\r\n')), graph);
});

test('добавление посторонней стрелки не меняет ID существующих стрелок', async () => {
  const before = await parseMap(fixture);
  const after = await parseMap(fixture.replace('  A -->|Да| B', '  A --> Конец\n  A -->|Да| B'));
  assert.deepEqual(after.edges.slice(1).map(edge => edge.id), before.edges.map(edge => edge.id));
  assert.notEqual(before.data.source.sha256, after.data.source.sha256);
});

test('ссылка в соседний раздел не меняет место объявления узла или вход раздела', async () => {
  const graph = await parseMap(`graph LR
subgraph ONE["1. Первый"]
A[Первый]
A --> B
end
subgraph TWO["2. Второй"]
C[Вход второго]
B[Второй]
C --> B
end`);
  assert.equal(graph.nodes.find(node => node.id === 'B').data.sectionId, 'TWO');
  assert.equal(graph.data.sections[1].entryNodeId, 'C');
  assert.deepEqual(graph.nodes.map(node => node.id), ['A', 'C', 'B']);
});

test('схема и графовая библиотека отвергают поврежденные JSON-данные', async () => {
  const graph = await parseMap(fixture);
  const mutations = [
    value => value.nodes.push(structuredClone(value.nodes[0])),
    value => value.edges.push({ ...value.edges[0], data: { ...value.edges[0].data, order: 5 } }),
    value => { value.edges[0].targetId = 'missing'; },
    value => { value.edges[0].data.kind = 'unknown'; },
    value => { value.edges[0].data.order = 7; },
    value => { value.nodes[0].data.sectionId = 'missing'; },
    value => { value.data.sections[0].entryNodeId = 'missing'; },
    value => value.data.sections.push(structuredClone(value.data.sections[0])),
    value => { value.schemaVersion = 2; }
  ];
  for (const mutate of mutations) {
    const value = structuredClone(graph);
    mutate(value);
    assert.throws(() => validateMap(value));
  }
});

test('недостижимый узел не исчезает, а вызывает диагностическую ошибку', async () => {
  const graph = await parseMap(fixture);
  graph.nodes.push({ id: 'isolated', label: 'Недостижимый', data: { sectionId: 'ENTRY' } });
  assert.throws(() => inspectMap(graph), /Недостижимые узлы/);
});

test('неподдерживаемые направления и типы линий не теряются молча', async () => {
  for (const arrow of ['A --- B', 'A <--> B', 'A ==> B']) {
    await assert.rejects(parseMap(fixture.replace('A -->|Да| B', arrow)), /Неподдерживаем/);
  }
  await assert.rejects(parseMap('flowchart LR\nA --> B'), /Узел вне разделов/);
});

test('извлекаются все части карты независимо от порядка HTML-атрибутов', () => {
  const html = `<script data-eq-into='diagram' type='text/plain'>graph LR\nA[A]</script><script type="text/plain" data-eq-into="diagram">A --> B</script>`;
  assert.equal(extractMap(html), 'graph LR\nA[A]\nA --> B');
  assert.throws(() => extractMap('<html></html>'));
});

test('JSON Schema воспроизводится и описывает отдельные массивы узлов и стрелок', () => {
  const schema = createJsonSchema();
  const saved = JSON.parse(readFileSync(new URL('../map.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema, saved);
  assert.equal(schema.properties.nodes.type, 'array');
  assert.equal(schema.properties.edges.type, 'array');
  assert.equal(schema.additionalProperties, false);
});

test('невалидный импорт не изменяет сохраненные артефакты', () => {
  const paths = ['../map.json', '../map.schema.json', '../algebra_wizard.html', '../docs/map-source.mmd'].map(path => new URL(path, import.meta.url));
  const before = paths.map(path => readFileSync(path));
  const directory = mkdtempSync(join(tmpdir(), 'algebra-import-invalid-'));
  const sourcePath = join(directory, 'bad.mmd');
  writeFileSync(sourcePath, 'flowchart LR\n A ??? B');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/map.mjs', import.meta.url)), '--source', sourcePath, '--write'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Parse error/);
  paths.forEach((path, index) => assert.deepEqual(readFileSync(path), before[index]));
});

test('мастер запускается из HTML в реальном DOM без сервера и зависимостей', () => {
  const html = readFileSync(new URL('../algebra_wizard.html', import.meta.url), 'utf8');
  const saved = JSON.parse(readFileSync(new URL('../map.json', import.meta.url), 'utf8'));
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://algebra.example/' });
  try {
    const { document } = dom.window;
    assert.equal(dom.window.__algebraDiagnostics.nodes, saved.nodes.length);
    assert.equal(dom.window.__algebraDiagnostics.edges, saved.edges.length);
    assert.equal(document.querySelectorAll('#categories button').length, saved.data.sections.length);
    assert.equal(document.getElementById('sectionsLabel').textContent, saved.data.sections.length + ' разделов · навигация');
    const card = document.getElementById('card');
    const transitions = document.getElementById('transitions');
    assert.equal(card.nextElementSibling, transitions);
    assert.equal(card.querySelectorAll('button').length, 0);
    assert.match(document.querySelector('#card h2').textContent, /мнимая единица/);
    assert.equal(document.querySelectorAll('#transitions button').length, 2);
    assert.equal(document.querySelectorAll('#card button').length, 0);
    const next = transitions.querySelector('button');
    assert.match(next.querySelector('small').textContent, /Просят исследовать функцию:/);
    assert.match(next.querySelector('small').textContent, /обратная функция, значение в точке\?/);
    next.click();
    assert.match(card.querySelector('h2').textContent, /Просят исследовать функцию:/);
  } finally {
    dom.window.close();
  }
});
