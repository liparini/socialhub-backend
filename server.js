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
    const resp = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=5&orientation=square`,
      { headers: { Authorization: process.env.PEXELS_API_KEY } }
    );
    const data = await resp.json();
    if (!data.photos?.length) {
      return res.json({ url: null });
    }
    const photo = data.photos[Math.floor(Math.random() * data.photos.length)];
    res.json({
      url: photo.src.large2x || photo.src.large || photo.src.original,
      photographer: photo.photographer,
      alt: photo.alt
    });
  } catch (err) {
    console.error('Erro Pexels:', err);
    res.json({ url: null });
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
