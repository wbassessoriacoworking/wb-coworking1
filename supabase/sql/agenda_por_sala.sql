-- Agenda por sala com lugares (estações) — WB Coworking
-- Rode no SQL Editor do Supabase, uma vez. Só cria uma função nova de leitura.
--
-- Igual à get_booking_availability (sem dados pessoais), mas também devolve
-- quantas pessoas/estações cada reserva ocupa. O app usa isso para deixar as
-- outras estações do Coworking livres quando alguém reserva só uma.
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
  ) r;
$$;

grant execute on function wb_availability() to anon, authenticated;
