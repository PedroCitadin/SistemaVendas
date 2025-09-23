require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const multer = require('multer');
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');
const router = express.Router();
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
      `SELECT p.id, p.nome, p.barcode, p.valor_venda, p.valor_unitario, e.quantidade AS estoque, p.etiquetas_impressas 
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
// --------- Vendas (lista com filtros + status normalizado) ---------
app.get('/vendas', requireAuth, async (req, res) => {
  try {
    const cliente = (req.query.cliente || '').trim();
    const status = (req.query.status || '').trim().toUpperCase(); // '', 'CONCLUIDA', 'CANCELADA'

    const where = [];
    const params = [];
    let i = 1;

    if (cliente) {
      const cpfDigits = cliente.replace(/\D/g, '');
      where.push(`(c.nome ILIKE $${i} OR regexp_replace(c.cpf, '[^0-9]', '', 'g') LIKE $${i + 1})`);
      params.push(`%${cliente}%`, `%${cpfDigits}%`);
      i += 2;
    }

    if (status === 'CANCELADA') {
      where.push(`UPPER(v.status) LIKE 'CANCEL%'`);
    } else if (status === 'CONCLUIDA') {
      where.push(`(v.status IS NULL OR UPPER(v.status) NOT LIKE 'CANCEL%')`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rs = await pool.query(
      `
      SELECT
        v.id,
        v.data_venda,
        v.total,
        CASE
          WHEN v.status IS NULL THEN 'CONCLUIDA'
          WHEN UPPER(v.status) LIKE 'CANCEL%' THEN 'CANCELADA'
          ELSE v.status
        END AS status,
        c.nome AS cliente_nome
      FROM vendas v
      LEFT JOIN clientes c ON c.id = v.id_cliente
      ${whereSql}
      ORDER BY v.data_venda DESC NULLS LAST, v.id DESC
      LIMIT 200
      `,
      params
    );

    res.render('vendas', {
      vendas: rs.rows,
      error: req.query.error || '',
      formData: req.query.formData ? JSON.parse(decodeURIComponent(req.query.formData)) : {},
      filtros: { cliente, status: status || '' }
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

// Detalhes da venda (JSON para o modal), com status normalizado
app.get('/vendas/:id/json', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const v = await pool.query(
      `
      SELECT
        v.id,
        v.data_venda,
        v.total,
        CASE
          WHEN v.status IS NULL THEN 'CONCLUIDA'
          WHEN UPPER(v.status) LIKE 'CANCEL%' THEN 'CANCELADA'
          ELSE v.status
        END AS status,
        c.nome AS cliente_nome
      FROM vendas v
      LEFT JOIN clientes c ON c.id = v.id_cliente
      WHERE v.id = $1
      `,
      [id]
    );

    if (v.rowCount === 0) return res.status(404).json({ error: 'Venda não encontrada' });

    const itens = await pool.query(
      `
      SELECT p.nome, iv.quantidade, iv.preco_unitario
      FROM itens_venda iv
      JOIN produtos p ON p.id = iv.id_produto
      WHERE iv.id_venda = $1
      ORDER BY iv.id ASC
      `,
      [id]
    );

    res.json({ ...v.rows[0], itens: itens.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao carregar venda' });
  }
});


// Reverter venda (cancelar + devolver estoque) — já no formato app.post
app.post('/vendas/:id/reverter', requireAuth, async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const v = await client.query(
      `SELECT id, status, id_cliente, total, data_venda
       FROM vendas WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (v.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Venda não encontrada.' });
    }
    const venda = v.rows[0];

    if ((venda.status || '').toUpperCase().startsWith('CANCEL')) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Venda já está cancelada.' });
    }

    const itens = await client.query(
      `SELECT id_produto, quantidade
       FROM itens_venda WHERE id_venda = $1`,
      [id]
    );

    for (const it of itens.rows) {
      await client.query(
        'UPDATE estoque SET quantidade = COALESCE(quantidade,0) + $1 WHERE id_produto = $2',
        [it.quantidade, it.id_produto]
      );
    }

    await client.query(`UPDATE vendas SET status = 'CANCELADA' WHERE id = $1`, [id]);

    let cliente_nome = null;
    if (venda.id_cliente) {
      const c = await client.query('SELECT nome FROM clientes WHERE id = $1', [venda.id_cliente]);
      cliente_nome = c.rowCount ? c.rows[0].nome : null;
    }

    await client.query('COMMIT');

    res.json({
      id: venda.id,
      data_venda: venda.data_venda,
      total: venda.total,
      status: 'CANCELADA',
      cliente_nome
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Erro ao reverter a venda.' });
  } finally {
    client.release();
  }
});


// Recibo PDF
// Recibo estilo "talão", com linha que cresce conforme a descrição
app.get('/vendas/recibo/:id', requireAuth, async (req, res) => {
  const mm = v => v * 2.83465;
  const BRL = v => `R$ ${Number(v || 0).toFixed(2)}`;
  const maskCPF = v => (v || '').replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');

  try {
    const vendaId = req.params.id;

    // Consulta venda
    const vendaResult = await pool.query(`
      SELECT v.id, v.data_venda, v.total, c.nome AS cliente_nome, c.cpf AS cliente_cpf
      FROM vendas v
      LEFT JOIN clientes c ON v.id_cliente = c.id
      WHERE v.id = $1
    `, [vendaId]);
    if (vendaResult.rows.length === 0) throw new Error('Venda não encontrada');

    const itensResult = await pool.query(`
      SELECT p.nome, i.quantidade, i.preco_unitario
      FROM itens_venda i
      JOIN produtos p ON i.id_produto = p.id
      WHERE i.id_venda = $1
      ORDER BY i.id
    `, [vendaId]);

    const venda = vendaResult.rows[0];
    const itens = itensResult.rows;

    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({
      size: 'A5',
      margins: { top: mm(10), left: mm(10), right: mm(10), bottom: mm(12) }
    });

    res.setHeader('Content-Disposition', `inline; filename=recibo_venda_${vendaId}.pdf`);
    res.setHeader('Content-Type', 'application/pdf');
    doc.pipe(res);

    const primary = '#0f5132';
    const lineGray = '#555';
    const lightGray = '#f2f2f2';
    const fs = { xs: 8, sm: 9, base: 10, md: 11, lg: 12, xl: 14 };

    const page = {
      x: doc.page.margins.left,
      y: doc.page.margins.top,
      w: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      h: doc.page.height - doc.page.margins.top - doc.page.margins.bottom
    };

    // Cabeçalho
    function drawHeader() {
      const h = mm(26);
      doc.save().rect(page.x, page.y, page.w, h).fill(lightGray).restore();

      doc.fillColor(primary).fontSize(fs.lg).font('Helvetica-Bold')
        .text('Associação Hospitalar Nossa Senhora de Fátima', page.x, page.y + mm(2), {
          width: page.w - mm(35), align: 'center'
        });

      doc.fillColor('#000').font('Helvetica').fontSize(fs.sm)
        .text('Rua Frei Protásio, 431 • Centro • Praia Grande/SC',
              page.x, page.y + mm(12),
              { width: page.w - mm(35), align: 'center' })
        .text('Fone: (48) 3532-0139',
              page.x, page.y + mm(17),
              { width: page.w - mm(35), align: 'center' })
        .text('CNPJ: 07.420.153/0001-37',
              page.x, page.y + mm(22),
              { width: page.w - mm(35), align: 'center' });

      const boxW = mm(30), boxH = mm(14);
      const boxX = page.x + page.w - boxW;
      const boxY = page.y + mm(6);

      doc.roundedRect(boxX, boxY, boxW, boxH, 3)
        .strokeColor(primary).lineWidth(1).stroke();

      doc.font('Helvetica').fontSize(fs.xs).fillColor('#000')
        .text('Nº', boxX + mm(2), boxY + mm(2));
      doc.font('Helvetica-Bold').fontSize(fs.md)
        .text(String(venda.id).padStart(4, '0'), boxX, boxY + mm(5), { width: boxW, align: 'center' });

      return page.y + h; // retorna o fim do cabeçalho
    }

    // Bloco de dados da venda
    function drawMeta(yStart) {
      const y = yStart + mm(5); // espaço depois do cabeçalho
      const lh = mm(6);
      const dataStr = new Date(venda.data_venda).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      const cpfStr = venda.cliente_cpf ? maskCPF(venda.cliente_cpf) : '-';

      doc.font('Helvetica').fontSize(fs.base).fillColor('#000')
        .text('Data:', page.x, y)
        .font('Helvetica-Bold').text(dataStr, page.x + mm(18), y);

      doc.font('Helvetica').text('Cliente:', page.x + mm(60), y)
        .font('Helvetica-Bold').text(venda.cliente_nome || 'Sem cliente', page.x + mm(80), y);

      doc.font('Helvetica').text('CPF:', page.x, y + lh)
        .font('Helvetica-Bold').text(cpfStr, page.x + mm(18), y + lh);

      doc.font('Helvetica').text('Atendente:', page.x + mm(60), y + lh)
        .font('Helvetica-Bold').text((req.user && req.user.nome) || '-', page.x + mm(80), y + lh);

      doc.moveTo(page.x, y + lh * 2.2).lineTo(page.x + page.w, y + lh * 2.2)
        .strokeColor(lineGray).lineWidth(0.5).stroke();

      return y + lh * 2.5; // retorna onde a tabela deve começar
    }
    // Tabela com altura dinâmica por linha
    function drawTable(startY) {
      // larguras das colunas
      const col = {
        qtd: mm(16),
        desc: page.w - mm(16 + 28 + 32),
        unit: mm(28),
        total: mm(32)
      };

      // cabeçalho
      const headerH = mm(8);
      doc.save().rect(page.x, startY, page.w, headerH).fill('#e9ecef').restore();
      doc.lineWidth(0.8).strokeColor(lineGray).rect(page.x, startY, page.w, headerH).stroke();

      doc.font('Helvetica-Bold').fontSize(fs.sm).fillColor('#000')
        .text('Quant', page.x + mm(2), startY + mm(2), { width: col.qtd - mm(4), align: 'left' })
        .text('DESCRIÇÃO DO ITEM', page.x + col.qtd + mm(2), startY + mm(2), { width: col.desc - mm(4), align: 'left' })
        .text('VL UN', page.x + col.qtd + col.desc + mm(2), startY + mm(2), { width: col.unit - mm(4), align: 'right' })
        .text('VALOR TOTAL', page.x + col.qtd + col.desc + col.unit + mm(2), startY + mm(2), { width: col.total - mm(4), align: 'right' });

      let y = startY + headerH;
      const minRowH = mm(7.5);
      const bottomLimit = page.y + page.h - mm(45); // espaço para total e assinaturas
      let totalGeral = 0;

      // função para desenhar cada item respeitando altura do texto
      const drawRow = (item) => {
        const subtotal = Number(item.quantidade) * Number(item.preco_unitario);
        totalGeral += subtotal;

        const desc = String(item.nome || '');
        const descOptions = { width: col.desc - mm(4), align: 'left' };
        // mede a altura necessária para a descrição
        const textHeight = Math.ceil(doc.heightOfString(desc, descOptions));
        // altura da linha = maior entre mínimo e texto + margenzinha
        const rowH = Math.max(minRowH, textHeight + mm(2));

        // quebra de página, se necessário
        if (y + rowH > bottomLimit) {
          // desenha total parcial antes de quebrar (opcional; pode remover se não quiser)
          drawTotals(y, totalGeral);
          doc.addPage();

          // recomputa área útil
          page.x = doc.page.margins.left;
          page.y = doc.page.margins.top;
          page.w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
          page.h = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;

          drawHeader();
          const metaEnd = drawMeta(page.y + mm(24));
          // reabrir cabeçalho da tabela na nova página
          y = drawTable(metaEnd + mm(3)).y; // drawTable retorna o y atual; mas aqui só queremos o topo de linhas
        }

        // linha horizontal guia
        doc.strokeColor('#ddd').lineWidth(0.5).moveTo(page.x, y).lineTo(page.x + page.w, y).stroke();

        // células
        doc.font('Helvetica').fontSize(fs.sm).fillColor('#000')
          .text(String(item.quantidade), page.x + mm(2), y + mm(1), { width: col.qtd - mm(4) });

        doc.text(desc, page.x + col.qtd + mm(2), y + mm(1), descOptions);

        doc.text(BRL(item.preco_unitario), page.x + col.qtd + col.desc, y + mm(1), { width: col.unit - mm(2), align: 'right' });
        doc.text(BRL(subtotal), page.x + col.qtd + col.desc + col.unit, y + mm(1), { width: col.total - mm(2), align: 'right' });

        // borda da linha
        doc.strokeColor(lineGray).lineWidth(0.6).rect(page.x, y, page.w, rowH).stroke();
        // colunas verticais
        doc.moveTo(page.x + col.qtd, y).lineTo(page.x + col.qtd, y + rowH).stroke();
        doc.moveTo(page.x + col.qtd + col.desc, y).lineTo(page.x + col.qtd + col.desc, y + rowH).stroke();
        doc.moveTo(page.x + col.qtd + col.desc + col.unit, y).lineTo(page.x + col.qtd + col.desc + col.unit, y + rowH).stroke();

        y += rowH;
      };

      itens.forEach(drawRow);

      return { y, total: totalGeral };
    }

    function drawTotals(y, total) {
      const labelW = page.w - mm(40);
      doc.font('Helvetica-Bold').fontSize(fs.md)
        .text('TOTAL', page.x + labelW, y + mm(2), { width: mm(20), align: 'right' })
        .text(BRL(total), page.x + labelW + mm(20), y + mm(2), { width: mm(20), align: 'right' });
      return y + mm(10);
    }

    function drawSignatures(y) {
      const lineY = y + mm(14);
      const colW = (page.w - mm(8)) / 2;

      doc.strokeColor(lineGray).lineWidth(0.8)
        .moveTo(page.x + mm(4), lineY).lineTo(page.x + mm(4) + colW, lineY).stroke()
        .moveTo(page.x + mm(8) + colW, lineY).lineTo(page.x + mm(8) + colW + colW, lineY).stroke();

      doc.font('Helvetica').fontSize(fs.sm)
        .text('Assinatura do Responsável', page.x + mm(4), lineY + mm(1), { width: colW, align: 'center' })
        .text('Assinatura do Cliente', page.x + mm(8) + colW, lineY + mm(1), { width: colW, align: 'center' });

      return lineY + mm(10);
    }

    function drawFooter(y) {
      const text = 'AS MERCADORIAS NÃO PODERÃO SER UTILIZADAS PARA VENDA NO COMÉRCIO, SOB PENA ' +
                   'DE APREENSÃO POR PARTE DAS AUTORIDADES COMPETENTES.';
      doc.font('Helvetica').fontSize(fs.xs).fillColor('#666')
        .text(text, page.x, y + mm(2), { width: page.w, align: 'justify' });
    }

    // Renderização
    drawHeader();
    const metaEnd = drawMeta(page.y + mm(24));
    const table = drawTable(metaEnd + mm(3));
    const afterTotal = drawTotals(table.y + mm(2), table.total);
    const afterSign = drawSignatures(afterTotal + mm(2));
    drawFooter(afterSign);

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

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});
