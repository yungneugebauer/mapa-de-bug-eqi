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
  return { components: [], bugs: [], pages: [], logs: [] };
}

function normalize(state) {
  const s = state && typeof state === 'object' ? state : {};
  return {
    components: Array.isArray(s.components) ? s.components : [],
    bugs: Array.isArray(s.bugs) ? s.bugs : [],
    pages: Array.isArray(s.pages) ? s.pages : [],
    logs: Array.isArray(s.logs) ? s.logs : [],
  };
}

// Guarda no máximo os registros mais recentes, pra lista não crescer sem fim.
const MAX_LOGS = 300;

function addLog(state, entry) {
  state.logs.unshift({
    id: `log-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    at: Date.now(),
    ...entry,
  });
  if (state.logs.length > MAX_LOGS) state.logs.length = MAX_LOGS;
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

/**
 * Cópias de segurança automáticas.
 *
 * - `KEY:prev`  → como estava logo antes da última alteração
 * - `KEY:day:AAAA-MM-DD` → como estava no início de cada dia (guarda 30 dias)
 *
 * Servem para recuperar os dados se algo apagar o que não devia. Uma falha
 * no backup nunca impede a operação principal de acontecer.
 */
async function saveSnapshots(url, token, previousState) {
  try {
    const payload = JSON.stringify(previousState);

    // Cópia da última versão (permite desfazer o estrago mais recente)
    await upstash(url, token, ['SET', `${KEY}:prev`, payload]);

    // Snapshot do dia: só é criado se ainda não existir um para hoje,
    // preservando como os dados estavam no começo do dia.
    const today = new Date().toISOString().slice(0, 10);
    const dayKey = `${KEY}:day:${today}`;
    await upstash(url, token, ['SET', dayKey, payload, 'NX', 'EX', 60 * 60 * 24 * 30]);
  } catch (e) {
    console.error('Falha ao gravar backup (a operação principal segue normal):', e);
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
  'title', 'description', 'severity', 'status', 'image', 'os', 'browser',
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
    const bug = state.bugs.find(b => b.id === body.bugId);
    if (bug) {
      const comp = state.components.find(c => c.id === bug.componentId);
      addLog(state, {
        action: 'deleteBug',
        by: String(body.by || '').trim() || 'não informado',
        title: bug.title || '(sem título)',
        page: comp ? comp.page : '',
        format: comp ? comp.format : '',
        component: comp ? (comp.component || '') : '',
        reporter: bug.reporter || '',
        status: bug.status || '',
      });
    }
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
    const removedBugs = state.bugs.filter(b => compIds.includes(b.componentId));

    addLog(state, {
      action: 'deletePage',
      by: String(body.by || '').trim() || 'não informado',
      page: name,
      bugsRemoved: removedBugs.length,
      titles: removedBugs.slice(0, 10).map(b => b.title || '(sem título)'),
    });

    state.bugs = state.bugs.filter(b => !compIds.includes(b.componentId));
    state.components = state.components.filter(c => c.page !== name);
    state.pages = state.pages.filter(p => p !== name);
    return;
  }

  if (op === 'replaceAll') {
    // Usado só para manutenção (ex: zerar tudo). Sobrescreve os dados, mas
    // NÃO apaga o histórico — o log de exclusões é preservado de propósito.
    const next = normalize(body.state);
    state.components = next.components;
    state.bugs = next.bugs;
    state.pages = next.pages;
    addLog(state, {
      action: 'replaceAll',
      by: String(body.by || '').trim() || 'não informado',
    });
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
      // /api/data?backups=1 lista as cópias disponíveis
      // /api/data?restore=prev  ou  ?restore=2026-09-03  restaura uma cópia
      let query = {};
      try { query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams); } catch (e) {}

      if (query.backups) {
        const r = await upstash(url, token, ['KEYS', `${KEY}:*`]);
        const keys = (r.json && Array.isArray(r.json.result)) ? r.json.result : [];
        const list = [];
        for (const k of keys) {
          const g = await upstash(url, token, ['GET', k]);
          let counts = null;
          try {
            const v = JSON.parse(g.json.result);
            counts = { bugs: (v.bugs || []).length, components: (v.components || []).length, pages: (v.pages || []).length };
          } catch (e) {}
          list.push({ key: k, counts });
        }
        res.status(200).json({ backups: list });
        return;
      }

      if (query.restore) {
        const src = query.restore === 'prev' ? `${KEY}:prev` : `${KEY}:day:${query.restore}`;
        const g = await upstash(url, token, ['GET', src]);
        const raw = g.json ? g.json.result : null;
        if (!raw) {
          res.status(404).json({ error: `Cópia não encontrada: ${src}` });
          return;
        }
        const restored = normalize(JSON.parse(raw));
        const current = await readState(url, token);
        // Antes de restaurar, guarda o estado atual, pra ser possível voltar atrás
        await upstash(url, token, ['SET', `${KEY}:before-restore`, JSON.stringify(current)]);
        addLog(restored, {
          action: 'restore',
          by: 'restauração manual',
          from: src,
          before: { bugs: current.bugs.length, components: current.components.length, pages: current.pages.length },
          after: { bugs: restored.bugs.length, components: restored.components.length, pages: restored.pages.length },
        });
        await writeState(url, token, restored);
        res.status(200).json({ restored: src, counts: { bugs: restored.bugs.length, pages: restored.pages.length } });
        return;
      }

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

      // Cópia de como está ANTES da alteração — é isso que vira o backup.
      const snapshotBefore = JSON.parse(JSON.stringify(state));

      const before = { bugs: state.bugs.length, components: state.components.length, pages: state.pages.length };
      applyOperation(state, body);
      const after = { bugs: state.bugs.length, components: state.components.length, pages: state.pages.length };

      // Toda escrita é registrada, não só as exclusões. Se algum dia dados
      // sumirem sem ninguém ter apagado, o histórico mostra qual operação
      // reduziu os números e quando — foi o que faltou no incidente antigo.
      const isDeletion = body.op === 'deleteBug' || body.op === 'deletePage';
      if (!isDeletion) {
        const extra = {};
        if (body.op === 'createBug') {
          const comp = state.components.find(c => c.id === state.bugs[state.bugs.length - 1].componentId);
          extra.title = (body.bug && body.bug.title) || '';
          if (comp) { extra.page = comp.page; extra.format = comp.format; extra.component = comp.component || ''; }
        } else if (body.op === 'updateBug') {
          const bug = state.bugs.find(b => b.id === body.bugId);
          if (bug) {
            const comp = state.components.find(c => c.id === bug.componentId);
            extra.title = bug.title || '';
            if (comp) { extra.page = comp.page; extra.format = comp.format; extra.component = comp.component || ''; }
            // Se a alteração mexeu no status, registramos qual foi.
            if (body.fields && body.fields.status) extra.status = body.fields.status;
          }
        } else if (body.op === 'addPage') {
          extra.page = String(body.name || '').trim();
        }

        addLog(state, {
          action: body.op,
          by: String(body.by || '').trim() || '—',
          before,
          after,
          ...extra,
        });
      } else {
        // Nas exclusões o log detalhado já foi criado em applyOperation;
        // aqui só complementamos com os números.
        if (state.logs[0]) {
          state.logs[0].before = before;
          state.logs[0].after = after;
        }
      }

      // Guarda cópias de segurança do estado ANTERIOR, pra ser possível
      // recuperar caso alguma alteração apague o que não devia.
      await saveSnapshots(url, token, snapshotBefore);

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
