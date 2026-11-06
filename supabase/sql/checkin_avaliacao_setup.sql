-- Check-in, avaliação e vitrine pública — WB Coworking
-- Rode este script inteiro no SQL Editor do Supabase, uma vez.
-- Só adiciona uma coluna e cria funções; não altera nem apaga nada existente.

-- 1) Horário em que o cliente chegou (check-in)
alter table bookings add column if not exists checked_in_at timestamptz;

-- 2) Check-in pelo QR da porta / botão do app: marca as reservas de HOJE do
--    cliente (identificado pelo WhatsApp, o mesmo "user_doc" usado no app).
--    security definer porque o site (anon) não tem permissão de ler bookings.
create or replace function wb_checkin(p_doc text)
returns json
language sql
security definer
set search_path = public
as $$
  with upd as (
    update bookings
       set checked_in_at = coalesce(checked_in_at, now())
     where user_doc = p_doc
       and date::text = to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM-DD')
       and coalesce(status, '') not ilike '%cancelado%'
    returning id, sala, slots, user_name, checked_in_at
  )
  select coalesce(json_agg(upd), '[]'::json) from upd;
$$;

-- 3) Avaliação: grava nota/comentário só se a reserva for do próprio cliente.
create or replace function wb_rate(p_id text, p_doc text, p_rating int, p_comment text)
returns boolean
language sql
security definer
set search_path = public
as $$
  with upd as (
    update bookings
       set rating = greatest(1, least(5, p_rating)),
           rating_comment = nullif(trim(p_comment), '')
     where id::text = p_id
       and user_doc = p_doc
    returning 1
  )
  select count(*) > 0 from upd;
$$;

-- 4) Avaliações públicas pra vitrine: só 4-5 estrelas com comentário,
--    e só o primeiro nome do cliente (sem telefone/e-mail).
create or replace function wb_public_reviews()
returns json
language sql
security definer
set search_path = public
as $$
  select coalesce(json_agg(r), '[]'::json) from (
    select split_part(user_name, ' ', 1) as name,
           rating,
           rating_comment as comment
      from bookings
     where rating >= 4
       and coalesce(trim(rating_comment), '') <> ''
     order by date desc
     limit 12
  ) r;
$$;

grant execute on function wb_checkin(text) to anon, authenticated;
grant execute on function wb_rate(text, text, int, text) to anon, authenticated;
grant execute on function wb_public_reviews() to anon, authenticated;
