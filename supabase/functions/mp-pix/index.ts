// Pix automático (Mercado Pago) — WB Coworking
//
// Ações (POST JSON):
//   { action: 'ping' }                                  → { enabled }
//   { action: 'create', kind: 'booking', ids: [...] }   → cobra as reservas "Aguardando Pix"
//   { action: 'create', kind: 'purchase', planId, doc, name, phone, email }
//   { action: 'status', paymentId }                     → { status } (e confirma se pago)
// Webhook do Mercado Pago: POST ?webhook=1  { type: 'payment', data: { id } }
//
// O valor cobrado sempre vem do banco (reservas) ou da tabela de preços
// (pacotes/planos), nunca do navegador. A confirmação só acontece depois de
// consultar o pagamento direto na API do Mercado Pago.
//
// Segredos (Supabase → Edge Functions → Secrets): MP_ACCESS_TOKEN
// Publicar com "Verify JWT" DESLIGADO (o Mercado Pago não manda JWT).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const MP_TOKEN = Deno.env.get('MP_ACCESS_TOKEN') ?? '';
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const sb = createClient(SB_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const HOOK_URL = SB_URL + '/functions/v1/mp-pix?webhook=1';
const WAIT = 'Aguardando Pix';
const PAID = 'PAGO — Confirmado';
const EXPIRE_MIN = 30;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

async function mp(path: string, init: RequestInit = {}) {
  const r = await fetch('https://api.mercadopago.com' + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + MP_TOKEN, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Mercado Pago ' + r.status + ': ' + (body.message ?? JSON.stringify(body)));
  return body;
}

// ── Preço mínimo aceitável de uma reserva (proteção contra valor adulterado)
async function pricing() {
  const { data } = await sb.from('app_settings').select('value').eq('key', 'pricing').maybeSingle();
  return data?.value ?? null;
}
function estacaoPrice(P: any, hours: number) {
  const e = P.estacao, blocks: [number, number][] = [[1, e.h1], [2, e.h2], [4, e.h4], [9, e.diaria]];
  const best = [0];
  for (let h = 1; h <= hours; h++) best[h] = Math.min(...blocks.map(([len, p]) => p + best[Math.max(0, h - len)]));
  return best[hours] ?? 0;
}
function fairPrice(P: any, b: any) {
  const hours = (b.slots ?? []).length;
  if (b.sala_id === 'particular') return hours * Number(P.particular);
  if (b.sala_id === 'compartilhada') return hours * Number(P.compartilhada ?? P.particular);
  return estacaoPrice(P, hours) * Math.max(1, Number(b.stations) || 1);
}

// ── Cancela reservas que ficaram esperando Pix e não foram pagas
async function cleanup() {
  const limit = new Date(Date.now() - (EXPIRE_MIN + 10) * 60000).toISOString();
  await sb.from('bookings').update({ status: 'Cancelado' }).eq('status', WAIT).lt('created_at', limit);
  await sb.from('wb_purchases').update({ status: 'Cancelado' }).eq('status', WAIT).lt('created_at', limit);
}

async function createPayment(amount: number, description: string, ref: string, email: string, name: string) {
  const expires = new Date(Date.now() + EXPIRE_MIN * 60000);
  const p = await mp('/v1/payments', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({
      transaction_amount: Math.round(amount * 100) / 100,
      payment_method_id: 'pix',
      description,
      external_reference: ref,
      notification_url: HOOK_URL,
      date_of_expiration: expires.toISOString().replace('Z', '-00:00'),
      payer: { email: email && email.includes('@') ? email : 'cliente@wbcoworking.com.br', first_name: (name || 'Cliente').split(' ')[0] },
    }),
  });
  const td = p.point_of_interaction?.transaction_data ?? {};
  return { paymentId: String(p.id), qrCode: td.qr_code, qrBase64: td.qr_code_base64, amount: p.transaction_amount, expiresAt: expires.toISOString() };
}

// ── Aplica um pagamento aprovado (idempotente)
async function applyPayment(p: any) {
  const ref = String(p.external_reference ?? '');
  if (p.status !== 'approved') return;
  if (ref.startsWith('booking:')) {
    // as reservas cobradas guardam o id do pagamento (mp_payment_id)
    const { data: rows } = await sb.from('bookings').select('id,status,total,weekly_total').eq('mp_payment_id', String(p.id));
    if (!rows?.length) return;
    const ids = rows.map((b: any) => b.id);
    const expected = Number(rows[0].weekly_total) || rows.reduce((s: number, b: any) => s + Number(b.total || 0), 0);
    const ok = Math.abs(Number(p.transaction_amount) - expected) < 0.01;
    const status = ok ? PAID : 'PAGO — Aguardando Verificação';
    await sb.from('bookings').update({ status, method: 'Pix automático', mp_payment_id: String(p.id) })
      .in('id', ids).not('status', 'ilike', '%cancelado%');
    // Reserva já tinha sido cancelada por tempo, mas o cliente pagou: volta como "verificar"
    await sb.from('bookings').update({ status: 'PAGO — Aguardando Verificação', method: 'Pix automático', mp_payment_id: String(p.id) })
      .in('id', ids).ilike('status', '%cancelado%').eq('method', 'Pix automático');
  } else if (ref.startsWith('purchase:')) {
    const id = Number(ref.slice(9));
    const { data: pu } = await sb.from('wb_purchases').select('*').eq('id', id).maybeSingle();
    if (!pu || pu.status === 'Ativo') return;
    if (Math.abs(Number(p.transaction_amount) - Number(pu.price)) >= 0.01) {
      await sb.from('wb_purchases').update({ status: 'Aguardando Verificação', mp_payment_id: String(p.id) }).eq('id', id);
      return;
    }
    const now = new Date();
    await sb.from('wb_purchases').update({
      status: 'Ativo', approved_at: now.toISOString(), mp_payment_id: String(p.id),
      expires_at: new Date(now.getTime() + Number(pu.validity_days) * 864e5).toISOString(),
    }).eq('id', id);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  try {
    // Webhook: só confia no que a API do Mercado Pago responder
    if (url.searchParams.get('webhook')) {
      const body = await req.json().catch(() => ({}));
      const id = body?.data?.id ?? url.searchParams.get('data.id') ?? url.searchParams.get('id');
      const type = body?.type ?? url.searchParams.get('type') ?? url.searchParams.get('topic');
      if (id && (type === 'payment' || !type) && MP_TOKEN) await applyPayment(await mp('/v1/payments/' + id));
      return json({ ok: true });
    }

    const body = await req.json().catch(() => ({}));
    if (body.action === 'ping') return json({ enabled: !!MP_TOKEN });
    if (!MP_TOKEN) return json({ error: 'Pix automático não configurado' }, 503);
    await cleanup();

    if (body.action === 'create' && body.kind === 'booking') {
      const ids: string[] = (body.ids ?? []).map(String).slice(0, 60);
      if (!ids.length) return json({ error: 'Reserva não informada' }, 400);
      const { data: rows } = await sb.from('bookings').select('*').in('id', ids);
      if (!rows || rows.length !== ids.length || rows.some((b: any) => b.status !== WAIT))
        return json({ error: 'Reserva não encontrada ou já processada' }, 400);
      const amount = Number(rows[0].weekly_total) || rows.reduce((s: number, b: any) => s + Number(b.total || 0), 0);
      const P = await pricing();
      if (P) {
        const fair = rows.reduce((s: number, b: any) => s + fairPrice(P, b), 0);
        if (amount < fair * 0.69 - 0.01) return json({ error: 'Valor da reserva não confere com a tabela de preços' }, 400);
      }
      if (!(amount > 0)) return json({ error: 'Valor inválido' }, 400);
      const b0 = rows[0];
      const desc = 'WB Coworking — ' + b0.sala + (rows.length > 1 ? ' (' + rows.length + ' datas)' : ' ' + b0.date);
      const pay = await createPayment(amount, desc, 'booking:' + ids[0] + (ids.length > 1 ? '+' + (ids.length - 1) : ''), b0.user_email, b0.user_name);
      await sb.from('bookings').update({ mp_payment_id: pay.paymentId }).in('id', ids);
      return json(pay);
    }

    if (body.action === 'create' && body.kind === 'purchase') {
      const P = await pricing();
      const plan = [...(P?.pacotes ?? []).map((x: any) => ({ ...x, kind: 'pacote' })), ...(P?.mensal ?? []).map((x: any) => ({ ...x, kind: 'mensal' }))]
        .find((x: any) => x.id === body.planId);
      if (!plan || !body.doc) return json({ error: 'Plano não encontrado' }, 400);
      const { data: pu, error } = await sb.from('wb_purchases').insert({
        user_doc: String(body.doc), user_name: body.name ?? null, user_phone: body.phone ?? null,
        kind: plan.kind, plan_id: plan.id, plan_name: plan.nome, hours: Number(plan.horas ?? 0),
        price: Number(plan.preco), validity_days: Number(plan.validade ?? 30), status: WAIT,
      }).select('id').single();
      if (error) throw error;
      const pay = await createPayment(Number(plan.preco), 'WB Coworking — ' + plan.nome, 'purchase:' + pu.id, body.email, body.name);
      await sb.from('wb_purchases').update({ mp_payment_id: pay.paymentId }).eq('id', pu.id);
      return json({ ...pay, purchaseId: pu.id });
    }

    if (body.action === 'status' && body.paymentId) {
      const p = await mp('/v1/payments/' + encodeURIComponent(String(body.paymentId)));
      await applyPayment(p);
      return json({ status: p.status });
    }

    return json({ error: 'Ação inválida' }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
