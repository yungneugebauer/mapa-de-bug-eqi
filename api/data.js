// Função serverless da Vercel — guarda/lê os dados do Mapa de Bugs.
//
// Usa a API REST do Upstash Redis diretamente via fetch, sem precisar
// instalar nenhum pacote. As variáveis de ambiente são preenchidas
// automaticamente pela Vercel quando você adiciona a integração de
// armazenamento (Storage → Upstash/Redis) ao projeto.
//
// IMPORTANTE — por que existem "operações" aqui:
// Antes, o navegador mandava a base INTEIRA a cada salvamento. Se duas
// pessoas estivessem com a ferramenta aberta ao mesmo tempo, a segunda a
// salvar apagava o que a primeira tinha acabado de criar (ela gravava a
// cópia dela, que não conhecia o bug novo). Agora o navegador manda apenas
// a AÇÃO ("adicione este bug", "mude este status"), e é o servidor que lê o
// estado atual, aplica a mudança e grava. Assim ninguém sobrescreve o
// trabalho de ninguém.

const KEY = 'bughunter:store';

function getCredentials() {
  const env = process.env;

  // Tenta primeiro os nomes padrão (sem prefixo customizado)
  let url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || env.REDIS_URL;
  let token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return { url, token };

  // Fallback: a Vercel permite configurar um "Custom Environment Variable
  // Prefix" ao conectar o banco (ex: STORAGE_KV_REST_API_URL em vez de
  // KV_REST_API_URL). Em vez de depender de um nome fixo, procuramos por
  // qualquer variável cujo nome termine com o padrão esperado.
  const keys = Object.keys(env);

  if (!url) {
    const urlKey = keys.find(k => /(^|_)KV_REST_API_URL$/.test(k)) ||
      keys.find(k => /(^|_)REDIS_REST_URL$/.test(k) && !/READ_ONLY/i.test(k));
    if (urlKey) url = env[urlKey];
  }

  if (!token) {
    // Evita pegar a variável de "read only token" por engano — precisamos
    // do token com permissão de escrita (usado no SET).
    const tokenKey = keys.find(k => /(^|_)KV_REST_API_TOKEN$/.test(k) && !/READ_ONLY/i.test(k)) ||
      keys.find(k => /(^|_)REDIS_REST_TOKEN$/.test(k) && !/READ_ONLY/i.test(k));
    if (tokenKey) token = env[tokenKey];
  }

  return { url, token };
}

async function upstash(url, token, command) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* resposta não era JSON */ }
  return { ok: r.ok, status: r.status, text, json };
}

function emptyState() {
  return { components: [], bugs: [], pages: [] };
}

function normalize(state) {
  const s = state && typeof state === 'object' ? state : {};
  return {
    components: Array.isArray(s.components) ? s.components : [],
    bugs: Array.isArray(s.bugs) ? s.bugs : [],
    pages: Array.isArray(s.pages) ? s.pages : [],
  };
}

async function readState(url, token) {
  const r = await upstash(url, token, ['GET', KEY]);
  if (!r.ok) {
    const err = new Error('Falha ao ler do banco');
    err.detail = r.text;
    throw err;
  }
  const raw = r.json ? r.json.result : null;
  if (!raw) return emptyState();
  try {
    return normalize(JSON.parse(raw));
  } catch (e) {
    const err = new Error('Dado salvo no banco não é um JSON válido');
    err.detail = String(raw).slice(0, 300);
    throw err;
  }
}

async function writeState(url, token, state) {
  const r = await upstash(url, token, ['SET', KEY, JSON.stringify(state)]);
  if (!r.ok || (r.json && r.json.result !== 'OK')) {
    const err = new Error('Falha ao salvar no banco');
    err.detail = r.text;
    throw err;
  }
}

/** Acha o mapeamento (formato+página+componente) ou cria um novo. */
function findOrCreateComponent(state, comp) {
  const format = String(comp.format || '').trim();
  const page = String(comp.page || '').trim();
  const component = String(comp.component || '').trim();
  const norm = component.toLowerCase();

  let found = state.components.find(c =>
    c.format === format && c.page === page && String(c.component || '').trim().toLowerCase() === norm
  );
  if (found) return found;

  found = {
    id: comp.id || `c-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    format,
    page,
    component,
    createdAt: Date.now(),
  };
  state.components.push(found);
  return found;
}

/** Campos que o cliente pode gravar num bug — evita gravar lixo no banco. */
const BUG_FIELDS = [
  'title', 'description', 'severity', 'status', 'image',
  'resolution', 'resolvedAt', 'resolutionImage', 'resolvedBy',
  'notExistsReason', 'notExistsAt', 'notExistsImage', 'notExistsBy',
];

function applyFields(bug, fields) {
  if (!fields || typeof fields !== 'object') return;
  for (const key of BUG_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      bug[key] = fields[key];
    }
  }
}

/** Aplica a operação sobre o estado atual. Lança erro se a op for inválida. */
function applyOperation(state, body) {
  const op = body.op;

  if (op === 'createBug') {
    const comp = findOrCreateComponent(state, body.component || {});
    const incoming = body.bug || {};
    if (!incoming.title) throw Object.assign(new Error('Bug sem título'), { statusCode: 400 });
    const bug = {
      id: incoming.id || `b-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      componentId: comp.id,
      reporter: incoming.reporter || '',
      createdAt: incoming.createdAt || Date.now(),
      status: incoming.status || 'Aberto',
    };
    applyFields(bug, incoming);
    bug.componentId = comp.id; // garante o vínculo mesmo se veio no payload
    state.bugs.push(bug);
    return;
  }

  if (op === 'updateBug') {
    const bug = state.bugs.find(b => b.id === body.bugId);
    if (!bug) throw Object.assign(new Error('Bug não encontrado'), { statusCode: 404 });
    if (body.component) {
      const comp = findOrCreateComponent(state, body.component);
      bug.componentId = comp.id;
    }
    applyFields(bug, body.fields);
    return;
  }

  if (op === 'deleteBug') {
    state.bugs = state.bugs.filter(b => b.id !== body.bugId);
    return;
  }

  if (op === 'addPage') {
    const name = String(body.name || '').trim();
    if (!name) throw Object.assign(new Error('Página sem nome'), { statusCode: 400 });
    const exists = state.pages.some(p => p.toLowerCase() === name.toLowerCase());
    if (!exists) state.pages.push(name);
    return;
  }

  if (op === 'deletePage') {
    const name = String(body.name || '').trim();
    const compIds = state.components.filter(c => c.page === name).map(c => c.id);
    state.bugs = state.bugs.filter(b => !compIds.includes(b.componentId));
    state.components = state.components.filter(c => c.page !== name);
    state.pages = state.pages.filter(p => p !== name);
    return;
  }

  if (op === 'replaceAll') {
    // Usado só para manutenção (ex: zerar tudo). Sobrescreve o estado.
    const next = normalize(body.state);
    state.components = next.components;
    state.bugs = next.bugs;
    state.pages = next.pages;
    return;
  }

  throw Object.assign(new Error(`Operação desconhecida: ${op}`), { statusCode: 400 });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const { url, token } = getCredentials();

  if (!url || !token) {
    res.status(500).json({
      error:
        'Storage não configurado. No projeto da Vercel, vá em Storage e adicione a integração de banco de dados (Upstash/Redis), depois faça um novo deploy.',
    });
    return;
  }

  try {
    if (req.method === 'GET') {
      const state = await readState(url, token);
      res.status(200).json(state);
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = null; }
      }
      if (!body || typeof body !== 'object' || !body.op) {
        res.status(400).json({ error: 'Requisição inválida: faltou a operação.' });
        return;
      }

      // Lê o estado atual, aplica a mudança e grava. É isso que impede
      // uma pessoa de sobrescrever o que a outra acabou de criar.
      const state = await readState(url, token);
      applyOperation(state, body);
      await writeState(url, token, state);

      // Devolve o estado já atualizado, pra tela do usuário ficar em dia
      // com o que as outras pessoas fizeram nesse meio tempo.
      res.status(200).json(state);
      return;
    }

    res.status(405).json({ error: 'Método não permitido' });
  } catch (err) {
    console.error(err);
    const status = err.statusCode || 502;
    res.status(status).json({ error: err.message || 'Erro interno', detail: err.detail });
  }
};
