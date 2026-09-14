-- Configuração de lembretes automáticos (Web Push) — WB Coworking
-- Rode este script inteiro no SQL Editor do Supabase, uma vez.
-- Depois, o passo de agendamento (parte 3) precisa da service_role key,
-- que você pega em Project Settings → API → service_role (secret) —
-- NÃO compartilhe essa chave em chat/print, cole direto aqui no editor.

-- 1) Tabela de inscrições push (uma por navegador/dispositivo que ativou lembretes)
create table if not exists push_subscriptions (
  id bigserial primary key,
  user_doc text,
  user_name text,
  endpoint text unique not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz default now()
);

alter table push_subscriptions enable row level security;

drop policy if exists "Clientes podem se inscrever" on push_subscriptions;
create policy "Clientes podem se inscrever"
  on push_subscriptions for insert
  to anon, authenticated
  with check (true);

drop policy if exists "Clientes podem atualizar sua inscrição" on push_subscriptions;
create policy "Clientes podem atualizar sua inscrição"
  on push_subscriptions for update
  to anon, authenticated
  using (true);

-- 2) Flag pra evitar mandar o mesmo lembrete duas vezes
alter table bookings add column if not exists reminder_sent boolean default false;

-- 3) Agendamento (pg_cron chama a Edge Function a cada 5 minutos)
-- Rode esta parte SEPARADA, depois de colar sua service_role key no lugar indicado.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'wb-coworking-send-reminders',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://yampgxhrqleaetqgoewo.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer COLE_SUA_SERVICE_ROLE_KEY_AQUI',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Pra conferir se o agendamento ficou ativo:
-- select * from cron.job;
-- Pra remover, se precisar refazer:
-- select cron.unschedule('wb-coworking-send-reminders');
