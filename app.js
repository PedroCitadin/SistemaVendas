require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const { spawn } = require('child_process');
const multer = require('multer');
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');

// === Segurança e Sessão ===
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const port = process.env.PORT || 3000;

// Configuração do banco PostgreSQL
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// Express
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');

// Segurança básica (headers)
app.use(helmet({
  contentSecurityPolicy: false, // deixe false se não configurar CSP nas views
}));

// Rate limit simples nas rotas de auth
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutos
  max: 50,
});




// Sessão (armazenada no Postgres)
app.use(session({
  store: new PgSession({
    pool,
    tableName: 'session',
    schemaName: 'public',          // opcional, caso use outro schema troque aqui
    createTableIfMissing: true     // <— cria a tabela automaticamente
  }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 8,
    sameSite: 'lax',
    secure: false
  }
}));


// Upload
const upload = multer({ dest: 'uploads/' });

// --------- Helpers ---------
function cleanAndValidateCPF(cpf) {
  const cleanedCPF = (cpf || '').replace(/[\.-]/g, '').trim();
  if (!cleanedCPF.match(/^\d{11}$/)) {
    throw new Error('CPF inválido. Deve conter 11 dígitos numéricos.');
  }
  return cleanedCPF;
}

async function getUsersCount() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS total FROM usuarios');
  return rows[0].total;
}

function getPreco(produto) {
  const preco = Number(produto.valor_venda || produto.valor_unitario || 0);
  return preco.toFixed(2);
}

// barcode sempre 12 dígitos, baseado no id
function formatBarcodeFromId(id) {
  const s = String(id || '');
  if (!/^\d+$/.test(s)) {
    return s.padStart(12, '0').slice(-12);
  }
  return s.padStart(12, '0').slice(-12);
}

// Deixa o usuário atual disponível nas views
app.use((req, res, next) => {
  res.locals.usuario = req.session?.usuario || null; // {id, nome, email, role}
  next();
});

// Middleware para proteger rotas
function requireAuth(req, res, next) {
  if (req.session && req.session.usuario) return next();
  return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl || '/'));
}

// Middleware para permitir somente admin (se quiser usar em alguma rota)
function requireAdmin(req, res, next) {
  if (req.session?.usuario?.role === 'admin') return next();
  return res.status(403).send('Acesso negado: requer perfil administrador.');
}

// ======== Rotas de Autenticação ========

// Primeira configuração: cria admin se NÃO existir nenhum usuário
app.get('/setup-admin', async (req, res) => {
  try {
    const total = await getUsersCount();
    if (total > 0) return res.redirect('/login');

    const hasEnvKey = !!process.env.ADMIN_SETUP_KEY;
    if (!hasEnvKey) {
      // Segurança: se a chave não estiver configurada, não permite configurar
      return res.status(403).send('Configuração bloqueada: defina ADMIN_SETUP_KEY no .env.');
    }

    // Renderiza formulário com campo para a chave
    res.render('setup-admin', { error: '', requireKey: true });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro interno.');
  }
});

app.post('/setup-admin', async (req, res) => {
  try {
    const total = await getUsersCount();
    if (total > 0) return res.redirect('/login');

    const hasEnvKey = !!process.env.ADMIN_SETUP_KEY;
    if (!hasEnvKey) {
      return res.status(403).send('Configuração bloqueada: defina ADMIN_SETUP_KEY no .env.');
    }

    const { nome, email, senha, setup_key } = req.body;

    if (!setup_key || setup_key !== process.env.ADMIN_SETUP_KEY) {
      return res.render('setup-admin', { error: 'Chave de acesso inválida.', requireKey: true });
    }

    if (!nome || !email || !senha) {
      return res.render('setup-admin', { error: 'Preencha todos os campos.', requireKey: true });
    }

    const hash = await bcrypt.hash(senha, 12);
    const insert = await pool.query(
      'INSERT INTO usuarios (nome, email, senha_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, nome, email, role',
      [nome, email.toLowerCase(), hash, 'admin']
    );
    req.session.usuario = insert.rows[0];
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.render('setup-admin', { error: 'Erro ao criar admin: ' + err.message, requireKey: true });
  }
});

// --------- Usuários (somente admin) ---------
app.get('/usuarios/novo', requireAuth, requireAdmin, (req, res) => {
  res.render('usuarios-novo', { error: '' });
});

app.post('/usuarios/novo', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { nome, email, senha, role } = req.body;

    if (!nome || !email || !senha) {
      return res.render('usuarios-novo', { error: 'Preencha todos os campos.' });
    }

    const hash = await bcrypt.hash(senha, 12);

    await pool.query(
      'INSERT INTO usuarios (nome, email, senha_hash, role) VALUES ($1, $2, $3, $4)',
      [nome, email.toLowerCase(), hash, role || 'user']
    );

    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.render('usuarios-novo', { error: 'Erro ao criar usuário: ' + err.message });
  }
});


// ======== Perfil do usuário (autogerenciado) ========

// pequeno limitador p/ trocas sensíveis
const perfilLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 min
  max: 60
});

// utilitário rápido
async function getUserById(id) {
  const { rows } = await pool.query(
    'SELECT id, nome, email, senha_hash, role FROM usuarios WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}

// Tela de perfil
app.get('/perfil', requireAuth, async (req, res) => {
  res.render('perfil', {
    usuario: req.session.usuario,
    msg: req.query.msg || '',
    err: req.query.err || ''
  });
});

// Atualizar e-mail (exige senha atual)
app.post('/perfil/email', requireAuth, perfilLimiter, async (req, res) => {
  try {
    const { email, senha_atual } = req.body;
    if (!email || !senha_atual) {
      return res.redirect('/perfil?err=' + encodeURIComponent('Preencha e-mail e senha atual.'));
    }

    const user = await getUserById(req.session.usuario.id);
    if (!user) return res.redirect('/logout');

    const ok = await bcrypt.compare(senha_atual, user.senha_hash);
    if (!ok) {
      return res.redirect('/perfil?err=' + encodeURIComponent('Senha atual incorreta.'));
    }

    // checa se e-mail já está em uso por outro usuário
    const { rows: exists } = await pool.query(
      'SELECT 1 FROM usuarios WHERE email = $1 AND id <> $2',
      [email.toLowerCase(), user.id]
    );
    if (exists.length > 0) {
      return res.redirect('/perfil?err=' + encodeURIComponent('E-mail já está em uso por outro usuário.'));
    }

    await pool.query(
      'UPDATE usuarios SET email = $1, updated_at = NOW() WHERE id = $2',
      [email.toLowerCase(), user.id]
    );

    // atualiza sessão
    req.session.usuario.email = email.toLowerCase();

    return res.redirect('/perfil?msg=' + encodeURIComponent('E-mail atualizado com sucesso.'));
  } catch (e) {
    console.error(e);
    return res.redirect('/perfil?err=' + encodeURIComponent('Erro ao atualizar e-mail.'));
  }
});

// Atualizar senha (exige senha atual + confirmação)
app.post('/perfil/senha', requireAuth, perfilLimiter, async (req, res) => {
  try {
    const { senha_atual, nova_senha, confirmar_senha } = req.body;
    if (!senha_atual || !nova_senha || !confirmar_senha) {
      return res.redirect('/perfil?err=' + encodeURIComponent('Preencha todos os campos de senha.'));
    }
    if (nova_senha.length < 6) {
      return res.redirect('/perfil?err=' + encodeURIComponent('A nova senha deve ter ao menos 6 caracteres.'));
    }
    if (nova_senha !== confirmar_senha) {
      return res.redirect('/perfil?err=' + encodeURIComponent('A confirmação não coincide com a nova senha.'));
    }

    const user = await getUserById(req.session.usuario.id);
    if (!user) return res.redirect('/logout');

    const ok = await bcrypt.compare(senha_atual, user.senha_hash);
    if (!ok) {
      return res.redirect('/perfil?err=' + encodeURIComponent('Senha atual incorreta.'));
    }

    const hash = await bcrypt.hash(nova_senha, 12);
    await pool.query(
      'UPDATE usuarios SET senha_hash = $1, updated_at = NOW() WHERE id = $2',
      [hash, user.id]
    );

    return res.redirect('/perfil?msg=' + encodeURIComponent('Senha atualizada com sucesso.'));
  } catch (e) {
    console.error(e);
    return res.redirect('/perfil?err=' + encodeURIComponent('Erro ao atualizar senha.'));
  }
});


// Login
app.get('/login', (req, res) => {
  if (req.session?.usuario) return res.redirect('/');
  res.render('login', { error: '', nextUrl: req.query.next || '' });
});

app.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, senha, nextUrl } = req.body;
    if (!email || !senha) {
      return res.render('login', { error: 'Informe e-mail e senha.', nextUrl: nextUrl || '' });
    }
    const { rows } = await pool.query(
      'SELECT id, nome, email, senha_hash, role FROM usuarios WHERE email = $1',
      [email.toLowerCase()]
    );
    if (rows.length === 0) {
      return res.render('login', { error: 'Usuário ou senha inválidos.', nextUrl: nextUrl || '' });
    }
    const user = rows[0];
    const ok = await bcrypt.compare(senha, user.senha_hash);
    if (!ok) {
      return res.render('login', { error: 'Usuário ou senha inválidos.', nextUrl: nextUrl || '' });
    }
    // salva na sessão (sem hash)
    req.session.usuario = { id: user.id, nome: user.nome, email: user.email, role: user.role };
    res.redirect(nextUrl || '/');
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Erro ao autenticar: ' + err.message, nextUrl: req.body.nextUrl || '' });
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// ======== A partir daqui, tudo protegido ========

// Rota inicial (protegida)
app.get('/', requireAuth, (req, res) => {
  res.render('index'); // sua página principal já existente
});

// --------- Produtos ---------
app.get('/produtos', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.nome, p.barcode, p.valor_unitario, p.valor_venda, p.descricao, e.quantidade, p.etiquetas_impressas
      FROM produtos p
      LEFT JOIN estoque e ON p.id = e.id_produto
      ORDER BY p.nome ASC
    `);
    res.render('produtos', { produtos: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao listar produtos');
  }
});

app.post('/produtos', requireAuth, async (req, res) => {
  const { nome,  valor_unitario, valor_venda, descricao, quantidade } = req.body;
  try {
    await pool.query('BEGIN');

    const produtoResult = await pool.query(
      'INSERT INTO produtos (nome, barcode, valor_unitario, valor_venda, descricao) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [nome, null, valor_unitario, valor_venda || null, descricao || null]
    );
    const id_produto = produtoResult.rows[0].id;

    const forcedBarcode = formatBarcodeFromId(id_produto);
    await pool.query(
      'UPDATE produtos SET barcode = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [forcedBarcode, id_produto]
    );

    await pool.query(
      'INSERT INTO estoque (id_produto, quantidade) VALUES ($1, $2)',
      [id_produto, parseInt(quantidade) || 0]
    );

    await pool.query('COMMIT');
    res.redirect('/produtos');
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error(err);
    res.status(500).send('Erro ao adicionar produto: ' + err.message);
  }
});

app.post('/produtos/editar/:id', requireAuth, async (req, res) => {
  const { nome,  valor_unitario, valor_venda, descricao, quantidade } = req.body;
  try {
    await pool.query('BEGIN');

    const id = req.params.id;
    const forcedBarcode = formatBarcodeFromId(id);

    await pool.query(
      'UPDATE produtos SET nome = $1, barcode = $2, valor_unitario = $3, valor_venda = $4, descricao = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6',
      [nome, forcedBarcode, valor_unitario, valor_venda || null, descricao || null, id]
    );

    await pool.query(
      'UPDATE estoque SET quantidade = $1, updated_at = CURRENT_TIMESTAMP WHERE id_produto = $2',
      [parseInt(quantidade) || 0, id]
    );

    await pool.query('COMMIT');
    res.redirect('/produtos');
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error(err);
    res.status(500).send('Erro ao editar produto: ' + err.message);
  }
});

app.post('/produtos/deletar/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM produtos WHERE id = $1', [req.params.id]);
    res.redirect('/produtos');
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao deletar produto: ' + err.message);
  }
});

app.get('/produtos/buscar', requireAuth, async (req, res) => {
  try {
    const barcode = req.query.barcode || '';
    if (!barcode) {
      return res.status(400).json({ error: 'Código de barras é obrigatório' });
    }
    const result = await pool.query(
      `SELECT p.id, p.nome, p.barcode, p.valor_venda, p.valor_unitario, e.quantidade, p.etiquetas_impressas AS estoque
       FROM produtos p
       LEFT JOIN estoque e ON p.id = e.id_produto
       WHERE p.barcode = $1 order by p.nome`,
      [barcode]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }
    const produto = result.rows[0];
    res.json({
      id: produto.id,
      nome: produto.nome,
      barcode: produto.barcode,
      preco: getPreco(produto),
      estoque: produto.estoque || 0,
      etiquetas_impressas: produto.etiquetas_impressas
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar produto: ' + err.message });
  }
});

app.get('/produtos/etiqueta/:id', requireAuth, async (req, res) => {
  try {
    const produtoId = req.params.id;

    const result = await pool.query(
      `SELECT p.id, p.nome, p.barcode, p.valor_venda, p.valor_unitario, COALESCE(e.quantidade, 0) AS quantidade
       FROM produtos p
       LEFT JOIN estoque e ON p.id = e.id_produto
       WHERE p.id = $1`,
      [produtoId]
    );

    if (result.rows.length === 0) {
      throw new Error('Produto não encontrado');
    }

    const produto = result.rows[0];
    const barcode = formatBarcodeFromId(produto.id);

    const qParam = Number(req.query.quantidade);
    let quantidade = Number.isFinite(qParam) ? qParam : Number(produto.quantidade) || 0;
    quantidade = Math.max(1, Math.trunc(quantidade));

    const nome = (produto.nome || '').substring(0, 30);
    const preco = getPreco(produto);

    let prnContent = '';
    for (let i = 0; i < quantidade; i++) {
      prnContent += `L
   D11
    122100000950020${nome}
    121100000650020R$ ${preco}
    1D0004000100040${barcode}
    ^01
    Q0001
   E


`;
    }
    await pool.query(
      'UPDATE produtos SET etiquetas_impressas = true WHERE id = $1',
      [produtoId]
    );

    
    res.setHeader('Content-Disposition', `attachment; filename=etiqueta_${produtoId}.prn`);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(prnContent);

  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao gerar etiqueta: ' + err.message);
  }
});

app.post('/produtos/toggle-impresso/:id', async (req, res) => {
  try {
    const produtoId = req.params.id;

    // Pega status atual
    const result = await pool.query(
      'SELECT etiquetas_impressas FROM produtos WHERE id = $1',
      [produtoId]
    );

    if (result.rows.length === 0) {
      return res.status(404).send('Produto não encontrado');
    }

    const atual = result.rows[0].etiquetas_impressas;
    const novoStatus = !atual; // inverte

    await pool.query(
      'UPDATE produtos SET etiquetas_impressas = $1 WHERE id = $2',
      [novoStatus, produtoId]
    );

    res.redirect('/produtos');
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao atualizar status de impressão');
  }
});



// --------- Clientes ---------
app.get('/clientes', requireAuth, async (req, res) => {
  try {
    const search = req.query.search || '';
    const error = req.query.error || '';
    const formData = req.query.formData ? JSON.parse(decodeURIComponent(req.query.formData)) : {};
    let query = 'SELECT * FROM clientes';
    let queryParams = [];
    if (search) {
      const cleanedSearch = search.replace(/[\.-]/g, '').trim();
      query += ' WHERE nome ILIKE $1 OR email ILIKE $1 OR cpf ILIKE $2';
      queryParams.push(`%${search}%`, `%${cleanedSearch}%`);
    }
    const result = await pool.query(query, queryParams);
    res.render('clientes', { clientes: result.rows, search, error, formData });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao listar clientes');
  }
});

app.post('/clientes', requireAuth, async (req, res) => {
  const { nome, cpf, email, telefone, endereco } = req.body;
  try {
    if (!nome) throw new Error('Nome é obrigatório');
    const cleanedCPF = cleanAndValidateCPF(cpf);
    const cpfCheck = await pool.query('SELECT id FROM clientes WHERE cpf = $1', [cleanedCPF]);
    if (cpfCheck.rows.length > 0) {
      const formData = { nome, cpf, email, telefone, endereco };
      return res.redirect(`/clientes?error=${encodeURIComponent('CPF já cadastrado')}&formData=${encodeURIComponent(JSON.stringify(formData))}`);
    }
    await pool.query(
      'INSERT INTO clientes (nome, cpf, email, telefone, endereco) VALUES ($1, $2, $3, $4, $5)',
      [nome, cleanedCPF, email || null, telefone || null, endereco || null]
    );
    res.redirect('/clientes');
  } catch (err) {
    console.error(err);
    const formData = { nome, cpf, email, telefone, endereco };
    res.redirect(`/clientes?error=${encodeURIComponent(err.message)}&formData=${encodeURIComponent(JSON.stringify(formData))}`);
  }
});

app.post('/clientes/editar/:id', requireAuth, async (req, res) => {
  const { nome, cpf, email, telefone, endereco } = req.body;
  try {
    if (!nome) throw new Error('Nome é obrigatório');
    const cleanedCPF = cleanAndValidateCPF(cpf);
    const cpfCheck = await pool.query('SELECT id FROM clientes WHERE cpf = $1 AND id != $2', [cleanedCPF, req.params.id]);
    if (cpfCheck.rows.length > 0) {
      const formData = { nome, cpf, email, telefone, endereco };
      return res.redirect(`/clientes?error=${encodeURIComponent('CPF já cadastrado para outro cliente')}&formData=${encodeURIComponent(JSON.stringify(formData))}`);
    }
    await pool.query(
      'UPDATE clientes SET nome = $1, cpf = $2, email = $3, telefone = $4, endereco = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6',
      [nome, cleanedCPF, email || null, telefone || null, endereco || null, req.params.id]
    );
    res.redirect('/clientes');
  } catch (err) {
    console.error(err);
    const formData = { nome, cpf, email, telefone, endereco };
    res.redirect(`/clientes?error=${encodeURIComponent(err.message)}&formData=${encodeURIComponent(JSON.stringify(formData))}`);
  }
});

app.post('/clientes/deletar/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM clientes WHERE id = $1', [req.params.id]);
    res.redirect('/clientes');
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao deletar cliente: ' + err.message);
  }
});

app.get('/clientes/buscar', requireAuth, async (req, res) => {
  try {
    const search = req.query.search || '';
    const cleanedSearch = search.replace(/[\.-]/g, '').trim();
    const result = await pool.query(
      'SELECT id, nome, cpf FROM clientes WHERE nome ILIKE $1 OR email ILIKE $1 OR cpf ILIKE $2 LIMIT 10',
      [`%${search}%`, `%${cleanedSearch}%`]
    );
    res.json(result.rows.map(cliente => ({
      id: cliente.id,
      nome: cliente.nome,
      cpf: cliente.cpf ? cliente.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : ''
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar clientes: ' + err.message });
  }
});

app.post('/clientes/novo', requireAuth, async (req, res) => {
  const { nome, cpf, email, telefone, endereco } = req.body;
  try {
    if (!nome) throw new Error('Nome é obrigatório');
    const cleanedCPF = cleanAndValidateCPF(cpf);
    const cpfCheck = await pool.query('SELECT id FROM clientes WHERE cpf = $1', [cleanedCPF]);
    if (cpfCheck.rows.length > 0) throw new Error('CPF já cadastrado');

    const result = await pool.query(
      'INSERT INTO clientes (nome, cpf, email, telefone, endereco) VALUES ($1, $2, $3, $4, $5) RETURNING id, nome, cpf',
      [nome, cleanedCPF, email || null, telefone || null, endereco || null]
    );
    const cliente = result.rows[0];
    res.json({
      id: cliente.id,
      nome: cliente.nome,
      cpf: cliente.cpf ? cliente.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : ''
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// --------- Vendas ---------
app.get('/vendas', requireAuth, async (req, res) => {
  try {
    const vendasResult = await pool.query(`
      SELECT v.id, v.data_venda, v.total, c.nome AS cliente_nome
      FROM vendas v
      LEFT JOIN clientes c ON v.id_cliente = c.id
      ORDER BY v.id DESC
    `);
    res.render('vendas', {
      vendas: vendasResult.rows,
      error: req.query.error || '',
      formData: req.query.formData ? JSON.parse(decodeURIComponent(req.query.formData)) : {}
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao listar vendas');
  }
});

app.post('/vendas', requireAuth, async (req, res) => {
  const { id_cliente, itens } = req.body;
  try {
    if (!itens || !Array.isArray(itens) || itens.length === 0) {
      throw new Error('Nenhum item adicionado à venda');
    }
    await pool.query('BEGIN');

    const vendaResult = await pool.query(
      'INSERT INTO vendas (id_cliente, total) VALUES ($1, $2) RETURNING id',
      [id_cliente || null, 0]
    );
    const id_venda = vendaResult.rows[0].id;
    let total = 0;

    for (const item of itens) {
      if (!item.barcode || !item.quantidade) {
        throw new Error('Código de barras ou quantidade inválida');
      }
      const quantidade = parseInt(item.quantidade);
      if (isNaN(quantidade) || quantidade <= 0) {
        throw new Error(`Quantidade inválida para o item com código ${item.barcode}`);
      }

      const produtoResult = await pool.query(
        `SELECT p.id, p.nome, p.valor_venda, p.valor_unitario, e.quantidade AS estoque
         FROM produtos p
         LEFT JOIN estoque e ON p.id = e.id_produto
         WHERE p.barcode = $1`,
        [item.barcode]
      );
      if (produtoResult.rows.length === 0) {
        throw new Error(`Produto com código de barras ${item.barcode} não encontrado`);
      }
      const produto = produtoResult.rows[0];
      if (produto.estoque < quantidade) {
        throw new Error(`Estoque insuficiente para o produto ${produto.nome} (Código: ${item.barcode})`);
      }

      const preco_unitario = Number(produto.valor_venda || produto.valor_unitario || 0);
      const subtotal = quantidade * preco_unitario;
      total += subtotal;

      await pool.query(
        'INSERT INTO itens_venda (id_venda, id_produto, quantidade, preco_unitario) VALUES ($1, $2, $3, $4)',
        [id_venda, produto.id, quantidade, preco_unitario]
      );
      await pool.query(
        'UPDATE estoque SET quantidade = quantidade - $1, updated_at = CURRENT_TIMESTAMP WHERE id_produto = $2',
        [quantidade, produto.id]
      );
    }

    await pool.query('UPDATE vendas SET total = $1 WHERE id = $2', [total, id_venda]);
    await pool.query('COMMIT');
    res.redirect(`/vendas/recibo/${id_venda}`);
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error(err);
    const formData = { id_cliente, cliente_nome: req.body.cliente_nome || '', itens: itens || [] };
    res.redirect(`/vendas?error=${encodeURIComponent(err.message)}&formData=${encodeURIComponent(JSON.stringify(formData))}`);
  }
});

// Recibo PDF
app.get('/vendas/recibo/:id', requireAuth, async (req, res) => {
  try {
    const vendaId = req.params.id;
    const vendaResult = await pool.query(`
      SELECT v.id, v.data_venda, v.total, c.nome AS cliente_nome, c.cpf AS cliente_cpf
      FROM vendas v
      LEFT JOIN clientes c ON v.id_cliente = c.id
      WHERE v.id = $1
    `, [vendaId]);
    const itensResult = await pool.query(`
      SELECT p.nome, i.quantidade, i.preco_unitario
      FROM itens_venda i
      JOIN produtos p ON i.id_produto = p.id
      WHERE i.id_venda = $1
    `, [vendaId]);

    if (vendaResult.rows.length === 0) throw new Error('Venda não encontrada');

    const venda = vendaResult.rows[0];
    const itens = itensResult.rows;

    const doc = new PDFDocument();
    res.setHeader('Content-Disposition', `attachment; filename=recibo_venda_${vendaId}.pdf`);
    res.setHeader('Content-Type', 'application/pdf');
    doc.pipe(res);

    doc.fontSize(20).text('Recibo de Venda', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Venda ID: ${venda.id}`);
    doc.text(`Data: ${new Date(venda.data_venda).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
    doc.text(`Cliente: ${venda.cliente_nome || 'Sem cliente'}`);
    doc.text(`CPF: ${venda.cliente_cpf ? venda.cliente_cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : '-'}`);
    doc.text(`Total: R$ ${parseFloat(venda.total).toFixed(2)}`);
    doc.moveDown();
    doc.text('Itens da Venda:', { underline: true });
    itens.forEach(item => {
      const subtotal = (item.quantidade * item.preco_unitario).toFixed(2);
      doc.text(`${item.quantidade}x ${item.nome} - R$ ${parseFloat(item.preco_unitario).toFixed(2)} (Subtotal: R$ ${subtotal})`);
    });

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao gerar recibo: ' + err.message);
  }
});

// --------- Carga via Excel ---------
app.get('/carga-produtos', requireAuth, (req, res) => {
  res.render('carga-produtos');
});

app.post('/carga-produtos', requireAuth, upload.single('excelFile'), async (req, res) => {
  try {
    const filePath = req.file.path;
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row[0] || row[0].toString().toUpperCase() === 'TOTAL') continue;

      const descricao = row[0].toString().trim();
      const quantidade = Number(row[1]);
      const valorTotal = Number(row[2]) || 0;
      const unidade = row[3] ? row[3].toString().trim() : null;
      const valorUnitario = Number(row[4]) || 0;
      const valorVenda = Number(row[5]) || valorUnitario;
      
      if (isNaN(quantidade) || quantidade < 0) {
        console.warn(`Linha ${i + 1} ignorada: Quantidade inválida (${row[1]})`);
        continue;
      }

      await pool.query('BEGIN');

      const produtoResult = await pool.query(
        'INSERT INTO produtos (nome, barcode, valor_unitario, valor_venda, descricao) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [descricao, null, valorUnitario, valorVenda, descricao]
      );
      const id_produto = produtoResult.rows[0].id;

      const forcedBarcode = formatBarcodeFromId(id_produto);
      await pool.query(
        'UPDATE produtos SET barcode = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [forcedBarcode, id_produto]
      );

      await pool.query(
        'INSERT INTO estoque (id_produto, quantidade) VALUES ($1, $2)',
        [id_produto, Math.floor(quantidade)]
      );

      await pool.query('COMMIT');
    }

    res.redirect('/produtos');
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error(err);
    res.status(500).send('Erro ao carregar produtos do Excel: ' + err.message);
  }
});

function abrirNavegador(url) {
  const plataforma = process.platform;
  if (plataforma === 'win32') {
    spawn('cmd', ['/c', 'start', url]);
  } else if (plataforma === 'darwin') {
    spawn('open', [url]);
  } else {
    spawn('xdg-open', [url]);
  }
}



app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
  abrirNavegador(`http://localhost:${port}`);
});
