-- Pix automático (Mercado Pago) — WB Coworking
-- Rode no SQL Editor do Supabase, uma vez. Não apaga nada.

-- Guarda o número do pagamento do Mercado Pago na reserva e na compra
alter table bookings add column if not exists mp_payment_id text;
alter table bookings add column if not exists created_at timestamptz default now();
alter table wb_purchases add column if not exists mp_payment_id text;
create index if not exists bookings_mp_payment_id_idx on bookings (mp_payment_id);

-- Agenda: reserva "Aguardando Pix" segura o horário por 40 minutos.
-- Se não for paga nesse tempo, o horário volta a ficar livre.
create or replace function wb_availability()
returns json
language sql
security definer
set search_path = public
as $$
  select coalesce(json_agg(r), '[]'::json) from (
    select id::text as id,
           date::text as date,
           slots,
           status,
           sala,
           sala_id,
           coalesce(stations, 1) as stations
      from bookings
     where date::text >= to_char((now() at time zone 'America/Sao_Paulo') - interval '1 day', 'YYYY-MM-DD')
       and coalesce(status, '') not ilike '%cancelado%'
       and not (status = 'Aguardando Pix' and coalesce(created_at, now()) < now() - interval '40 minutes')
  ) r;
$$;

grant execute on function wb_availability() to anon, authenticated;

-- Cliente acompanha o status das próprias reservas/compras (sem ver dados de outros)
create or replace function wb_booking_status(p_ids text[])
returns json
language sql
security definer
set search_path = public
as $$
  select coalesce(json_agg(json_build_object('id', id::text, 'status', status)), '[]'::json)
    from bookings where id::text = any(p_ids);
$$;
grant execute on function wb_booking_status(text[]) to anon, authenticated;
