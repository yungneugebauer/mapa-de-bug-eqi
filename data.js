// Função serverless da Vercel — guarda/lê os dados do Mapa de Bugs.
//
// Usa a API REST do Upstash Redis diretamente via fetch, sem precisar
// instalar nenhum pacote. As variáveis de ambiente abaixo são preenchidas
// automaticamente pela Vercel quando você adiciona a integração de
// armazenamento (Storage → Marketplace → Upstash for Redis) ao projeto.
//
// Como os dados ficam guardados aqui (fora do index.html), trocar a
// versão do arquivo no futuro NUNCA apaga o histórico — o arquivo é só a
// "tela"; quem guarda os bugs é este banco de dados.

const KEY = 'bughunter:store';

function getCredentials() {
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.REDIS_URL;
  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

module.exports = async function handler(req, res) {
  const { url, token } = getCredentials();

  if (!url || !token) {
    res.status(500).json({
      error:
        'Storage não configurado. No projeto da Vercel, vá em Storage e adicione a integração "Upstash for Redis" (Marketplace), depois faça um novo deploy.',
    });
    return;
  }

  try {
    if (req.method === 'GET') {
      const r = await fetch(`${url}/get/${KEY}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const detail = await r.text();
        res.status(502).json({ error: 'Falha ao ler do banco', detail });
        return;
      }
      const json = await r.json();
      const value = json.result ? JSON.parse(json.result) : { components: [], bugs: [] };
      res.status(200).json(value);
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch (e) {
          body = null;
        }
      }
      if (!body || typeof body !== 'object') {
        res.status(400).json({ error: 'Corpo da requisição inválido' });
        return;
      }

      const serialized = JSON.stringify(body);
      const r = await fetch(`${url}/set/${KEY}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'text/plain',
        },
        body: serialized,
      });
      if (!r.ok) {
        const detail = await r.text();
        res.status(502).json({ error: 'Falha ao salvar no banco', detail });
        return;
      }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Método não permitido' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno', detail: String(err) });
  }
};
