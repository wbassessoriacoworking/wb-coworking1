-- Tabela de preços editável, pacotes de horas e planos mensais — WB Coworking
-- Rode este script inteiro no SQL Editor do Supabase, uma vez.
-- Só cria tabelas/colunas/funções novas; não altera nem apaga nada existente.

-- 1) Configurações do app (tabela de preços editável pelo painel admin)
create table if not exists app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);
alter table app_settings enable row level security;

drop policy if exists "Todos leem configurações" on app_settings;
create policy "Todos leem configurações" on app_settings
  for select to anon, authenticated using (true);

drop policy if exists "Admin altera configurações" on app_settings;
create policy "Admin altera configurações" on app_settings
  for all to authenticated using (true) with check (true);

grant select on app_settings to anon, authenticated;
grant insert, update on app_settings to authenticated;

-- Preços iniciais (o painel admin altera depois, sem mexer no código)
insert into app_settings (key, value) values ('pricing', '{
  "estacao":   { "h1": 25, "h2": 40, "h4": 70, "diaria": 100 },
  "particular": 50,
  "reuniao":   { "ate4": 60, "ate8": 80 },
  "pacotes": [
    { "id": "p10", "nome": "Pacote 10 horas", "horas": 10, "preco": 200, "validade": 60 },
    { "id": "p20", "nome": "Pacote 20 horas", "horas": 20, "preco": 360, "validade": 60, "destaque": true },
    { "id": "p40", "nome": "Pacote 40 horas", "horas": 40, "preco": 680, "validade": 90 }
  ],
  "mensal": [
    { "id": "rotativo", "nome": "Posto compartilhado rotativo", "preco": 450, "validade": 30 },
    { "id": "fixo",     "nome": "Posto fixo",                   "preco": 650, "validade": 30 }
  ]
}'::jsonb)
on conflict (key) do nothing;

-- 2) Compras de pacotes de horas e planos mensais
create table if not exists wb_purchases (
  id bigserial primary key,
  user_doc text not null,
  user_name text,
  user_phone text,
  kind text not null,                 -- 'pacote' | 'mensal'
  plan_id text not null,
  plan_name text,
  hours numeric default 0,            -- horas do pacote (0 no plano mensal)
  hours_used numeric default 0,
  price numeric not null,
  validity_days int not null,
  status text not null default 'Aguardando Verificação',  -- | 'Ativo' | 'Recusado'
  file_name text,
  file_data text,
  created_at timestamptz default now(),
  approved_at timestamptz,
  expires_at timestamptz
);
alter table wb_purchases enable row level security;

-- Só o admin (logado) lê/aprova direto; o cliente usa as funções abaixo
drop policy if exists "Admin gerencia compras" on wb_purchases;
create policy "Admin gerencia compras" on wb_purchases
  for all to authenticated using (true) with check (true);
grant select, insert, update, delete on wb_purchases to authenticated;
grant usage, select on sequence wb_purchases_id_seq to authenticated;

-- 3) Reserva paga com saldo de pacote: de qual compra saíram as horas
alter table bookings add column if not exists credit_purchase_id bigint;
alter table bookings add column if not exists credit_hours numeric default 0;

-- 4) Cliente compra um pacote/plano. Preço, horas e validade vêm da tabela
--    de preços do servidor (o app não consegue mandar um preço diferente).
create or replace function wb_buy(p_doc text, p_name text, p_phone text, p_plan_id text, p_file_name text, p_file_data text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pricing jsonb;
  v_plan jsonb;
  v_kind text;
  v_id bigint;
begin
  select value into v_pricing from app_settings where key = 'pricing';
  select e into v_plan from jsonb_array_elements(v_pricing->'pacotes') e where e->>'id' = p_plan_id;
  v_kind := 'pacote';
  if v_plan is null then
    select e into v_plan from jsonb_array_elements(v_pricing->'mensal') e where e->>'id' = p_plan_id;
    v_kind := 'mensal';
  end if;
  if v_plan is null then
    raise exception 'Plano não encontrado: %', p_plan_id;
  end if;
  insert into wb_purchases (user_doc, user_name, user_phone, kind, plan_id, plan_name, hours, price, validity_days, file_name, file_data)
  values (p_doc, p_name, p_phone, v_kind, p_plan_id, v_plan->>'nome',
          coalesce((v_plan->>'horas')::numeric, 0), (v_plan->>'preco')::numeric,
          coalesce((v_plan->>'validade')::int, 30), p_file_name, p_file_data)
  returning id into v_id;
  return v_id;
end $$;

-- 5) Saldo do cliente (sem o comprovante, que é pesado)
create or replace function wb_my_credits(p_doc text)
returns json
language sql
security definer
set search_path = public
as $$
  select coalesce(json_agg(r order by r.created_at desc), '[]'::json) from (
    select id, kind, plan_id, plan_name, hours, hours_used, price, validity_days,
           status, created_at, approved_at, expires_at
      from wb_purchases
     where user_doc = p_doc
     order by created_at desc
     limit 20
  ) r;
$$;

-- 6) Usa horas do pacote ativo que vence primeiro (tudo numa transação)
create or replace function wb_use_credit(p_doc text, p_hours numeric, p_booking_id text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
  v_left numeric;
begin
  select id into v_id
    from wb_purchases
   where user_doc = p_doc and kind = 'pacote' and status = 'Ativo'
     and expires_at > now() and hours - hours_used >= p_hours
   order by expires_at
   limit 1
   for update;
  if v_id is null then
    return json_build_object('ok', false);
  end if;
  update wb_purchases set hours_used = hours_used + p_hours where id = v_id
  returning hours - hours_used into v_left;
  return json_build_object('ok', true, 'purchase_id', v_id, 'remaining', v_left);
end $$;

-- 7) Reserva paga com pacote foi cancelada: devolve as horas (uma vez só)
create or replace function wb_refund_credit(p_doc text, p_booking_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pid bigint;
  v_hours numeric;
begin
  select credit_purchase_id, credit_hours into v_pid, v_hours
    from bookings
   where id::text = p_booking_id and user_doc = p_doc and coalesce(credit_hours, 0) > 0;
  if v_pid is null then
    return false;
  end if;
  update wb_purchases set hours_used = greatest(0, hours_used - v_hours) where id = v_pid;
  update bookings set credit_hours = 0 where id::text = p_booking_id;
  return true;
end $$;

grant execute on function wb_buy(text, text, text, text, text, text) to anon, authenticated;
grant execute on function wb_my_credits(text) to anon, authenticated;
grant execute on function wb_use_credit(text, numeric, text) to anon, authenticated;
grant execute on function wb_refund_credit(text, text) to anon, authenticated;
