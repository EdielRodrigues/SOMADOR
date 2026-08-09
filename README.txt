PASSADORIA PIX BACKEND v1.0

Backend separado do Finance IA.

ROTAS
GET  /health
POST /createPix              body: { amount, description, orderId, cliente }
GET  /paymentStatus?id=ID
POST /cancelPix              body: { id }
POST /webhook

RENDER
1. Crie um NOVO Web Service no Render usando esta pasta/repositório.
2. Build command: npm install
3. Start command: npm start
4. Copie para o novo serviço a variável MERCADO_PAGO_ACCESS_TOKEN do backend que já funciona.
5. Defina DEFAULT_PAYER_EMAIL com um e-mail válido.
6. Depois do deploy, abra /health.
7. Copie a URL nova para o Somador V10.

O Mercado Pago Access Token fica SOMENTE no Render. Nunca coloque esse token no HTML.
A cobrança usa o valor enviado pelo Somador e vence em 24 horas.
