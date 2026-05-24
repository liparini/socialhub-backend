# SocialHub Backend 🚀

Sistema SaaS de gerenciamento automatico de redes sociais com IA.

## Tecnologias
- Node.js + Express (API REST)
- PostgreSQL (banco de dados)
- InfinityPay (pagamentos — sua tag: $socialhub)
- Claude AI (geracao automatica de posts)
- Resend (emails transacionais)

---

## Deploy no Render — Passo a Passo

### 1. Subir o codigo no GitHub
```bash
git init
git add .
git commit -m "SocialHub backend inicial"
git remote add origin https://github.com/SEU_USUARIO/socialhub-backend.git
git push -u origin main
```

### 2. Criar o banco de dados no Render
- No Render, clique em **New** > **Postgres**
- Nome: `socialhub-db`
- Plan: Free
- Clique em **Create Database**
- Copie a **Internal Database URL** (vai usar no passo 3)

### 3. Criar o Web Service no Render
- Clique em **New** > **Web Service**
- Conecte seu repositorio GitHub
- Configuracoes:
  - Name: `socialhub-backend`
  - Runtime: **Node**
  - Build Command: `npm install`
  - Start Command: `node server.js`
  - Plan: **Free**

### 4. Configurar variaveis de ambiente no Render
No Web Service criado, va em **Environment** e adicione:

| Variavel | Valor |
|---|---|
| `DATABASE_URL` | (cole a Internal URL do Postgres) |
| `INFINITEPAY_TAG` | `socialhub` |
| `ANTHROPIC_API_KEY` | sua chave em console.anthropic.com |
| `BACKEND_URL` | https://socialhub-backend.onrender.com |
| `FRONTEND_URL` | https://seusite.com.br |
| `RESEND_API_KEY` | sua chave em resend.com (opcional) |
| `NODE_ENV` | `production` |

### 5. Fazer o deploy
- Clique em **Deploy**
- Aguarde ~3 minutos
- Teste: acesse https://socialhub-backend.onrender.com/health

---

## Como funciona o pagamento

1. Cliente acessa sua pagina de vendas e escolhe o plano
2. Seu site chama: `POST /api/checkout/pro` com nome, email e nicho
3. O backend gera o link InfinityPay e redireciona o cliente
4. Cliente paga com Pix (zero taxa) ou cartao
5. InfinityPay envia webhook para `/webhook/pagamento`
6. Backend ativa o cliente e gera os primeiros posts automaticamente

---

## Endpoints principais

```
GET  /health                          — Verificar se o servidor esta rodando
GET  /api/planos                      — Listar planos disponiveis
POST /api/checkout/:plano             — Gerar link de pagamento
POST /webhook/pagamento               — Receber confirmacao da InfinityPay
GET  /api/dashboard                   — Metricas gerais
GET  /api/clientes                    — Listar clientes
GET  /api/clientes/:id/posts          — Posts de um cliente
POST /api/clientes/:id/gerar-posts    — Gerar posts com IA para um cliente
GET  /api/pagamento/:order            — Status de um pagamento
```

---

## Configurar InfinityPay

1. Abra o app InfinityPay
2. Va em Configuracoes > Checkout
3. Em **webhook_url** coloque: `https://socialhub-backend.onrender.com/webhook/pagamento`
4. Sua InfiniteTag ja e `socialhub` (confirmada na conta)

---

## Proximos passos
- Adicionar OAuth de cada rede social (Instagram Graph API, etc)
- Criar frontend de vendas (pagina com os planos)
- Configurar dominio proprio

Suporte: contato@carol.bhz.br
