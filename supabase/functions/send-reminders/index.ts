// Edge Function: send-reminders
//
// Roda a cada 5–10 minutos via pg_cron. Procura reservas confirmadas cujo
// primeiro horário começa entre 55 e 65 minutos a partir de agora, e manda
// uma notificação push (Web Push) pra quem ativou lembretes no site.
//
// Variáveis de ambiente esperadas (definir com `supabase secrets set`):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (ex: mailto:seu@email.com)
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já são injetadas automaticamente
// pelo Supabase em toda Edge Function — não precisa configurar.

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:contato@wbcoworking.com.br";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// Brasil não observa horário de verão desde 2019 — offset fixo -03:00.
function slotStart(date: string, hour: string): Date {
  return new Date(`${date}T${hour}:00-03:00`);
}

Deno.serve(async () => {
  const now = Date.now();
  const windowStart = now + 55 * 60 * 1000;
  const windowEnd = now + 65 * 60 * 1000;

  const today = new Date(now - 3 * 60 * 60 * 1000).toISOString().slice(0, 10); // data local BR
  const tomorrow = new Date(now - 3 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data: bookings, error } = await sb
    .from("bookings")
    .select("id, date, slots, sala, status, user_doc, user_name, reminder_sent")
    .in("date", [today, tomorrow])
    .eq("reminder_sent", false)
    .or("status.ilike.%PAGO%,status.ilike.%Confirmado%");

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  const due = (bookings || []).filter((b) => {
    const slots = Array.isArray(b.slots) ? b.slots : [];
    if (!slots.length) return false;
    const first = slots.slice().sort()[0];
    const start = slotStart(b.date, first).getTime();
    return start >= windowStart && start <= windowEnd;
  });

  let sent = 0;
  for (const b of due) {
    if (!b.user_doc) continue;
    const { data: subs } = await sb
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth")
      .eq("user_doc", b.user_doc);

    const payload = JSON.stringify({
      title: "WB Coworking — Lembrete",
      body: `Sua reserva (${b.sala || "sala"}) é daqui a 1 hora.`,
      url: "/",
    });

    for (const s of subs || []) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
        );
      } catch (e) {
        // Inscrição expirada/inválida — remove pra não tentar de novo.
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          await sb.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
        }
      }
    }
    await sb.from("bookings").update({ reminder_sent: true }).eq("id", b.id);
    sent++;
  }

  return new Response(JSON.stringify({ checked: (bookings || []).length, remindersSent: sent }), {
    headers: { "Content-Type": "application/json" },
  });
});
