import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getGraphIssues, getUnweightedDistances } from '@statelyai/graph';
import { JSDOM } from 'jsdom';
import { z } from 'zod';

const id = z.string().min(1);
export const mapSchema = z.strictObject({
  $schema: z.literal('./map.schema.json'),
  schemaVersion: z.literal(1),
  mode: z.literal('directed'),
  data: z.strictObject({
    source: z.strictObject({
      url: z.url(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
      author: z.string(), license: z.literal('CC-BY-NC-SA-4.0')
    }),
    sections: z.array(z.strictObject({
      id, number: z.int().positive(), label: id, entryNodeId: id
    })).min(1)
  }),
  nodes: z.array(z.strictObject({ id, label: id, data: z.strictObject({ sectionId: id }) })).min(1),
  edges: z.array(z.strictObject({
    id, sourceId: id, targetId: id, label: z.string(),
    data: z.strictObject({ kind: z.enum(['solid', 'dotted']), order: z.int().nonnegative() })
  }))
});

export function validateMap(value) {
  const graph = mapSchema.parse(value);
  const issues = getGraphIssues(graph);
  assert.equal(issues.length, 0, issues.map(issue => issue.message).join('\n'));
  const sections = new Map();
  const numbers = new Set();
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  for (const section of graph.data.sections) {
    assert(!sections.has(section.id) && !numbers.has(section.number), `Повторный раздел: ${section.id}`);
    sections.set(section.id, section);
    numbers.add(section.number);
    assert.equal(nodes.get(section.entryNodeId)?.data.sectionId, section.id, `Неверный вход в раздел ${section.id}`);
  }
  for (const node of graph.nodes) assert(sections.has(node.data.sectionId), `Нет раздела для ${node.id}`);
  graph.edges.forEach((edge, index) => assert.equal(edge.data.order, index, `Нарушен порядок стрелок: ${edge.id}`));
  return graph;
}

export function inspectMap(value) {
  const graph = validateMap(value);
  const reachable = new Set();
  for (const section of graph.data.sections) {
    for (const nodeId of getUnweightedDistances(graph, section.entryNodeId).keys()) reachable.add(nodeId);
  }
  const unreachable = graph.nodes.filter(node => !reachable.has(node.id)).map(node => node.id);
  assert.equal(unreachable.length, 0, `Недостижимые узлы из входов разделов: ${unreachable.join(', ')}`);
  return { sections: graph.data.sections.length, nodes: graph.nodes.length, edges: graph.edges.length };
}

let environment;
let parseQueue = Promise.resolve();

async function convert(source, sourceUrl) {
  if (!environment) {
    const dom = new JSDOM('');
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    const { default: mermaid } = await import('mermaid');
    environment = { dom, mermaid };
  }
  const { dom, mermaid } = environment;
  mermaid.initialize({ startOnLoad: false, maxEdges: 10000, maxTextSize: 1000000, flowchart: { htmlLabels: false } });
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
  assert.equal(diagram.type, 'flowchart-v2', 'Ожидается Mermaid flowchart');
  const text = value => {
    const textarea = dom.window.document.createElement('textarea');
    textarea.innerHTML = String(value).replace(/<br\s*\/?\s*>/gi, '\n');
    return textarea.value;
  };
  const groups = diagram.db.getSubGraphs();
  const vertices = diagram.db.getVertices();
  const membership = new Map();
  const groupIds = new Set(groups.map(group => group.id));
  const declaredNodes = new Map();
  const entries = new Map();
  let currentGroup;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('%%')) continue;
    const group = line.match(/^subgraph\s+([^\s[\]]+)/);
    if (group) {
      assert(!currentGroup, 'Вложенные разделы не поддерживаются');
      currentGroup = group[1];
      assert(groupIds.has(currentGroup), `Неизвестный раздел: ${currentGroup}`);
    } else if (line === 'end') {
      currentGroup = undefined;
    } else {
      const declaration = line.match(/^([^\s[\]({>@]+)\s*(?:\[|\(|\{|>|@\{)/);
      if (!declaration || !vertices.has(declaration[1])) continue;
      const nodeId = declaration[1];
      assert(currentGroup, `Узел вне разделов: ${nodeId}`);
      assert(!declaredNodes.has(nodeId), `Повторное объявление узла: ${nodeId}`);
      declaredNodes.set(nodeId, vertices.get(nodeId));
      membership.set(nodeId, currentGroup);
      if (!entries.has(currentGroup)) entries.set(currentGroup, nodeId);
    }
  }
  for (const nodeId of vertices.keys()) assert(declaredNodes.has(nodeId), `Узел вне разделов или без явного объявления: ${nodeId}`);
  const sections = groups.map(group => {
    const title = text(group.title).match(/^(\d+)\.\s+(.+)$/);
    assert(title, `Нет номера и названия раздела: ${group.id}`);
    assert(entries.has(group.id), `Пустой раздел: ${group.id}`);
    return { id: group.id, number: Number(title[1]), label: title[2], entryNodeId: entries.get(group.id) };
  });
  const occurrences = new Map();
  const graph = {
    $schema: './map.schema.json',
    schemaVersion: 1,
    mode: 'directed',
    data: {
      source: {
        url: sourceUrl,
        sha256: createHash('sha256').update(source.replace(/\r\n?/g, '\n').trimEnd() + '\n').digest('hex'),
        author: 'Виктор Лиситчук', license: 'CC-BY-NC-SA-4.0'
      },
      sections
    },
    nodes: [...declaredNodes.values()].map(node => {
      assert(membership.has(node.id), `Узел вне разделов: ${node.id}`);
      return { id: node.id, label: text(node.text), data: { sectionId: membership.get(node.id) } };
    }),
    edges: diagram.db.getEdges().map((edge, order) => {
      assert.equal(edge.type, 'arrow_point', `Неподдерживаемое направление стрелки: ${edge.id}`);
      assert(['normal', 'dotted'].includes(edge.stroke), `Неподдерживаемый тип линии: ${edge.id}`);
      const label = text(edge.text || '');
      const kind = edge.stroke === 'dotted' ? 'dotted' : 'solid';
      const signature = JSON.stringify([edge.start, edge.end, label, kind]);
      const occurrence = (occurrences.get(signature) || 0) + 1;
      occurrences.set(signature, occurrence);
      const stableId = 'e-' + createHash('sha256').update(signature).digest('hex').slice(0, 24) + '-' + occurrence;
      return {
        id: edge.isUserDefinedId ? edge.id : stableId,
        sourceId: edge.start, targetId: edge.end, label, data: { kind, order }
      };
    })
  };
  inspectMap(graph);
  return graph;
}

export function parseMap(source, sourceUrl = 'https://konstantalab.ru/map') {
  const pending = parseQueue.then(() => convert(source, sourceUrl));
  parseQueue = pending.catch(() => {});
  return pending;
}

export function toWizardData(value) {
  const graph = validateMap(value);
  const sections = {}, entry = {}, nodes = Object.create(null);
  const sectionNumbers = new Map();
  for (const section of graph.data.sections) {
    sections[section.number] = section.label;
    entry[section.number] = section.entryNodeId;
    sectionNumbers.set(section.id, section.number);
  }
  for (const node of graph.nodes) nodes[node.id] = {
    id: node.id, s: sectionNumbers.get(node.data.sectionId), text: node.label, options: []
  };
  for (const edge of graph.edges) nodes[edge.sourceId].options.push({
    next: edge.targetId, label: edge.label, kind: edge.data.kind
  });
  return { sections, entry, nodes };
}

export function createJsonSchema() {
  return z.toJSONSchema(mapSchema, { target: 'draft-2020-12' });
}
