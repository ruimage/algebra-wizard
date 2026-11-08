import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createJsonSchema, inspectMap, parseMap } from './mermaid-map.mjs';

export { parseMap, toWizardData } from './mermaid-map.mjs';
const root = new URL('../', import.meta.url);
const sourceUrl = 'https://konstantalab.ru/map';

export function extractMap(html) {
  const parts = [...html.matchAll(/<script\b(?=[^>]*\btype=["']text\/plain["'])(?=[^>]*\bdata-eq-into=["']diagram["'])[^>]*>([\s\S]*?)<\/script>/gi)];
  assert(parts.length > 0, 'На странице нет исходных Mermaid-фрагментов');
  return parts.map(part => part[1]).join('\n');
}

export function readEmbedded(html) {
  const match = html.match(/<script id="map-data" type="application\/json">\r?\n([\s\S]*?)\r?\n<\/script>/);
  assert(match, 'Нет встроенного графа');
  return JSON.parse(match[1]);
}

function embed(html, graph) {
  readEmbedded(html);
  const data = JSON.stringify(graph, null, 2).replaceAll('<', '\\u003c');
  return html.replace(/(<script id="map-data" type="application\/json">\r?\n)[\s\S]*?(\r?\n<\/script>)/, (_, start, end) => start + data + end);
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { live: { type: 'boolean' }, write: { type: 'boolean' }, source: { type: 'string' } } });
  assert(!(values.live && values.source), 'Выберите --live или --source');
  const sourcePath = new URL('docs/map-source.mmd', root);
  let source;
  if (values.live) {
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000) });
    assert(response.ok, `Источник вернул HTTP ${response.status}`);
    source = extractMap(await response.text());
  } else {
    source = readFileSync(values.source || sourcePath, 'utf8');
  }
  const graph = await parseMap(source);
  const summary = inspectMap(graph);
  const htmlPath = new URL('algebra_wizard.html', root);
  const jsonPath = new URL('map.json', root);
  const schemaPath = new URL('map.schema.json', root);
  const html = readFileSync(htmlPath, 'utf8');
  const schema = createJsonSchema();
  if (values.write) {
    const updatedHtml = embed(html, graph);
    writeFileSync(jsonPath, JSON.stringify(graph, null, 2) + '\n');
    writeFileSync(schemaPath, JSON.stringify(schema, null, 2) + '\n');
    writeFileSync(htmlPath, updatedHtml);
    if (values.live || values.source) writeFileSync(sourcePath, source);
  } else {
    const saved = JSON.parse(readFileSync(jsonPath, 'utf8'));
    inspectMap(saved);
    assert.deepEqual(saved, graph, 'map.json расходится с исходной Mermaid-картой');
    assert.deepEqual(readEmbedded(html), saved, 'Встроенная карта расходится с map.json');
    assert.deepEqual(JSON.parse(readFileSync(schemaPath, 'utf8')), schema, 'JSON Schema устарела');
  }
  console.log(`${values.live ? 'Живая карта' : 'Mermaid'}: ${summary.sections} раздела, ${summary.nodes} узлов, ${summary.edges} переходов. ${values.write ? 'map.json, JSON Schema и HTML обновлены.' : 'Полное совпадение Mermaid → JSON → HTML.'}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
