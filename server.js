require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// =============================================
// BANCO DE DADOS (PostgreSQL no Render)
// =============================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      plan VARCHAR(50) NOT NULL,
      niche VARCHAR(255),
      tone VARCHAR(50) DEFAULT 'divertido',
      networks TEXT[] DEFAULT '{}',
      status VARCHAR(20) DEFAULT 'pending',
      posts_per_month INTEGER DEFAULT 15,
      created_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      caption TEXT NOT NULL,
      hashtags TEXT,
      network VARCHAR(50),
      emoji VARCHAR(10),
      scheduled_at TIMESTAMP,
      status VARCHAR(20) DEFAULT 'scheduled',
      published_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id),
      order_nsu VARCHAR(100) UNIQUE NOT NULL,
      amount INTEGER NOT NULL,
      plan VARCHAR(50) NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      paid_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS network_tokens (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      network VARCHAR(50) NOT NULL,
      access_token TEXT,
      page_id VARCHAR(100),
      username VARCHAR(100),
      status VARCHAR(20) DEFAULT 'active',
      connected_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(client_id, network)
    );
  `);
  console.log('Banco de dados inicializado com sucesso!');
}

// =============================================
// PLANOS DE VENDA
// =============================================
const PLANOS = {
  basico: {
    nome: 'Plano Basico',
    preco: 19700,      // R$197,00 em centavos
    posts: 15,
    redes: 2,
    descricao: 'SocialHub Basico - 15 posts/mes, 2 redes sociais'
  },
  pro: {
    nome: 'Plano Pro',
    preco: 39700,      // R$397,00 em centavos
    posts: 30,
    redes: 4,
    descricao: 'SocialHub Pro - 30 posts/mes, 4 redes sociais'
  },
  premium: {
    nome: 'Plano Premium',
    preco: 69700,      // R$697,00 em centavos
    posts: 60,
    redes: 6,
    descricao: 'SocialHub Premium - 60 posts/mes, todas as redes'
  }
};

// =============================================
// INFINITEPAY — GERAR LINK DE PAGAMENTO
// =============================================
app.post('/api/checkout/:plano', async (req, res) => {
  try {
    const { plano } = req.params;
    const { nome, email, nicho } = req.body;

    if (!PLANOS[plano]) {
      return res.status(400).json({ erro: 'Plano invalido. Use: basico, pro ou premium' });
    }

    if (!nome || !email) {
      return res.status(400).json({ erro: 'Nome e email sao obrigatorios' });
    }

    const planoDados = PLANOS[plano];
    const orderNsu = `socialhub-${plano}-${Date.now()}`;

    // Salvar ou atualizar cliente no banco
    const clienteResult = await pool.query(
      `INSERT INTO clients (name, email, plan, niche, posts_per_month, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT (email) DO UPDATE
       SET plan = $3, niche = $4, posts_per_month = $5, status = 'pending'
       RETURNING id`,
      [nome, email, plano, nicho || 'negocio local', planoDados.posts]
    );

    const clienteId = clienteResult.rows[0].id;

    // Registrar pagamento pendente
    await pool.query(
      `INSERT INTO payments (client_id, order_nsu, amount, plan)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (order_nsu) DO NOTHING`,
      [clienteId, orderNsu, planoDados.preco, plano]
    );

    // Criar link de pagamento na InfinityPay
    // Sua tag: socialhub (vem do .env INFINITEPAY_TAG)
    const ipResponse = await fetch('https://api.checkout.infinitepay.io/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handle: process.env.INFINITEPAY_TAG, // socialhub
        redirect_url: `${process.env.FRONTEND_URL}/obrigado?pedido=${orderNsu}&plano=${plano}`,
        webhook_url: `${process.env.BACKEND_URL}/webhook/pagamento`,
        order_nsu: orderNsu,
        items: [{
          quantity: 1,
          price: planoDados.preco,
          description: planoDados.descricao
        }]
      })
    });

    const ipData = await ipResponse.json();

    if (!ipData.url) {
      console.error('Erro InfinityPay:', ipData);
      return res.status(500).json({ erro: 'Erro ao gerar link de pagamento. Verifique sua InfiniteTag.' });
    }

    res.json({
      sucesso: true,
      checkout_url: ipData.url,
      order_nsu: orderNsu,
      plano: planoDados.nome,
      valor: `R$${(planoDados.preco / 100).toFixed(2)}`
    });

  } catch (err) {
    console.error('Erro no checkout:', err);
    res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
  }
});

// =============================================
// WEBHOOK — INFINITEPAY CONFIRMA PAGAMENTO
// =============================================
app.post('/webhook/pagamento', async (req, res) => {
  try {
    const { order_nsu, paid, amount } = req.body;
    console.log('Webhook recebido:', { order_nsu, paid, amount });

    if (paid) {
      const pagamento = await pool.query(
        'SELECT * FROM payments WHERE order_nsu = $1',
        [order_nsu]
      );

      if (pagamento.rows.length > 0) {
        const { client_id, plan } = pagamento.rows[0];

        // Calcular vencimento (1 mes a partir de hoje)
        const vencimento = new Date();
        vencimento.setMonth(vencimento.getMonth() + 1);

        // Ativar cliente
        await pool.query(
          `UPDATE clients SET status = 'active', expires_at = $1 WHERE id = $2`,
          [vencimento, client_id]
        );

        // Marcar pagamento como pago
        await pool.query(
          `UPDATE payments SET status = 'paid', paid_at = NOW() WHERE order_nsu = $1`,
          [order_nsu]
        );

        console.log(`Cliente ${client_id} ativado! Plano ${plan} ate ${vencimento.toLocaleDateString('pt-BR')}`);

        // Gerar primeiro lote de posts automaticamente
        await gerarPostsParaCliente(client_id);

        // Enviar email de boas-vindas (opcional — configure RESEND_API_KEY)
        if (process.env.RESEND_API_KEY) {
          await enviarEmailBoasVindas(client_id);
        }
      }
    }

    res.status(200).send('ok');

  } catch (err) {
    console.error('Erro no webhook:', err);
    res.status(200).send('ok'); // Sempre retorna 200 para InfinityPay
  }
});

// =============================================
// GERACAO AUTOMATICA DE POSTS COM IA (Claude)
// =============================================
async function gerarPostsParaCliente(clienteId) {
  try {
    const cliente = await pool.query('SELECT * FROM clients WHERE id = $1', [clienteId]);
    if (!cliente.rows.length) return;

    const { niche, tone, plan, posts_per_month } = cliente.rows[0];
    const quantidade = Math.min(posts_per_month || 15, 15); // Gera em lotes de 15

    const resposta = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `Crie ${quantidade} posts de redes sociais para um negocio de "${niche}".
Tom: ${tone || 'divertido e engajante'}.
Distribua entre Instagram, Facebook e outras redes relevantes.
Responda SOMENTE com JSON valido:
{"posts":[{"emoji":"🍕","legenda":"texto completo com emojis e CTA","hashtags":"#tag1 #tag2 #tag3 #tag4 #tag5","rede":"Instagram","dia_do_mes":${Math.floor(Math.random()*3)+1},"horario":"09:00"}]}`
        }]
      })
    });

    const dados = await resposta.json();
    const texto = dados.content?.[0]?.text?.replace(/```json|```/g, '').trim();
    const { posts } = JSON.parse(texto);

    // Agendar posts para os proximos 30 dias
    const agora = new Date();
    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const agendamento = new Date(agora);
      agendamento.setDate(agendamento.getDate() + Math.floor(i * (30 / posts.length)));
      const [hora, min] = (post.horario || '09:00').split(':');
      agendamento.setHours(parseInt(hora), parseInt(min), 0, 0);

      await pool.query(
        `INSERT INTO posts (client_id, caption, hashtags, network, emoji, scheduled_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [clienteId, post.legenda, post.hashtags, post.rede, post.emoji, agendamento]
      );
    }

    console.log(`${posts.length} posts gerados e agendados para o cliente ${clienteId}`);

  } catch (err) {
    console.error('Erro ao gerar posts:', err);
  }
}

// =============================================
// EMAIL DE BOAS-VINDAS (Resend — gratis)
// =============================================
async function enviarEmailBoasVindas(clienteId) {
  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const cliente = await pool.query('SELECT * FROM clients WHERE id = $1', [clienteId]);
    if (!cliente.rows.length) return;

    const { name, email, plan } = cliente.rows[0];

    await resend.emails.send({
      from: 'SocialHub <noreply@seudominio.com.br>',
      to: email,
      subject: `Bem-vindo ao SocialHub! Seus posts ja estao sendo criados 🚀`,
      html: `
        <h2>Ola, ${name}! 🎉</h2>
        <p>Seu plano <strong>${PLANOS[plan]?.nome}</strong> foi ativado com sucesso!</p>
        <p>Nossa IA ja esta gerando seus primeiros posts automaticamente.</p>
        <p>Acesse o painel: <a href="${process.env.FRONTEND_URL}/dashboard">Clique aqui</a></p>
        <br><p>Qualquer duvida, responda este email.</p>
        <p>— Equipe SocialHub</p>
      `
    });
  } catch (err) {
    console.error('Erro ao enviar email:', err);
  }
}

// =============================================
// AGENDADOR — PUBLICA POSTS AUTOMATICAMENTE
// Roda a cada minuto e verifica posts para publicar
// =============================================
cron.schedule('* * * * *', async () => {
  try {
    const agora = new Date();
    const posts = await pool.query(
      `SELECT p.*, c.name as client_name, c.email, c.networks
       FROM posts p
       JOIN clients c ON p.client_id = c.id
       WHERE p.scheduled_at <= $1 AND p.status = 'scheduled' AND c.status = 'active'`,
      [agora]
    );

    for (const post of posts.rows) {
      // Aqui voce adiciona as chamadas reais de cada rede social
      // Ex: publishToInstagram(post), publishToFacebook(post), etc.
      console.log(`[SCHEDULER] Publicando para ${post.client_name} no ${post.network}: ${post.caption?.slice(0, 50)}...`);

      await pool.query(
        `UPDATE posts SET status = 'published', published_at = NOW() WHERE id = $1`,
        [post.id]
      );
    }

    if (posts.rows.length > 0) {
      console.log(`[SCHEDULER] ${posts.rows.length} posts publicados.`);
    }
  } catch (err) {
    console.error('[SCHEDULER] Erro:', err);
  }
});

// =============================================
// ROTAS DA API
// =============================================

// Dashboard — metricas gerais
app.get('/api/dashboard', async (req, res) => {
  try {
    const [ativos, agendados, receita, totalClientes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM clients WHERE status = 'active'`),
      pool.query(`SELECT COUNT(*) FROM posts WHERE status = 'scheduled'`),
      pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE status = 'paid'`),
      pool.query(`SELECT COUNT(*) FROM clients`)
    ]);

    res.json({
      clientesAtivos: parseInt(ativos.rows[0].count),
      postsAgendados: parseInt(agendados.rows[0].count),
      receitaTotal: parseInt(receita.rows[0].total),
      totalClientes: parseInt(totalClientes.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Listar todos os clientes
app.get('/api/clientes', async (req, res) => {
  try {
    const clientes = await pool.query(
      `SELECT id, name, email, plan, niche, status, posts_per_month, created_at, expires_at
       FROM clients ORDER BY created_at DESC`
    );
    res.json(clientes.rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Posts de um cliente
app.get('/api/clientes/:id/posts', async (req, res) => {
  try {
    const posts = await pool.query(
      `SELECT * FROM posts WHERE client_id = $1 ORDER BY scheduled_at`,
      [req.params.id]
    );
    res.json(posts.rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Gerar posts manualmente para um cliente
app.post('/api/clientes/:id/gerar-posts', async (req, res) => {
  try {
    await gerarPostsParaCliente(parseInt(req.params.id));
    res.json({ sucesso: true, mensagem: 'Posts gerados e agendados com sucesso!' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Listar planos disponiveis (para pagina de vendas)
app.get('/api/planos', (req, res) => {
  res.json(PLANOS);
});

// Verificar status de um pagamento
app.get('/api/pagamento/:order', async (req, res) => {
  try {
    const pag = await pool.query(
      `SELECT p.*, c.name, c.email, c.status as cliente_status
       FROM payments p JOIN clients c ON p.client_id = c.id
       WHERE p.order_nsu = $1`,
      [req.params.order]
    );
    if (!pag.rows.length) return res.status(404).json({ erro: 'Pedido nao encontrado' });
    res.json(pag.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// =============================================
// ROTA PROXY — BUSCAR FOTO REAL (Pexels API)
// =============================================
app.get('/api/imagem', async (req, res) => {
  try {
    const q = req.query.q || 'business professional';
    const count = Math.min(parseInt(req.query.count)||1, 10);
    const resp = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=${count+3}&orientation=square`,
      { headers: { Authorization: process.env.PEXELS_API_KEY } }
    );
    const data = await resp.json();
    if (!data.photos?.length) return res.json({ url: null, urls: [] });
    const shuffled = data.photos.sort(() => Math.random()-0.5);
    const urls = shuffled.slice(0, count).map(p => p.src.large2x || p.src.large || p.src.original);
    res.json({ url: urls[0], urls });
  } catch (err) {
    res.json({ url: null, urls: [] });
  }
});

// Buscar fotos individuais para cada slide do carrossel
app.post('/api/imagens-slides', async (req, res) => {
  try {
    const { baseKeyword, slides } = req.body;
    const urls = [];
    for (const slide of (slides||[])) {
      // Extrair palavras-chave do slide + assunto base
      const slideWords = slide.replace(/[^a-zA-ZÀ-ú0-9 ]/g,' ').trim().split(' ').filter(w=>w.length>3).slice(0,3).join(' ');
      const q = (baseKeyword + ' ' + slideWords).trim().slice(0, 80);
      try {
        const resp = await fetch(
          `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=3&orientation=square`,
          { headers: { Authorization: process.env.PEXELS_API_KEY } }
        );
        const data = await resp.json();
        if (data.photos?.length) {
          const p = data.photos[Math.floor(Math.random()*data.photos.length)];
          urls.push(p.src.large2x || p.src.large || p.src.original);
        } else { urls.push(null); }
      } catch(e) { urls.push(null); }
    }
    res.json({ urls });
  } catch(err) {
    res.status(500).json({ urls: [] });
  }
});

// =============================================
// ROTA PROXY — GERAR CONTEUDO COM IA (Claude)
// Chamada pelo painel do cliente (evita expor API key no browser)
// =============================================
app.post('/api/gerar-conteudo', async (req, res) => {
  try {
    const { tipo, assunto, rede, nicho } = req.body;

    const prompts = {
      video: `Crie um roteiro de vídeo curto (60 segundos) para ${rede} sobre "${assunto||'meu negócio de '+nicho}". Nicho: ${nicho}.
Responda APENAS com JSON: {"legenda":"legenda do post com emojis","hashtags":"#tag1 #tag2 #tag3 #tag4 #tag5","roteiro":"Cena 1 (0-10s): descricao\\nCena 2 (10-25s): descricao\\nCena 3 (25-45s): produto ou depoimento\\nCena 4 (45-60s): CTA forte","dicas":"dicas de gravacao em 2 linhas"}`,
      carrossel: `Crie um carrossel de 5 slides para ${rede} sobre "${assunto||'dicas de '+nicho}". Nicho: ${nicho}.
Responda APENAS com JSON: {"legenda":"legenda do post com emojis e CTA","hashtags":"#tag1 #tag2 #tag3 #tag4 #tag5","slides":["Slide 1: titulo impactante","Slide 2: ponto principal 1","Slide 3: ponto principal 2","Slide 4: dica ou prova social","Slide 5: CTA direto"],"img_keywords":"palavras em ingles para imagem relevante"}`,
      stories: `Crie um Stories para ${rede} sobre "${assunto||nicho}". Nicho: ${nicho}.
Responda APENAS com JSON: {"legenda":"texto curto e direto com emojis","hashtags":"#tag1 #tag2 #tag3","slides":["Tela 1: gancho inicial","Tela 2: desenvolvimento","Tela 3: CTA com link"],"img_keywords":"palavras em ingles para imagem"}`,
      imagem: `Crie um post atrativo para ${rede} sobre "${assunto||nicho}". Nicho: ${nicho}. Tom: engajante com emojis e CTA forte.
Responda APENAS com JSON: {"emoji":"🎯","legenda":"legenda completa com emojis e chamada para acao","hashtags":"#tag1 #tag2 #tag3 #tag4 #tag5","img_keywords":"3 palavras em ingles para busca de imagem relevante ao post"}`
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompts[tipo] || prompts.imagem }]
      })
    });

    const data = await response.json();
    const raw = data.content?.[0]?.text?.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);
    res.json({ sucesso: true, conteudo: parsed });

  } catch (err) {
    console.error('Erro ao gerar conteudo:', err);
    res.status(500).json({ erro: 'Erro ao gerar conteúdo. Tente novamente.' });
  }
});


// =============================================
// TOKENS DAS REDES SOCIAIS
// =============================================
// Salvar token de uma rede
app.post('/api/clientes/:id/tokens', async (req, res) => {
  try {
    const { network, access_token, page_id, username } = req.body;
    await pool.query(
      `INSERT INTO network_tokens (client_id, network, access_token, page_id, username)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (client_id, network) DO UPDATE
       SET access_token=$3, page_id=$4, username=$5, connected_at=NOW()`,
      [req.params.id, network, access_token, page_id||null, username||null]
    );
    res.json({ sucesso: true });
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

// Listar tokens de um cliente
app.get('/api/clientes/:id/tokens', async (req, res) => {
  try {
    const tokens = await pool.query(
      `SELECT network, username, page_id, status, connected_at
       FROM network_tokens WHERE client_id=$1`,
      [req.params.id]
    );
    res.json(tokens.rows);
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

// Remover token de uma rede
app.delete('/api/clientes/:id/tokens/:network', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM network_tokens WHERE client_id=$1 AND network=$2',
      [req.params.id, req.params.network]
    );
    res.json({ sucesso: true });
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

// Health check (Render usa isso para saber se o servidor esta rodando)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), servico: 'SocialHub Backend' });
});

app.get('/', (req, res) => {
  res.json({ mensagem: 'SocialHub API rodando! 🚀', versao: '1.0.0' });
});

// =============================================
// INICIAR SERVIDOR
// =============================================
const PORTA = process.env.PORT || 3000;

initDB().then(() => {
  app.listen(PORTA, () => {
    console.log(`\n🚀 SocialHub backend rodando na porta ${PORTA}`);
    console.log(`📡 Webhook InfinityPay: ${process.env.BACKEND_URL}/webhook/pagamento`);
    console.log(`💳 InfinityPay Tag: ${process.env.INFINITEPAY_TAG}`);
    console.log(`🤖 IA de posts: ${process.env.ANTHROPIC_API_KEY ? 'Configurada' : 'FALTANDO KEY!'}\n`);
  });
}).catch(err => {
  console.error('Erro ao iniciar banco:', err);
  process.exit(1);
});

// =============================================
// TABELA OAUTH TOKENS (executar uma vez)
// =============================================
async function initOAuthTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      network VARCHAR(50) NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      extra_data JSONB,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(email, network)
    );
  `);
}

// Mapa temporário de estados OAuth (em produção usar Redis)
const oauthStates = new Map();

// =============================================
// META — INSTAGRAM + FACEBOOK OAUTH
// =============================================
app.get('/auth/meta', (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).send('Email obrigatorio');
  const state = Buffer.from(JSON.stringify({ email, ts: Date.now() })).toString('base64url');
  oauthStates.set(state, email);
  setTimeout(() => oauthStates.delete(state), 10 * 60 * 1000); // Expira em 10min
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    redirect_uri: `${process.env.BACKEND_URL}/auth/meta/callback`,
    scope: 'instagram_basic,instagram_content_publish,pages_manage_posts,pages_read_engagement,pages_show_list',
    state,
    response_type: 'code'
  });
  res.redirect(`https://www.facebook.com/dialog/oauth?${params}`);
});

app.get('/auth/meta/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const email = oauthStates.get(state);
  if (error || !email) return res.redirect(`${process.env.FRONTEND_URL}/socialhub-cliente.html?net=meta&ok=0`);
  try {
    const tokenResp = await fetch(
      `https://graph.facebook.com/v18.0/oauth/access_token?client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&redirect_uri=${encodeURIComponent(process.env.BACKEND_URL+'/auth/meta/callback')}&code=${code}`
    );
    const t = await tokenResp.json();
    if (!t.access_token) throw new Error('Token vazio');
    await pool.query(
      `INSERT INTO oauth_tokens (email, network, access_token, extra_data) VALUES ($1,$2,$3,$4)
       ON CONFLICT (email, network) DO UPDATE SET access_token=$3, extra_data=$4, created_at=NOW()`,
      [email, 'meta', t.access_token, JSON.stringify(t)]
    );
    oauthStates.delete(state);
    res.redirect(`${process.env.FRONTEND_URL}/socialhub-cliente.html?net=meta&ok=1`);
  } catch (e) {
    console.error('Meta OAuth error:', e);
    res.redirect(`${process.env.FRONTEND_URL}/socialhub-cliente.html?net=meta&ok=0&err=${encodeURIComponent(e.message)}`);
  }
});

// =============================================
// LINKEDIN OAUTH
// =============================================
app.get('/auth/linkedin', (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).send('Email obrigatorio');
  const state = Buffer.from(JSON.stringify({ email, ts: Date.now() })).toString('base64url');
  oauthStates.set(state, email);
  setTimeout(() => oauthStates.delete(state), 10 * 60 * 1000);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.LINKEDIN_CLIENT_ID,
    redirect_uri: `${process.env.BACKEND_URL}/auth/linkedin/callback`,
    scope: 'openid profile w_member_social',
    state
  });
  res.redirect(`https://www.linkedin.com/oauth/v2/authorization?${params}`);
});

app.get('/auth/linkedin/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const email = oauthStates.get(state);
  if (error || !email) return res.redirect(`${process.env.FRONTEND_URL}/socialhub-cliente.html?net=linkedin&ok=0`);
  try {
    const tokenResp = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: `${process.env.BACKEND_URL}/auth/linkedin/callback`, client_id: process.env.LINKEDIN_CLIENT_ID, client_secret: process.env.LINKEDIN_CLIENT_SECRET })
    });
    const t = await tokenResp.json();
    if (!t.access_token) throw new Error('Token vazio');
    const exp = new Date(Date.now() + (t.expires_in || 5184000) * 1000);
    await pool.query(
      `INSERT INTO oauth_tokens (email, network, access_token, expires_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (email, network) DO UPDATE SET access_token=$3, expires_at=$4, created_at=NOW()`,
      [email, 'linkedin', t.access_token, exp]
    );
    oauthStates.delete(state);
    res.redirect(`${process.env.FRONTEND_URL}/socialhub-cliente.html?net=linkedin&ok=1`);
  } catch (e) {
    res.redirect(`${process.env.FRONTEND_URL}/socialhub-cliente.html?net=linkedin&ok=0`);
  }
});

// =============================================
// TWITTER/X OAUTH 2.0
// =============================================
app.get('/auth/twitter', (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).send('Email obrigatorio');
  const state = Buffer.from(JSON.stringify({ email, ts: Date.now() })).toString('base64url');
  oauthStates.set(state, email);
  setTimeout(() => oauthStates.delete(state), 10 * 60 * 1000);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.TWITTER_CLIENT_ID,
    redirect_uri: `${process.env.BACKEND_URL}/auth/twitter/callback`,
    scope: 'tweet.read tweet.write users.read offline.access',
    state,
    code_challenge: 'challenge',
    code_challenge_method: 'plain'
  });
  res.redirect(`https://twitter.com/i/oauth2/authorize?${params}`);
});

app.get('/auth/twitter/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const email = oauthStates.get(state);
  if (error || !email) return res.redirect(`${process.env.FRONTEND_URL}/socialhub-cliente.html?net=twitter&ok=0`);
  try {
    const creds = Buffer.from(`${process.env.TWITTER_CLIENT_ID}:${process.env.TWITTER_CLIENT_SECRET}`).toString('base64');
    const tokenResp = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${creds}` },
      body: new URLSearchParams({ code, grant_type: 'authorization_code', redirect_uri: `${process.env.BACKEND_URL}/auth/twitter/callback`, code_verifier: 'challenge' })
    });
    const t = await tokenResp.json();
    if (!t.access_token) throw new Error('Token vazio');
    await pool.query(
      `INSERT INTO oauth_tokens (email, network, access_token, refresh_token) VALUES ($1,$2,$3,$4)
       ON CONFLICT (email, network) DO UPDATE SET access_token=$3, refresh_token=$4, created_at=NOW()`,
      [email, 'twitter', t.access_token, t.refresh_token||null]
    );
    oauthStates.delete(state);
    res.redirect(`${process.env.FRONTEND_URL}/socialhub-cliente.html?net=twitter&ok=1`);
  } catch (e) {
    res.redirect(`${process.env.FRONTEND_URL}/socialhub-cliente.html?net=twitter&ok=0`);
  }
});

// =============================================
// TIKTOK OAUTH
// =============================================
app.get('/auth/tiktok', (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).send('Email obrigatorio');
  const state = Buffer.from(JSON.stringify({ email, ts: Date.now() })).toString('base64url');
  oauthStates.set(state, email);
  setTimeout(() => oauthStates.delete(state), 10 * 60 * 1000);
  const params = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    redirect_uri: `${process.env.BACKEND_URL}/auth/tiktok/callback`,
    scope: 'user.info.basic,video.upload',
    response_type: 'code',
    state
  });
  res.redirect(`https://www.tiktok.com/auth/authorize/?${params}`);
});

app.get('/auth/tiktok/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const email = oauthStates.get(state);
  if (error || !email) return res.redirect(`${process.env.FRONTEND_URL}/socialhub-cliente.html?net=tiktok&ok=0`);
  try {
    const tokenResp = await fetch('https://open-api.tiktok.com/oauth/access_token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY, client_secret: process.env.TIKTOK_CLIENT_SECRET, code, grant_type: 'authorization_code' })
    });
    const t = await tokenResp.json();
    const token = t.data?.access_token;
    if (!token) throw new Error('Token vazio');
    await pool.query(
      `INSERT INTO oauth_tokens (email, network, access_token) VALUES ($1,$2,$3)
       ON CONFLICT (email, network) DO UPDATE SET access_token=$3, created_at=NOW()`,
      [email, 'tiktok', token]
    );
    oauthStates.delete(state);
    res.redirect(`${process.env.FRONTEND_URL}/socialhub-cliente.html?net=tiktok&ok=1`);
  } catch (e) {
    res.redirect(`${process.env.FRONTEND_URL}/socialhub-cliente.html?net=tiktok&ok=0`);
  }
});

// =============================================
// API — Verificar redes conectadas do cliente
// =============================================
app.get('/api/redes-conectadas', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.json({ redes: [] });
  try {
    const r = await pool.query(
      `SELECT network FROM oauth_tokens WHERE email = $1`, [email]
    );
    res.json({ redes: r.rows.map(row => row.network) });
  } catch(e) {
    res.json({ redes: [] });
  }
});

// Inicializar tabela OAuth ao subir
initOAuthTable().catch(console.error);
