-- Suporte a cobrança por estação/pessoa (Sala Coworking) — WB Coworking
-- Rode no SQL Editor do Supabase, uma vez. Só adiciona colunas novas,
-- não altera nem apaga nada existente.

alter table bookings add column if not exists stations int default 1;
alter table bookings add column if not exists guest_names text[];
