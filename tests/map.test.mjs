import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { parseMap, readEmbedded, toWizardData } from '../scripts/map.mjs';

const html = readFileSync(new URL('../algebra_wizard.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../docs/map-source.mmd', import.meta.url), 'utf8');
const embedded = readEmbedded(html);
const graph = toWizardData(embedded);
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];

class Element {
  constructor(tag = '') {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.events = {};
    this.textContent = '';
    const classes = new Set();
    this.classList = {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle(name, force = !classes.has(name)) {
        force ? classes.add(name) : classes.delete(name);
        return force;
      }
    };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback) { this.events[name] = callback; }
  click() { this.events.click?.(); }
  scrollIntoView() {}
}

function app(saved = null, data = embedded) {
  const elements = new Map();
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) elements.set(id, new Element());
  elements.get('map-data').textContent = JSON.stringify(data);
  const storage = new Map(saved ? [['algebra-wizard-state-v2', saved]] : []);
  const document = {
    getElementById: id => elements.get(id),
    createElement: tag => new Element(tag),
    createTextNode: text => ({ textContent: text }),
    documentElement: new Element(),
    addEventListener(name, callback) { this[name] = callback; }
  };
  const context = vm.createContext({
    document, window: {}, console,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    HTMLInputElement: class {}, HTMLTextAreaElement: class {}
  });
  vm.runInContext(script + '\nglobalThis.api={jump,move,backward,forward,summaryText,get path(){return path},get current(){return current}}', context);
  return { api: context.api, document, elements, storage, diagnostics: context.window.__algebraDiagnostics };
}

function options(instance) {
  return instance.elements.get('transitions').children.find(element => element.className === 'options')?.children ?? [];
}

test('все исходные узлы и стрелки совпадают, включая подписи и пунктир', async () => {
  assert.deepEqual(embedded, await parseMap(source));
  assert.deepEqual(embedded, JSON.parse(readFileSync(new URL('../map.json', import.meta.url), 'utf8')));
  const rawNodes = [...source.matchAll(/^\s*([^\s[\]]+)\[(.*)\]\r?$/gm)].filter(match => match[1] !== 'subgraph');
  assert.equal(rawNodes.length, embedded.nodes.length);
  assert.deepEqual(Object.keys(graph.nodes).sort(), rawNodes.map(match => match[1]).sort());
  for (const [, id, label] of rawNodes) {
    const text = label.replace(/^"|"$/g, '').split('<br>').join('\n');
    assert.equal(graph.nodes[id].text, text, id);
  }
  let section;
  const seenSections = new Set();
  for (const line of source.split(/\r?\n/)) {
    const group = line.trim().match(/^subgraph \w+\["(\d+)\. (.*)"\]$/);
    if (group) {
      section = Number(group[1]);
      assert.equal(graph.sections[section], group[2]);
    } else {
      const node = line.trim().match(/^([^\s[\]]+)\[(.*)\]$/);
      if (node) {
        assert.equal(graph.nodes[node[1]].s, section);
        if (!seenSections.has(section)) {
          assert.equal(graph.entry[section], node[1]);
          seenSections.add(section);
        }
      }
    }
  }
  assert.equal(seenSections.size, embedded.data.sections.length);
  const rawEdges = source.split(/\r?\n/).filter(line => /\s(?:-->|-\.->)/.test(line)).map(line => {
    const kind = line.includes('-.->') ? 'dotted' : 'solid';
    const [from, rest] = line.trim().split(/\s+(?:-->|-\.->)/);
    const parts = rest.trim().split('|');
    return [from, parts.at(-1).trim(), parts.length === 3 ? parts[1] : '', kind];
  });
  const actualEdges = Object.values(graph.nodes).flatMap(node => node.options.map(option => [node.id, option.next, option.label, option.kind]));
  assert.equal(actualEdges.length, embedded.edges.length);
  assert.deepEqual(actualEdges.map(JSON.stringify).sort(), rawEdges.map(JSON.stringify).sort());
  assert.deepEqual(embedded.edges.map(edge => [edge.sourceId, edge.targetId, edge.label, edge.data.kind]), rawEdges);
});

test('каждая кнопка выполняет ровно одну исходную стрелку и показывает правильный узел', () => {
  const instance = app();
  let count = 0;
  assert.equal(instance.diagnostics.missing.length, 0);
  for (const node of Object.values(graph.nodes)) {
    instance.api.jump(node.id);
    assert.equal(options(instance).length, node.options.length, node.id);
    const card = instance.elements.get('card');
    assert(!card.children.some(element => element.className === 'options'), 'Переходы должны находиться под карточкой');
    assert.equal(card.children[1].textContent + (card.children[2].textContent ? '\n' + card.children[2].textContent : ''), node.text);
    for (const [index, edge] of node.options.entries()) {
      instance.api.jump(node.id);
      const button = options(instance)[index];
      assert.equal(button.dataset.next, edge.next);
      assert.equal(button.dataset.kind, edge.kind);
      if (edge.label) assert.equal(button.attributes['aria-label'], edge.label);
      const [title, detail] = button.children[1].children;
      const target = graph.nodes[edge.next];
      const expectedDescription = edge.label ? target.text : target.text.split('\n').slice(1).join('\n');
      assert.equal(title.textContent, edge.label || target.text.split('\n')[0]);
      assert.equal(detail?.textContent || '', expectedDescription, 'Полное дополнение цели должно быть на кнопке');
      button.click();
      assert.equal(instance.api.path.length, 2);
      assert.equal(instance.api.path[1].id, edge.next, `${node.id} -> ${edge.next}`);
      assert.equal(instance.elements.get('card').children[1].textContent, graph.nodes[edge.next].text.split('\n')[0]);
      count++;
    }
  }
  assert.equal(count, embedded.edges.length);
});

test('все разделы открывают собственный первый узел карты', () => {
  const instance = app();
  const buttons = instance.elements.get('categories').children;
  assert.equal(buttons.length, embedded.data.sections.length);
  for (const button of buttons) {
    button.click();
    const section = embedded.data.sections.find(section => section.number === Number(button.dataset.section));
    assert.equal(instance.api.path[0].id, section === embedded.data.sections[0] ? 'QC' : section.entryNodeId);
    assert.equal(instance.api.path.length, 1);
  }
});

test('конечные узлы не получают автоматических переходов к контролю', () => {
  const instance = app();
  for (const node of Object.values(graph.nodes).filter(node => !node.options.length)) {
    instance.api.jump(node.id);
    assert.equal(options(instance).length, 0);
    assert.equal(instance.elements.get('transitions').hidden, true);
    instance.api.move(0);
    assert.equal(instance.api.path.length, 1);
    assert(instance.elements.get('card').children.some(element => element.textContent === 'В карте нет дальнейших переходов'));
  }
});

test('возвраты, циклы, восстановление длинного маршрута и выбор другой ветки', () => {
  const instance = app();
  instance.api.jump('LinQ1');
  for (let i = 0; i < 110; i++) {
    instance.api.move(graph.nodes.LinQ1.options.findIndex(edge => edge.next === 'LinAct1'));
    instance.api.move(graph.nodes.LinAct1.options.findIndex(edge => edge.next === 'LinQ1'));
  }
  const saved = instance.storage.get('algebra-wizard-state-v2');
  const restored = app(saved);
  assert.equal(restored.api.path.length, 221);
  assert.equal(restored.api.current, 220);
  restored.api.backward();
  restored.api.forward();
  assert.equal(restored.api.current, 220);
  restored.api.backward();
  restored.api.backward();
  assert(!restored.api.summaryText().split('Текущий узел:')[0].trim().split('\n').at(-1).includes(' → '));
  restored.api.move(graph.nodes.LinQ1.options.findIndex(edge => edge.next === 'LinQ2'));
  assert.equal(restored.api.path.length, 220);
  assert.equal(restored.api.path.at(-1).id, 'LinQ2');
  assert.match(restored.api.summaryText(), /Шаг 2:/);
});

test('сводка после возврата не добавляет ещё не пройденную стрелку', () => {
  const instance = app();
  instance.api.jump('LinAct1');
  instance.api.move(graph.nodes.LinAct1.options.findIndex(edge => edge.next === 'Hub'));
  instance.api.backward();
  assert(!instance.api.summaryText().includes('Преобразование Выражений'));
  const last = instance.elements.get('summaryList').children.at(-1);
  assert(!last.children.at(-1).textContent.includes('«'));
});

test('устаревший или поврежденный маршрут с отсутствующей стрелкой отклоняется', () => {
  for (const path of [[{ id: 'entry_complex' }], [{ id: 'Root', edge: 0 }, { id: 'CtrlEnd' }], [{ id: '__proto__' }], [null]]) {
    const instance = app(JSON.stringify({ path, current: 100 }));
    assert.equal(instance.api.path.length, 1);
    assert.equal(instance.api.path[0].id, 'QC');
    assert.equal(instance.api.current, 0);
  }
});

test('клавиши 1–9 используют те же стрелки, включая однозначное действие', () => {
  const instance = app();
  instance.document.keydown({ key: '1', target: {} });
  assert.equal(instance.api.path.at(-1).id, graph.nodes.QC.options[0].next);
  instance.api.jump('OlyQ1');
  instance.document.keydown({ key: '9', target: {} });
  assert.equal(instance.api.path.at(-1).id, graph.nodes.OlyQ1.options[8].next);
});

test('служебный старт пропускается при открытии, сбросе и выборе первого раздела', () => {
  const instance = app();
  const assertStart = () => {
    assert.equal(instance.api.current, 0);
    assert.equal(instance.api.path[0].id, 'QC');
    assert.equal(instance.elements.get('count').textContent, 'Шаг 01');
    assert.equal(instance.elements.get('back').disabled, true);
    assert(!instance.api.summaryText().includes('Корневой объект'));
  };
  assertStart();
  for (const button of [instance.elements.get('reset'), instance.elements.get('home'), instance.elements.get('categories').children[0]]) {
    instance.api.move(0);
    button.click();
    assertStart();
  }
  instance.api.move(0);
  instance.api.backward();
  assertStart();
  assert(embedded.nodes.some(node => node.id === 'Root'));
  assert(embedded.edges.some(edge => edge.sourceId === 'Root' && edge.targetId === 'QC'));
});

test('старые маршруты восстанавливаются без служебного начала и лишнего номера шага', () => {
  const paths = [
    { path: [{ id: 'Root' }], current: 0 },
    { path: [{ id: 'Root', edge: 0 }, { id: 'QC' }], current: 0 },
    { path: [{ id: 'Root', edge: 0 }, { id: 'QC' }], current: 1 },
    { path: [{ id: 'Root', edge: 0 }, { id: 'QC', edge: 0 }, { id: 'QF' }], current: 2 }
  ];
  for (const state of paths) {
    const instance = app(JSON.stringify(state));
    assert.equal(instance.api.path[0].id, 'QC');
    assert(!instance.api.path.some(step => step.id === 'Root'));
    assert.equal(instance.api.current, Math.max(0, state.current - 1));
    assert(!instance.api.summaryText().includes('Корневой объект'));
  }
});

test('без стартового блока и для содержательного первого узла пропуска нет', () => {
  const withoutRoot = structuredClone(embedded);
  withoutRoot.nodes = withoutRoot.nodes.filter(node => node.id !== 'Root');
  withoutRoot.edges = withoutRoot.edges.filter(edge => edge.sourceId !== 'Root');
  withoutRoot.data.sections[0].entryNodeId = 'QC';
  const direct = app(null, withoutRoot);
  assert.equal(direct.api.path[0].id, 'QC');
  direct.elements.get('home').click();
  assert.equal(direct.api.path[0].id, 'QC');
  const meaningful = structuredClone(embedded);
  meaningful.nodes.find(node => node.id === 'Root').label = 'Сначала запишите ОДЗ';
  assert.equal(app(null, meaningful).api.path[0].id, 'Root');
});

test('служебный блок определяется по смыслу, но развилка и возвраты не скрываются', () => {
  const renamed = structuredClone(embedded);
  const root = renamed.nodes.find(node => node.id === 'Root');
  root.id = 'Begin';root.label = 'Начало';
  renamed.data.sections[0].entryNodeId = 'Begin';
  renamed.edges.find(edge => edge.sourceId === 'Root').sourceId = 'Begin';
  assert.equal(app(null, renamed).api.path[0].id, 'QC');
  renamed.edges.push({ id: 'extra-branch', sourceId: 'Begin', targetId: 'QF', label: 'Другой путь', data: { kind: 'solid', order: renamed.edges.length } });
  assert.equal(app(null, renamed).api.path[0].id, 'Begin');
  renamed.edges.pop();
  renamed.edges.push({ id: 'return', sourceId: 'QC', targetId: 'Begin', label: '', data: { kind: 'solid', order: renamed.edges.length } });
  assert.equal(app(null, renamed).api.path[0].id, 'Begin');
});

test('неверный синтаксис и узлы вне разделов не пропускаются при импорте', async () => {
  for (const bad of ['A ??? B', 'Root --> Missing']) {
    await assert.rejects(parseMap(source + '\n' + bad));
  }
});
