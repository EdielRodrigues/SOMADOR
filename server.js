const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));

const allowed = String(process.env.ALLOWED_ORIGINS || '*').split(',').map(s=>s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb){
    if(!origin || allowed.includes('*') || allowed.includes(origin)) return cb(null, true);
    return cb(new Error('Origem não permitida pelo CORS'));
  }
}));

app.use(rateLimit({ windowMs: 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false }));

const MP_TOKEN = String(process.env.MERCADO_PAGO_ACCESS_TOKEN || '').trim();
const DEFAULT_PAYER_EMAIL = String(process.env.DEFAULT_PAYER_EMAIL || 'pix-passadoria@example.com').trim();
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

function moneyNumber(v){
  const n = Number(v);
  if(!Number.isFinite(n)) return NaN;
  return Math.round(n * 100) / 100;
}

function statusPt(status){
  const s=String(status||'').toLowerCase();
  if(s==='approved') return 'pago';
  if(['cancelled','canceled','rejected','refunded','charged_back'].includes(s)) return 'cancelado';
  if(s==='expired') return 'expirado';
  return 'aguardando';
}

function requireToken(res){
  if(MP_TOKEN) return true;
  res.status(500).json({error:'MERCADO_PAGO_ACCESS_TOKEN não configurado no Render.'});
  return false;
}

async function mpRequest(path, options={}){
  const r = await fetch('https://api.mercadopago.com'+path, {
    ...options,
    headers:{
      'Authorization':'Bearer '+MP_TOKEN,
      'Content-Type':'application/json',
      ...(options.headers||{})
    }
  });
  const data = await r.json().catch(()=>({}));
  if(!r.ok){
    const msg = data?.message || data?.error || data?.cause?.[0]?.description || ('Mercado Pago '+r.status);
    const e = new Error(msg); e.status=r.status; e.data=data; throw e;
  }
  return data;
}

app.get('/', (req,res)=>res.json({online:true,service:'Passadoria Pix Backend',version:'1.0.0',mode:'valor-variavel',timestamp:new Date().toISOString()}));
app.get('/health', (req,res)=>res.json({ok:true,tokenConfigured:!!MP_TOKEN,service:'Passadoria Pix Backend',version:'1.0.0'}));

app.post('/createPix', async (req,res)=>{
  if(!requireToken(res)) return;
  try{
    const amount = moneyNumber(req.body.amount ?? req.body.valor ?? req.body.total);
    if(!Number.isFinite(amount) || amount < 0.50 || amount > 10000){
      return res.status(400).json({error:'Valor inválido. Envie amount entre 0,50 e 10.000,00.'});
    }
    const cliente = req.body.cliente || {};
    const description = String(req.body.description || `Passadoria - ${cliente.nome || 'Cliente'}`).slice(0,120);
    const orderId = String(req.body.orderId || req.body.reference || ('ROUPAS-'+Date.now())).replace(/[^A-Za-z0-9_.-]/g,'').slice(0,64);
    const expiresAt = new Date(Date.now()+24*60*60*1000).toISOString();
    const idem = crypto.createHash('sha256').update(orderId+'|'+amount).digest('hex');
    const payerEmail = String(req.body.payerEmail || DEFAULT_PAYER_EMAIL).trim();

    const payload = {
      transaction_amount: amount,
      description,
      payment_method_id: 'pix',
      date_of_expiration: expiresAt,
      external_reference: orderId,
      payer: { email: payerEmail }
    };

    const mp = await mpRequest('/v1/payments', {
      method:'POST',
      headers:{'X-Idempotency-Key': idem},
      body:JSON.stringify(payload)
    });

    const tx = mp.point_of_interaction?.transaction_data || {};
    res.status(201).json({
      ok:true,
      payment:{
        id:String(mp.id||''),
        orderId,
        amount:Number(mp.transaction_amount||amount),
        status:mp.status||'pending',
        statusPt:statusPt(mp.status),
        qrCode:tx.qr_code||'',
        qrCodeBase64:tx.qr_code_base64||'',
        paymentUrl:tx.ticket_url||'',
        createdAt:mp.date_created||new Date().toISOString(),
        expiresAt:mp.date_of_expiration||expiresAt
      }
    });
  }catch(e){
    console.error('createPix',e.data||e);
    res.status(e.status||500).json({error:e.message||'Não foi possível gerar o Pix.'});
  }
});

app.get('/paymentStatus', async (req,res)=>{
  if(!requireToken(res)) return;
  try{
    const id=String(req.query.id||'').trim();
    if(!/^\d+$/.test(id)) return res.status(400).json({error:'ID de pagamento inválido.'});
    const mp=await mpRequest('/v1/payments/'+encodeURIComponent(id));
    res.json({ok:true,payment:{
      id:String(mp.id||id),
      amount:Number(mp.transaction_amount||0),
      status:mp.status||'pending',
      statusPt:statusPt(mp.status),
      createdAt:mp.date_created||'',
      expiresAt:mp.date_of_expiration||'',
      paidAt:mp.date_approved||''
    }});
  }catch(e){
    console.error('paymentStatus',e.data||e);
    res.status(e.status||500).json({error:e.message||'Não foi possível consultar o Pix.'});
  }
});

app.post('/webhook', async (req,res)=>{
  // A confirmação principal do app é feita por /paymentStatus.
  // Esta rota existe para o Mercado Pago conseguir notificar o serviço.
  res.sendStatus(200);
});

app.post('/cancelPix', async (req,res)=>{
  if(!requireToken(res)) return;
  try{
    const id=String(req.body.id||'').trim();
    if(!/^\d+$/.test(id)) return res.status(400).json({error:'ID inválido.'});
    const mp=await mpRequest('/v1/payments/'+encodeURIComponent(id), {method:'PUT',body:JSON.stringify({status:'cancelled'})});
    res.json({ok:true,payment:{id:String(mp.id||id),status:mp.status||'cancelled',statusPt:statusPt(mp.status)}});
  }catch(e){
    res.status(e.status||500).json({error:e.message||'Não foi possível cancelar o Pix.'});
  }
});

app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:err.message||'Erro interno.'})});

const port=Number(process.env.PORT||3000);
app.listen(port,()=>console.log('Passadoria Pix Backend ouvindo na porta '+port));
