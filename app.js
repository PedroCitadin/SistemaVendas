require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const multer = require('multer');
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');

const app = express();
const port = process.env.PORT || 3000;

// Configuração do banco PostgreSQL usando variáveis de ambiente
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// Configurações do Express
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');

// Configuração do Multer para upload de arquivos
const upload = multer({ dest: 'uploads/' });

// Função para limpar e validar CPF
function cleanAndValidateCPF(cpf) {
    const cleanedCPF = cpf.replace(/[\.-]/g, '').trim();
    if (!cleanedCPF.match(/^\d{11}$/)) {
        throw new Error('CPF inválido. Deve conter 11 dígitos numéricos.');
    }
    return cleanedCPF;
}

// Rota inicial
app.get('/', (req, res) => {
    res.render('index');
});

// Rotas para Produtos
app.get('/produtos', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT p.id, p.nome, p.barcode, p.valor_unitario, p.valor_venda, p.descricao, e.quantidade
            FROM produtos p
            LEFT JOIN estoque e ON p.id = e.id_produto order by p.nome
        `);
        res.render('produtos', { produtos: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).send('Erro ao listar produtos');
    }
});

app.post('/produtos', async (req, res) => {
    const { nome, barcode, valor_unitario, valor_venda, descricao, quantidade } = req.body;
    try {
        await pool.query('BEGIN');
        const produtoResult = await pool.query(
            'INSERT INTO produtos (nome, barcode, valor_unitario, valor_venda, descricao) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [nome, barcode, valor_unitario, valor_venda || null, descricao || null]
        );
        const id_produto = produtoResult.rows[0].id;
        await pool.query('INSERT INTO estoque (id_produto, quantidade) VALUES ($1, $2)', [id_produto, parseInt(quantidade) || 0]);
        await pool.query('COMMIT');
        res.redirect('/produtos');
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error(err);
        res.status(500).send('Erro ao adicionar produto: ' + err.message);
    }
});

app.post('/produtos/editar/:id', async (req, res) => {
    const { nome, barcode, valor_unitario, valor_venda, descricao, quantidade } = req.body;
    try {
        await pool.query('BEGIN');
        await pool.query(
            'UPDATE produtos SET nome = $1, barcode = $2, valor_unitario = $3, valor_venda = $4, descricao = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6',
            [nome, barcode, valor_unitario, valor_venda || null, descricao || null, req.params.id]
        );
        await pool.query('UPDATE estoque SET quantidade = $1, updated_at = CURRENT_TIMESTAMP WHERE id_produto = $2', [parseInt(quantidade) || 0, req.params.id]);
        await pool.query('COMMIT');
        res.redirect('/produtos');
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error(err);
        res.status(500).send('Erro ao editar produto: ' + err.message);
    }
});

app.post('/produtos/deletar/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM produtos WHERE id = $1', [req.params.id]);
        res.redirect('/produtos');
    } catch (err) {
        console.error(err);
        res.status(500).send('Erro ao deletar produto: ' + err.message);
    }
});

// Rota para buscar produto por código de barras (AJAX)
app.get('/produtos/buscar', async (req, res) => {
    try {
        const barcode = req.query.barcode || '';
        if (!barcode) {
            return res.status(400).json({ error: 'Código de barras é obrigatório' });
        }
        const result = await pool.query(
            'SELECT p.id, p.nome, p.barcode, p.valor_venda, p.valor_unitario, e.quantidade AS estoque FROM produtos p LEFT JOIN estoque e ON p.id = e.id_produto WHERE p.barcode = $1 order by p.nome',
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
            preco: produto.valor_venda || produto.valor_unitario,
            estoque: produto.estoque
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao buscar produto: ' + err.message });
    }
});

// Rotas para Clientes
app.get('/clientes', async (req, res) => {
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

app.post('/clientes', async (req, res) => {
    const { nome, cpf, email, telefone, endereco } = req.body;
    try {
        if (!nome) {
            throw new Error('Nome é obrigatório');
        }
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

app.post('/clientes/editar/:id', async (req, res) => {
    const { nome, cpf, email, telefone, endereco } = req.body;
    try {
        if (!nome) {
            throw new Error('Nome é obrigatório');
        }
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

app.post('/clientes/deletar/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM clientes WHERE id = $1', [req.params.id]);
        res.redirect('/clientes');
    } catch (err) {
        console.error(err);
        res.status(500).send('Erro ao deletar cliente: ' + err.message);
    }
});

app.get('/clientes/buscar', async (req, res) => {
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

app.post('/clientes/novo', async (req, res) => {
    const { nome, cpf, email, telefone, endereco } = req.body;
    try {
        if (!nome) {
            throw new Error('Nome é obrigatório');
        }
        const cleanedCPF = cleanAndValidateCPF(cpf);
        const cpfCheck = await pool.query('SELECT id FROM clientes WHERE cpf = $1', [cleanedCPF]);
        if (cpfCheck.rows.length > 0) {
            throw new Error('CPF já cadastrado');
        }
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

// Rotas para Vendas
app.get('/vendas', async (req, res) => {
    try {
        const vendasResult = await pool.query(`
            SELECT v.id, v.data_venda, v.total, c.nome AS cliente_nome
            FROM vendas v
            LEFT JOIN clientes c ON v.id_cliente = c.id
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

app.post('/vendas', async (req, res) => {
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
                'SELECT p.id, p.nome, p.valor_venda, p.valor_unitario, e.quantidade AS estoque FROM produtos p LEFT JOIN estoque e ON p.id = e.id_produto WHERE p.barcode = $1',
                [item.barcode]
            );
            if (produtoResult.rows.length === 0) {
                throw new Error(`Produto com código de barras ${item.barcode} não encontrado`);
            }
            const produto = produtoResult.rows[0];
            if (produto.estoque < quantidade) {
                throw new Error(`Estoque insuficiente para o produto ${produto.nome} (Código: ${item.barcode})`);
            }
            const preco_unitario = produto.valor_venda || produto.valor_unitario;
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

// Rota para gerar recibo em PDF
app.get('/vendas/recibo/:id', async (req, res) => {
    try {
        const vendaId = req.params.id;
        const vendaResult = await pool.query(`
            SELECT v.id, v.data_venda, v.total, c.nome AS cliente_nome, c.cpf AS cliente_cpf
            FROM vendas v
            LEFT JOIN clientes c ON v.id_cliente = c.id
            WHERE v.id = $1
        `, [vendaId]);
        const itensResult = await pool.query(`
            SELECT p.nome, i.quantidade, i.preco_unitario, i.subtotal
            FROM itens_venda i
            JOIN produtos p ON i.id_produto = p.id
            WHERE i.id_venda = $1
        `, [vendaId]);

        if (vendaResult.rows.length === 0) {
            throw new Error('Venda não encontrada');
        }

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
            doc.text(`${item.quantidade}x ${item.nome} - R$ ${parseFloat(item.preco_unitario).toFixed(2)} (Subtotal: R$ ${parseFloat(item.subtotal).toFixed(2)})`);
        });

        doc.end();
    } catch (err) {
        console.error(err);
        res.status(500).send('Erro ao gerar recibo: ' + err.message);
    }
});

// Rota para Carga de Produtos via Excel
app.get('/carga-produtos', (req, res) => {
    res.render('carga-produtos');
});

app.post('/carga-produtos', upload.single('excelFile'), async (req, res) => {
    try {
        const filePath = req.file.path;
        const workbook = XLSX.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

        for (let i = 1; i < data.length; i++) {
            const row = data[i];
            if (row.length < 6 || !row[0] || row[0].toString().toUpperCase() === 'TOTAL') continue;

            const descricao = row[0].toString().trim();
            const quantidade = Number(row[1]);
            const valorTotal = Number(row[2]) || 0;
            const unidade = row[3] ? row[3].toString().trim() : null;
            const valorUnitario = Number(row[4]) || 0;
            const valorVenda = Number(row[5]) || null;

            if (isNaN(quantidade) || quantidade < 0) {
                console.warn(`Linha ${i + 1} ignorada: Quantidade inválida (${row[1]})`);
                continue;
            }

            const barcode = `BC${Date.now()}${i}`;

            await pool.query('BEGIN');
            const produtoResult = await pool.query(
                'INSERT INTO produtos (nome, barcode, valor_unitario, valor_venda, descricao) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                [descricao, barcode, valorUnitario, valorVenda, descricao]
            );
            const id_produto = produtoResult.rows[0].id;
            await pool.query('INSERT INTO estoque (id_produto, quantidade) VALUES ($1, $2)', [id_produto, Math.floor(quantidade)]);
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