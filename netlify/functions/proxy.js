// Proxy serverless : valide le mot de passe admin côté serveur,
// puis appelle l'API GitHub avec le vrai token (jamais exposé au navigateur).

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'JSON invalide' }) }; }

  const { password, action, path, payload } = body;

  // Variables d'environnement Netlify (jamais visibles dans le code déployé)
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'pdnaura2026';
  const GH_TOKEN  = process.env.GH_TOKEN;
  const GH_OWNER  = process.env.GH_OWNER  || 'stephaneleprince-dotcom';
  const GH_REPO   = process.env.GH_REPO   || 'pdn-aura-2026';

  // Validation du mot de passe côté serveur
  if (!password || password !== ADMIN_PASSWORD) {
    return { statusCode: 401, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Mot de passe incorrect' }) };
  }

  if (!GH_TOKEN) {
    return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Variable GH_TOKEN non configurée sur Netlify' }) };
  }

  const ghHeaders = {
    'Authorization': `token ${GH_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'pdn-aura-proxy/1.0',
  };

  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`;

  try {
    let ghResp;
    if (action === 'get') {
      ghResp = await fetch(url, { headers: ghHeaders });
    } else if (action === 'put') {
      ghResp = await fetch(url, {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'main', ...payload }),
      });
    } else {
      return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Action inconnue : ' + action }) };
    }

    const text = await ghResp.text();
    return { statusCode: ghResp.status, headers: { ...cors, 'Content-Type': 'application/json' }, body: text };
  } catch (err) {
    return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};
