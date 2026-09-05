/**
 * AgoBra - Telegram Scheduling & Messaging Bot + Painel Admin (tempo real)
 * - Node.js + Telegraf + Firebase Firestore + Express (health check / anti-sleep / painel)
 * - Supabase Storage para upload de fotos/documentos/vídeos
 * - Nodemailer para notificação por email (config 100% pelo painel, igual palavras-chave)
 *
 * ===========================================================================
 * ESTA VERSÃO INCORPORA (ver marcações "[MERGE]" no código):
 * ===========================================================================
 *  [MERGE A] Função A — Coleta guiada e detalhada de dados de agendamento
 *            (documento, nacionalidade, origem/destino, país do processo,
 *            campos condicionais Angola/Portugal, consentimento de dados).
 *            Roda LOGO APÓS o usuário escolher dia/hora no fluxo de slots
 *            já existente do AgoBra. Todas as perguntas de múltipla escolha
 *            usam BOTÕES ESTILIZADOS (inline keyboard com emojis) — nunca
 *            "responda Sim ou Não digitando".
 *  [MERGE B] Função B — Registro MANUAL de vaga (rotas) + alerta aos
 *            interessados. Sem scraping/monitoramento automático do site
 *            oficial — decisão de design mantida (ver comentário na seção).
 *  [MERGE C] Função C — Handoff humano (transferir para atendente): pausa o
 *            fluxo automático para aquele chat e deixa o painel conduzir.
 *  [MERGE D] Função D — Monitoramento de palavras-chave em grupos +
 *            subcoleções de usuários + alerta direcionado.
 *  [MERGE E] Supabase Storage para fotos/documentos/vídeos enviados pelos
 *            usuários (uploads ficam no Supabase; dados "de cliente"
 *            continuam no Firebase/Firestore como sempre).
 *  [MERGE F] Notificação por email (Nodemailer) — configurada 100% pelo
 *            painel (coleção settings/email no Firestore), do mesmo jeito
 *            que as palavras-chave da Função D.
 *  [MERGE G] Comandos "sem barra": o usuário pode digitar simplesmente
 *            "agendar" ou "start" (sem "/") que o bot reconhece igual ao
 *            comando — /agendar e /start continuam funcionando também, por
 *            compatibilidade. Ao digitar "start", o bot manda as
 *            boas-vindas e, em seguida, uma pequena "análise" (resumo de
 *            vagas disponíveis + menu de botões rápidos).
 *
 * -----------------------------------------------------------------------
 * CORREÇÕES HERDADAS DA VERSÃO ANTERIOR (ver comentários "[FIX]")
 * -----------------------------------------------------------------------
 * [FIX 1] Comando digitado no meio do /agendar não é mais engolido pelo
 *         fluxo (cancela o agendamento em andamento e processa o comando).
 * [FIX 2] Remove webhook residual antes de dar bot.launch() (evita 409).
 * [FIX 3] Todo bot.action responde ao clique mesmo em erro (sem "spinner
 *         infinito"); editMessageText ignora "message is not modified".
 * [FIX 4] /cancel e /reschedule tratam erros e nunca ficam sem resposta.
 * [FIX 5] /confirm <id> (admin) marca agendamento como "confirmed".
 * [FIX 6] Durante handoff ativo, as mensagens de texto do usuário são
 *         salvas na coleção "handoff_messages" para o atendente ver e
 *         responder pelo painel, sem que o fluxo automático do bot
 *         interfira (o fluxo continua pausado normalmente).
 * -----------------------------------------------------------------------
 *
 * Instalação (local):
 * 1. npm install telegraf firebase-admin node-schedule luxon dotenv express \
 *              @supabase/supabase-js nodemailer
 * 2. Coloque o service account JSON em ./firebase.json (ou ajuste FIREBASE_CRED_PATH)
 *    OU cole o conteúdo do JSON inteiro na variável FIREBASE_CREDENTIALS_JSON
 * 3. Copie .env.example -> .env e preencha as variáveis (inclusive as novas
 *    SUPABASE_URL / SUPABASE_SERVICE_KEY / SUPABASE_BUCKET — ver seção [MERGE E])
 * 4. node bot.js
 * 5. Acesse o painel em http://localhost:3000/painel (ou na URL pública em produção)
 *
 * Variáveis de ambiente NOVAS nesta versão:
 *   SUPABASE_URL             URL do projeto Supabase (ex: https://xxxx.supabase.co)
 *   SUPABASE_SERVICE_KEY     Service Role Key do Supabase (nunca a anon key)
 *   SUPABASE_BUCKET          Nome do bucket de storage (padrão: "uploads")
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM / SMTP_TO
 *                             Valores de FALLBACK do email, usados só se o
 *                             painel ainda não tiver preenchido
 *                             settings/email no Firestore. O painel manda
 *                             (documento Firestore) sempre que preenchido,
 *                             igual ao fluxo das palavras-chave da Função D.
 *
 * IMPORTANTE (Supabase x Firebase):
 * Uploads de mídia (fotos de documento, PDFs, vídeos) vão para o Supabase
 * Storage. Os DADOS do cliente (perfil, agendamento, consentimento) e as
 * URLs públicas resultantes do upload continuam gravados no Firestore, como
 * o resto do sistema. Ou seja: Supabase guarda o arquivo, Firebase guarda a
 * referência/URL — nada muda na forma como o painel lê dados de clientes.
 *
 * IMPORTANTE (Firestore):
 * As queries abaixo exigem índices compostos. Na primeira vez que uma query
 * precisar de índice, o Firestore devolve um erro com um link pronto para criá-lo.
 *
 * IMPORTANTE (Segurança):
 * O painel fala DIRETO com o Firestore usando o SDK do navegador — publique
 * as Firestore Security Rules exigindo panel_admins/{uid}. NÃO pule esse passo.
 *
 * IMPORTANTE (Handoff em tempo real — [FIX 6]):
 * Quando o handoff está ativo para um chat, toda mensagem de TEXTO que o
 * usuário digitar no Telegram é gravada na coleção "handoff_messages" assim:
 *   { chatId, from: 'user', text, fromId, fromName, createdAt }
 * O painel deve escutar essa coleção (where chatId == <chat>) para exibir a
 * conversa em tempo real ao atendente. Quando o atendente responde pelo
 * painel, o fluxo já existente (dashboard_commands tipo "handoff_send")
 * envia a mensagem ao usuário via Telegram — o ideal é que o próprio
 * painel também grave essa mensagem do atendente em "handoff_messages" com
 * from: 'agent' (isso é feito do lado do painel, fora deste arquivo) para
 * manter o histórico completo da conversa em um único lugar.
 */

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const schedule = require('node-schedule');
const { DateTime } = require('luxon');
const fs = require('fs');
const path = require('path');
const express = require('express');
const nodemailer = require('nodemailer');                 // [MERGE F]
const { createClient } = require('@supabase/supabase-js'); // [MERGE E]

// ---------------------------------------------------------------------------
// Config / bootstrap
// ---------------------------------------------------------------------------

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) {
  console.error('❌ Falta TELEGRAM_TOKEN. Defina essa variável de ambiente.');
  process.exit(1);
}

function resolveFirebaseCredential() {
  const rawJson = process.env.FIREBASE_CREDENTIALS_JSON;
  if (rawJson && rawJson.trim()) {
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
      console.log('🔑 Credencial Firebase carregada via FIREBASE_CREDENTIALS_JSON.');
      return admin.credential.cert(parsed);
    } catch (err) {
      console.error('❌ FIREBASE_CREDENTIALS_JSON está definida mas não é um JSON válido:', err.message);
      process.exit(1);
    }
  }
  const credPath = process.env.FIREBASE_CRED_PATH || path.join(process.cwd(), 'firebase.json');
  if (fs.existsSync(credPath)) {
    console.log(`🔑 Credencial Firebase carregada do arquivo: ${credPath}`);
    return admin.credential.cert(require(credPath));
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.log('🔑 Usando GOOGLE_APPLICATION_CREDENTIALS.');
    return admin.credential.applicationDefault();
  }
  return null;
}

const firebaseCredential = resolveFirebaseCredential();
if (firebaseCredential) {
  admin.initializeApp({ credential: firebaseCredential });
} else {
  console.error(
    '❌ Nenhuma credencial Firebase encontrada. Configure FIREBASE_CREDENTIALS_JSON, ' +
    'FIREBASE_CRED_PATH, firebase.json ou GOOGLE_APPLICATION_CREDENTIALS.'
  );
  process.exit(1);
}

const db = admin.firestore();
const bot = new Telegraf(TELEGRAM_TOKEN);

const TIMEZONE = process.env.TIMEZONE || 'UTC';
const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || (ADMIN_UIDS[0] || null); // fallback p/ notificações diretas
const REMINDER_OFFSETS = (process.env.REMINDER_OFFSETS || '1440,60,15,5')
  .split(',').map(s => parseInt(s, 10)).filter(n => !Number.isNaN(n)).sort((a, b) => b - a);

const BUSINESS_START_HOUR = parseInt(process.env.BUSINESS_START_HOUR || '9', 10);
const BUSINESS_END_HOUR = parseInt(process.env.BUSINESS_END_HOUR || '17', 10);
const SLOT_DURATION_MIN = parseInt(process.env.SLOT_DURATION_MIN || '30', 10);
const WORKING_WEEKDAYS = (process.env.WORKING_WEEKDAYS || '1,2,3,4,5')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(n => !Number.isNaN(n));
const DAYS_AHEAD = parseInt(process.env.DAYS_AHEAD || '14', 10);
const BOOKING_TIMEOUT_MIN = parseInt(process.env.BOOKING_TIMEOUT_MIN || '10', 10);

const ADMIN_SIGNUP_CODE = process.env.ADMIN_SIGNUP_CODE || null;
if (!ADMIN_SIGNUP_CODE) {
  console.warn('⚠️  ADMIN_SIGNUP_CODE não definida — cadastro de admins do painel DESATIVADO.');
}

const PERIODS = ['manha', 'tarde', 'noite'];
const PERIOD_LABEL = { manha: 'Manhã ☀️', tarde: 'Tarde 🌤️', noite: 'Noite 🌙' };

// [MERGE E] --- Supabase Storage (uploads de fotos/documentos/vídeos) -------
const SUPABASE_URL = process.env.SUPABASE_URL || null;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || null;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'uploads';
let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  console.log(`🗄️  Supabase Storage conectado (bucket: "${SUPABASE_BUCKET}").`);
} else {
  console.warn(
    '⚠️  Supabase não configurado (SUPABASE_URL / SUPABASE_SERVICE_KEY ausentes).\n' +
    '   Uploads de fotos/documentos/vídeos vão cair no fallback (link direto do Telegram\n' +
    '   salvo no Firestore) até você configurar o Supabase.'
  );
}

// ---------------------------------------------------------------------------
// Servidor HTTP (porta + health check + anti-sleep + painel)
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const app = express();
const startedAt = Date.now();
const PUBLIC_DIR = path.join(__dirname, 'public');

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok', bot: 'AgoBra',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    supabase: !!supabase,
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'online',
    message: '🤖 AgoBra rodando. Painel em /painel. Use /health para checar status.',
    timestamp: new Date().toISOString(),
  });
});

app.use(express.static(PUBLIC_DIR));

function resolvePanelFile() {
  const candidates = [
    path.join(PUBLIC_DIR, 'painel.html'),
    path.join(PUBLIC_DIR, 'index.html'),
    path.join(__dirname, 'painel.html'),
    path.join(__dirname, 'index.html'),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

app.get('/painel', (req, res) => {
  const panelFile = resolvePanelFile();
  if (!panelFile) {
    return res.status(404).send(
      'Painel não encontrado. Coloque o arquivo do painel em public/painel.html ' +
      '(recomendado) ou index.html/painel.html na raiz do projeto.'
    );
  }
  res.sendFile(panelFile);
});

app.get('/index.html', (req, res) => {
  const panelFile = resolvePanelFile();
  if (!panelFile) return res.status(404).send('Painel não encontrado.');
  res.sendFile(panelFile);
});

const server = app.listen(PORT, () => {
  console.log(`🌐 Servidor HTTP ouvindo na porta ${PORT} (rotas /health e /painel disponíveis).`);
});

// ---------------------------------------------------------------------------
// Self-ping (anti-sleep)
// ---------------------------------------------------------------------------
const SELF_PING_URL =
  process.env.SELF_PING_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null) ||
  process.env.RAILWAY_STATIC_URL ||
  null;

const SELF_PING_INTERVAL_MIN = parseInt(process.env.SELF_PING_INTERVAL_MIN || '10', 10);

if (SELF_PING_URL) {
  const pingTarget = `${SELF_PING_URL.replace(/\/$/, '')}/health`;
  console.log(`🔁 Self-ping ATIVADO a cada ${SELF_PING_INTERVAL_MIN} min → ${pingTarget}`);
  setInterval(() => {
    fetch(pingTarget)
      .then((res) => console.log(`🔁 Self-ping OK (${res.status}) — ${new Date().toISOString()}`))
      .catch((err) => console.error(`⚠️  Self-ping falhou: ${err.message}`));
  }, SELF_PING_INTERVAL_MIN * 60 * 1000);
} else {
  console.warn('⚠️  SELF_PING_URL não definida. Configure um pinger externo apontando para /health.');
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
async function logAction(action, actorUid = null, details = {}) {
  await db.collection('logs').add({
    action, actorUid: actorUid || null, details,
    ts: admin.firestore.FieldValue.serverTimestamp(),
  }).catch(console.error);
}

function escapeHtml(str = '') {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isAdmin(uid) { return ADMIN_UIDS.includes(String(uid)); }

async function safeSend(chatId, message, extra = {}) {
  try {
    await bot.telegram.sendMessage(chatId, message, extra);
    return true;
  } catch (err) {
    return { error: err };
  }
}

async function safeEditMessageText(ctx, text, extra) {
  try {
    await ctx.editMessageText(text, extra);
  } catch (err) {
    const desc = (err && err.description) || err.message || '';
    if (/message is not modified/i.test(desc)) return;
    throw err;
  }
}

function safeAction(handler) {
  return async (ctx) => {
    try {
      await handler(ctx);
    } catch (err) {
      console.error('Erro em bot.action:', err);
      await logAction('unhandled_action_error', ctx.from ? String(ctx.from.id) : null, { error: err.message }).catch(() => {});
      try {
        await ctx.answerCbQuery('⚠️ Ocorreu um erro. Tente novamente.', { show_alert: false });
      } catch (_) { /* já pode ter sido respondido */ }
    }
  };
}

// ===========================================================================
// [MERGE F] Notificação por email — configurada 100% pelo painel
// A coleção settings/email é preenchida pelo painel (host, porta, usuário,
// senha, remetente, destinatários e quais eventos notificam), exatamente
// como as palavras-chave da Função D. O bot cacheia em tempo real via
// onSnapshot e usa fallback das variáveis SMTP_* enquanto o painel não
// preenche nada.
// ===========================================================================
let emailSettingsCache = {
  enabled: false,
  host: process.env.SMTP_HOST || null,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: false,
  user: process.env.SMTP_USER || null,
  pass: process.env.SMTP_PASS || null,
  from: process.env.SMTP_FROM || process.env.SMTP_USER || null,
  to: (process.env.SMTP_TO || '').split(',').map(s => s.trim()).filter(Boolean),
  notifyOnHandoff: true,
  notifyOnVacancy: true,
  notifyOnKeyword: false,
};
let mailTransporter = null;

function rebuildMailTransporter() {
  const c = emailSettingsCache;
  if (!c.enabled || !c.host || !c.user || !c.pass) {
    mailTransporter = null;
    return;
  }
  mailTransporter = nodemailer.createTransport({
    host: c.host, port: c.port, secure: !!c.secure,
    auth: { user: c.user, pass: c.pass },
  });
}

function watchEmailSettings() {
  db.collection('settings').doc('email').onSnapshot((snap) => {
    if (snap.exists) emailSettingsCache = { ...emailSettingsCache, ...snap.data() };
    rebuildMailTransporter();
  }, (err) => console.error('❌ Erro no listener de settings/email:', err));
  rebuildMailTransporter();
  console.log('📧 Configuração de email (painel) sincronizada em tempo real.');
}

async function sendEmailNotification(subject, html, eventFlag = null) {
  try {
    if (!emailSettingsCache.enabled) return false;
    if (eventFlag && emailSettingsCache[eventFlag] === false) return false;
    if (!mailTransporter || !emailSettingsCache.to || !emailSettingsCache.to.length) return false;
    await mailTransporter.sendMail({
      from: emailSettingsCache.from || emailSettingsCache.user,
      to: emailSettingsCache.to.join(','),
      subject, html,
    });
    return true;
  } catch (err) {
    console.error('⚠️  Falha ao enviar email de notificação:', err.message);
    return false;
  }
}

// ===========================================================================
// [MERGE E] Upload de mídia (fotos/documentos/vídeos) → Supabase Storage
// O arquivo em si vai pro Supabase; a URL pública resultante é salva no
// Firestore junto ao perfil do cliente (users/{uid}.documents[]), mantendo
// o Firebase como fonte de verdade dos dados do cliente.
// ===========================================================================
async function uploadTelegramFileToSupabase(fileId, uid, kind) {
  const link = await bot.telegram.getFileLink(fileId); // URL do Telegram
  if (!supabase) {
    // Fallback: sem Supabase configurado, guarda o link direto do Telegram.
    return { url: link.href, storage: 'telegram_fallback' };
  }
  const res = await fetch(link.href);
  if (!res.ok) throw new Error(`Falha ao baixar arquivo do Telegram (status ${res.status})`);
  const arrayBuf = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  const ext = path.extname(new URL(link.href).pathname) || '';
  const filename = `${kind}/${uid}_${Date.now()}${ext}`;
  const contentType = res.headers.get('content-type') || undefined;
  const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(filename, buffer, {
    contentType, upsert: false,
  });
  if (error) throw error;
  const { data: pub } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(filename);
  return { url: pub.publicUrl, storage: 'supabase', path: filename };
}

async function saveUploadedDocument(uid, kind, fileId, extra = {}) {
  const result = await uploadTelegramFileToSupabase(fileId, uid, kind);
  await db.collection('users').doc(uid).set({
    documents: admin.firestore.FieldValue.arrayUnion({
      kind, url: result.url, storage: result.storage,
      uploadedAt: new Date().toISOString(), ...extra,
    }),
  }, { merge: true });
  await logAction('document_uploaded', uid, { kind, storage: result.storage });
  return result;
}

// ---------------------------------------------------------------------------
// Slots automáticos (horário comercial)
// ---------------------------------------------------------------------------
function generateCandidateSlots() {
  const now = DateTime.now().setZone(TIMEZONE);
  const slots = [];
  for (let d = 0; d <= DAYS_AHEAD; d++) {
    const day = now.plus({ days: d }).startOf('day');
    if (!WORKING_WEEKDAYS.includes(day.weekday)) continue;
    let cursor = day.set({ hour: BUSINESS_START_HOUR, minute: 0 });
    const dayEnd = day.set({ hour: BUSINESS_END_HOUR, minute: 0 });
    while (cursor < dayEnd) {
      if (cursor > now) slots.push(cursor);
      cursor = cursor.plus({ minutes: SLOT_DURATION_MIN });
    }
  }
  return slots;
}

async function getAvailableSlotsByDay() {
  const now = admin.firestore.Timestamp.fromDate(new Date());
  const until = admin.firestore.Timestamp.fromDate(
    DateTime.now().setZone(TIMEZONE).plus({ days: DAYS_AHEAD + 1 }).toJSDate()
  );
  const busySnap = await db.collection('appointments')
    .where('status', 'in', ['scheduled', 'confirmed'])
    .where('datetime', '>=', now)
    .where('datetime', '<=', until)
    .get();
  const busySet = new Set(
    busySnap.docs.map(d => DateTime.fromJSDate(d.data().datetime.toDate()).setZone(TIMEZONE).toISO())
  );
  const candidates = generateCandidateSlots().filter(dt => !busySet.has(dt.toISO()));
  const byDay = {};
  for (const dt of candidates) {
    const dayKey = dt.toFormat('yyyy-LL-dd');
    byDay[dayKey] = byDay[dayKey] || [];
    byDay[dayKey].push(dt);
  }
  return byDay;
}

// ---------------------------------------------------------------------------
// Reminders de agendamento — EM TEMPO REAL
// ---------------------------------------------------------------------------
const scheduledJobs = {};

function cancelJobsFor(appointmentId) {
  if (scheduledJobs[appointmentId]) {
    scheduledJobs[appointmentId].forEach(j => j.job.cancel && j.job.cancel());
    delete scheduledJobs[appointmentId];
  }
}

async function scheduleRemindersForAppointment(appt) {
  const when = appt.datetime && appt.datetime.toDate ? appt.datetime.toDate() : new Date(appt.datetime);
  const apptDate = DateTime.fromJSDate(when).setZone(TIMEZONE);
  const now = DateTime.now().setZone(TIMEZONE);
  if (apptDate <= now) return;

  const remindersSent = appt.remindersSent || [];
  scheduledJobs[appt.id] = scheduledJobs[appt.id] || [];

  for (const offsetMinutes of REMINDER_OFFSETS) {
    const sendAt = apptDate.minus({ minutes: offsetMinutes });
    if (sendAt <= now) continue;
    if (remindersSent.includes(String(offsetMinutes))) continue;

    const job = schedule.scheduleJob(sendAt.toJSDate(), async () => {
      try {
        const apptSnap = await db.collection('appointments').doc(appt.id).get();
        if (!apptSnap.exists || apptSnap.data().status === 'cancelled') return;

        const userSnap = await db.collection('users').doc(appt.userUid).get();
        if (!userSnap.exists) return logAction('reminder_failed_user_missing', null, { appointmentId: appt.id });
        const user = userSnap.data();

        const fmtDate = apptDate.toLocaleString(DateTime.DATETIME_MED);
        const emphasise = offsetMinutes <= 5;
        const prefix = emphasise ? '⏰ É AGORA — ' : '🔔 Lembrete: ';
        const quando = offsetMinutes <= 5 ? 'em poucos minutos' : `em ${fmtDate}`;
        const msg = `${prefix}Você tem um compromisso ${quando}\nCategoria: ${appt.category || '—'}\nObservações: ${appt.notes || '—'}`;

        const res = await safeSend(user.uid, msg);
        if (res === true) {
          await db.collection('notifications').add({
            type: 'reminder', message: msg, target: { uid: user.uid },
            appointmentId: appt.id, offsetMinutes,
            sentAt: admin.firestore.FieldValue.serverTimestamp(), createdBy: 'system',
          });
          await db.collection('appointments').doc(appt.id).update({
            remindersSent: admin.firestore.FieldValue.arrayUnion(String(offsetMinutes))
          });
          await logAction('reminder_sent', null, { appointmentId: appt.id, userUid: user.uid, offsetMinutes });
        } else {
          await logAction('reminder_send_error', null, { appointmentId: appt.id, error: res.error.message });
        }
      } catch (err) {
        console.error('Erro no job de reminder:', err);
      }
    });

    scheduledJobs[appt.id].push({ offsetMinutes, job });
  }
}

function watchAppointmentsForReminders() {
  db.collection('appointments')
    .where('status', 'in', ['scheduled', 'confirmed'])
    .onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        const doc = change.doc;
        if (change.type === 'added' || change.type === 'modified') {
          cancelJobsFor(doc.id);
          scheduleRemindersForAppointment({ id: doc.id, ...doc.data() }).catch(console.error);
        } else if (change.type === 'removed') {
          cancelJobsFor(doc.id);
        }
      });
    }, (err) => console.error('❌ Erro no listener de appointments (lembretes):', err));
  console.log('⏰ Listener de lembretes em tempo real ativado.');
}

// ---------------------------------------------------------------------------
// Criação ATÔMICA de agendamento
// ---------------------------------------------------------------------------
async function createAppointmentAtomic({ userUid, dt, category, notes, createdBy, extra = {} }) {
  const collRef = db.collection('appointments');
  const jsDate = dt.toJSDate();

  return db.runTransaction(async (tx) => {
    const conflictSnap = await tx.get(
      collRef.where('status', 'in', ['scheduled', 'confirmed']).where('datetime', '==', jsDate)
    );
    if (!conflictSnap.empty) throw new Error('SLOT_TAKEN');

    const newRef = collRef.doc();
    tx.set(newRef, {
      userUid, datetime: jsDate, datetimeISO: dt.toISO(),
      category: category || null, notes: notes || null, status: 'scheduled',
      createdBy: createdBy || null, createdAt: admin.firestore.FieldValue.serverTimestamp(),
      remindersSent: [], ...extra,
    });
    return newRef.id;
  });
}

// ---------------------------------------------------------------------------
// Grupos
// ---------------------------------------------------------------------------
bot.on('my_chat_member', async (ctx) => {
  const upd = ctx.myChatMember;
  if (!upd || upd.chat.type === 'private') return;
  const chatId = String(upd.chat.id);
  const groupRef = db.collection('groups').doc(chatId);
  const newStatus = upd.new_chat_member.status;

  if (['member', 'administrator'].includes(newStatus)) {
    await groupRef.set({
      chatId, title: upd.chat.title || '', type: upd.chat.type, status: 'active',
      addedBy: upd.from ? String(upd.from.id) : null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    await logAction('group_added', upd.from ? String(upd.from.id) : null, { chatId, title: upd.chat.title });
  } else if (['left', 'kicked'].includes(newStatus)) {
    await groupRef.set({ status: 'removed', removedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await logAction('group_removed', upd.from ? String(upd.from.id) : null, { chatId });
  }
});

bot.command('vincular', async (ctx) => {
  if (ctx.chat.type === 'private') return ctx.reply('Use /vincular dentro do grupo que deseja associar ao seu perfil.');
  const chatId = String(ctx.chat.id);
  const uid = String(ctx.from.id);
  await db.collection('groups').doc(chatId).set({
    chatId, title: ctx.chat.title || '', type: ctx.chat.type, status: 'active',
    linkedUserUid: uid,
  }, { merge: true });
  await db.collection('users').doc(uid).set({ linkedGroupId: chatId }, { merge: true });
  await logAction('group_linked', uid, { chatId });
  await ctx.reply('✅ Este grupo foi vinculado ao seu perfil.');
});

bot.command('meugrupo', async (ctx) => {
  const uid = String(ctx.from.id);
  const userSnap = await db.collection('users').doc(uid).get();
  const groupId = userSnap.exists ? userSnap.data().linkedGroupId : null;
  if (!groupId) return ctx.reply('Você ainda não tem grupo vinculado. Adicione o bot a um grupo e use /vincular lá dentro.');
  const groupSnap = await db.collection('groups').doc(groupId).get();
  const title = groupSnap.exists ? (groupSnap.data().title || groupId) : groupId;
  await ctx.reply(`Seu grupo vinculado: ${title} (ID: ${groupId})`);
});

async function broadcastToGroups(message, actorUid = null) {
  const snaps = await db.collection('groups').where('status', '==', 'active').get();
  let sent = 0, fail = 0;
  for (const doc of snaps.docs) {
    const res = await safeSend(doc.data().chatId, message, { parse_mode: 'HTML' });
    if (res === true) sent++; else {
      fail++;
      await db.collection('groups').doc(doc.id).set({ status: 'unreachable' }, { merge: true }).catch(() => {});
    }
  }
  await logAction('broadcast_groups_sent', actorUid, { sent, fail });
  return { sent, fail };
}

// ---------------------------------------------------------------------------
// Mensagens automáticas 3x/dia (manhã / tarde / noite)
// ---------------------------------------------------------------------------
const DEFAULT_DAILY_CONFIG = {
  manha: { text: 'Bom dia! ☀️ Que seu dia seja produtivo. Se precisar agendar algo, digite agendar.', hour: 7, minute: 0, enabled: true, target: 'usuarios' },
  tarde: { text: 'Boa tarde! 🌤️ Continue firme, o dia já está na metade.', hour: 13, minute: 0, enabled: true, target: 'usuarios' },
  noite: { text: 'Boa noite! 🌙 Descanse bem, até amanhã.', hour: 20, minute: 0, enabled: true, target: 'usuarios' },
};

async function ensureDailyConfig() {
  const ref = db.collection('settings').doc('daily_messages');
  const snap = await ref.get();
  if (!snap.exists) { await ref.set(DEFAULT_DAILY_CONFIG); return DEFAULT_DAILY_CONFIG; }
  return { ...DEFAULT_DAILY_CONFIG, ...snap.data() };
}

async function getDailyConfig() {
  const snap = await db.collection('settings').doc('daily_messages').get();
  return snap.exists ? { ...DEFAULT_DAILY_CONFIG, ...snap.data() } : DEFAULT_DAILY_CONFIG;
}

async function updateDailyConfig(period, patch) {
  await db.collection('settings').doc('daily_messages').set({ [period]: patch }, { merge: true });
}

async function sendDailyMessage(period) {
  const cfg = await getDailyConfig();
  const periodCfg = cfg[period];
  if (!periodCfg || !periodCfg.enabled) return;

  let sentUsers = 0, sentGroups = 0;
  if (periodCfg.target === 'usuarios' || periodCfg.target === 'todos') {
    const usersSnap = await db.collection('users').where('status', '==', 'active').get();
    for (const doc of usersSnap.docs) {
      const res = await safeSend(doc.data().uid, periodCfg.text);
      if (res === true) sentUsers++;
      else if (res.error && res.error.response && [403, 400].includes(res.error.response.error_code)) {
        await db.collection('users').doc(doc.id).set({ status: 'blocked' }, { merge: true }).catch(() => {});
      }
    }
  }
  if (periodCfg.target === 'grupos' || periodCfg.target === 'todos') {
    const stats = await broadcastToGroups(periodCfg.text, 'system');
    sentGroups = stats.sent;
  }
  await logAction('daily_message_sent', 'system', { period, sentUsers, sentGroups });
  console.log(`[daily:${period}] enviado para ${sentUsers} usuários e ${sentGroups} grupos.`);
}

const dailyJobs = {};
function scheduleDailyJob(period, cfg) {
  if (dailyJobs[period]) dailyJobs[period].cancel();
  const rule = new schedule.RecurrenceRule();
  rule.hour = cfg.hour; rule.minute = cfg.minute; rule.tz = TIMEZONE;
  dailyJobs[period] = schedule.scheduleJob(rule, () => sendDailyMessage(period).catch(console.error));
}

async function scheduleAllDailyJobs() {
  const cfg = await ensureDailyConfig();
  for (const period of PERIODS) scheduleDailyJob(period, cfg[period]);
  console.log('Mensagens automáticas diárias agendadas:', PERIODS.map(p => `${p} @ ${cfg[p].hour}:${String(cfg[p].minute).padStart(2, '0')}`).join(', '));
}

// ===========================================================================
// [MERGE D] Função D — Palavras-chave em grupos + subcoleções de usuários
// Tudo configurado pelo PAINEL, escrevendo direto nas coleções abaixo do
// Firestore. O bot mantém um cache em memória sincronizado em tempo real.
// ===========================================================================
let keywordsCache = []; // [{id, pattern, type, active}]

function watchKeywords() {
  db.collection('keywords').onSnapshot((snap) => {
    keywordsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }, (err) => console.error('❌ Erro no listener de keywords:', err));
  console.log('🔎 Palavras-chave (Função D) sincronizadas em tempo real com o painel.');
}

function matchKeyword(text, keyword) {
  if (keyword.active === false) return false;
  const t = (text || '').toLowerCase();
  const p = (keyword.pattern || '').toLowerCase();
  if (keyword.type === 'exact') return t.split(/\s+/).includes(p) || t.trim() === p;
  if (keyword.type === 'contains') return t.includes(p);
  if (keyword.type === 'regex') {
    try { return new RegExp(keyword.pattern, 'i').test(text || ''); }
    catch (e) { console.error(`Palavra-chave regex inválida (id=${keyword.id}):`, e.message); return false; }
  }
  return false;
}

async function handleGroupKeywordScan(ctx) {
  const text = ctx.message.text || ctx.message.caption || '';
  if (!text) return;
  for (const keyword of keywordsCache) {
    if (matchKeyword(text, keyword)) {
      const alert = {
        groupId: String(ctx.chat.id),
        groupTitle: ctx.chat.title || '',
        fromId: ctx.from.id,
        fromName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '),
        username: ctx.from.username || null,
        text, keyword: keyword.pattern,
        date: new Date((ctx.message.date || Date.now() / 1000) * 1000).toISOString(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      await db.collection('keyword_alerts').add(alert);

      if (ADMIN_CHAT_ID) {
        await safeSend(
          ADMIN_CHAT_ID,
          `🔔 Palavra-chave detectada\n\nGrupo: ${alert.groupTitle}\nUsuário: ${alert.fromName} (@${alert.username || 's/username'})\nID: ${alert.fromId}\nPalavra: "${alert.keyword}"\nMensagem: "${alert.text}"`
        );
      }
      await sendEmailNotification(
        `🔔 Palavra-chave detectada: "${alert.keyword}"`,
        `<p><b>Grupo:</b> ${escapeHtml(alert.groupTitle)}</p>
         <p><b>Usuário:</b> ${escapeHtml(alert.fromName)} (@${escapeHtml(alert.username || 's/username')})</p>
         <p><b>Mensagem:</b> ${escapeHtml(alert.text)}</p>`,
        'notifyOnKeyword'
      );
      break; // um alerta por mensagem é suficiente
    }
  }
}

// ---- Subcoleções (gestão de usuários pelo painel) --------------------------

async function addUserToSubcollection(name, uid) {
  await db.collection('subcollections').doc(name).set({
    members: admin.firestore.FieldValue.arrayUnion(String(uid)),
  }, { merge: true });
}

async function removeUserFromSubcollection(name, uid) {
  await db.collection('subcollections').doc(name).set({
    members: admin.firestore.FieldValue.arrayRemove(String(uid)),
  }, { merge: true });
}

async function sendTargetedAlert(uids, message) {
  const results = [];
  for (const uid of uids) {
    const snap = await db.collection('users').doc(String(uid)).get();
    const user = snap.exists ? snap.data() : null;
    if (!user || !user.consent) {
      results.push({ uid, sent: false, reason: 'sem consentimento ou usuário desconhecido' });
      continue;
    }
    const res = await safeSend(uid, message);
    results.push({ uid, sent: res === true, reason: res === true ? null : res.error.message });
  }
  return results;
}

// ===========================================================================
// [MERGE B] Função B — Registro MANUAL de vaga (rotas) + alerta aos
// interessados. SEM scraping/monitoramento automático do site oficial —
// decisão de design deliberada: a VFS Global / governo português já combate
// publicamente automação usada para "açambarcar" vagas gratuitas (inclusive
// com verificação facial obrigatória no momento da marcação). Uma varredura
// automática, mesmo somente-leitura, reproduziria essa mesma assimetria.
// Por isso o gatilho é sempre MANUAL: alguém da equipe checou o site oficial
// pessoalmente e confirma isso pelo painel.
// ===========================================================================

const STANDARD_MESSAGES = {
  pedidoAutomacaoSiteOficial:
    'Não faço o agendamento nem monitoro o site oficial de forma automática — vagas devem ser buscadas diretamente por você, o próprio requerente, como o site exige. O que posso fazer é te ajudar a deixar todos os documentos e dados prontos, para você ser rápido assim que checar por conta própria.',
  vagaEncontrada: (rota) =>
    `🔔 Vaga disponível para ${rota.origin} → ${rota.destination}! Acesse o site oficial agora e finalize o agendamento antes que esgote.`,
  recusaConsentimento:
    'Sem autorização para uso dos dados, não consigo continuar com o agendamento automatizado. Posso te transferir para um atendente humano?',
  naoSubstituiAconselhamento:
    'Lembrete: esta conversa não substitui aconselhamento jurídico/consular oficial. Para dúvidas específicas sobre o processo, consulte o consulado ou um profissional habilitado.',
  documentoExpirado:
    'Notei que a validade informada já passou. Pode confirmar ou corrigir a data de validade do documento?',
};

function looksLikeAutomationRequest(text) {
  const t = (text || '').toLowerCase();
  return (
    (t.includes('clica') || t.includes('clicar') || t.includes('preenche') || t.includes('preencher') || t.includes('agenda direto') || t.includes('agendar direto')) &&
    (t.includes('site') || t.includes('vfs') || t.includes('oficial'))
  );
}

async function getUsersInterestedInRoute(route) {
  const origin = (route.origin || '').toLowerCase();
  const destination = (route.destination || '').toLowerCase();
  const snap = await db.collection('users').where('consent', '==', true).get();
  return snap.docs
    .map(d => d.data())
    .filter(u => {
      if (!u.booking) return false;
      const lo = (u.booking.localOrigem || '').toLowerCase();
      const ld = (u.booking.localDestino || '').toLowerCase();
      return lo.includes(origin) && ld.includes(destination);
    })
    .map(u => u.uid);
}

async function notifyVacancy(route, uids) {
  const msg = STANDARD_MESSAGES.vagaEncontrada(route);
  for (const uid of uids) await safeSend(uid, msg);
}

// Chamado apenas pelo painel (via dashboard_commands, tipo "vaga_detectada")
// por alguém que checou o site oficial pessoalmente. Nenhuma verificação
// automática acontece aqui.
async function registerVacancySeenManually(routeId) {
  const routeSnap = await db.collection('routes').doc(routeId).get();
  if (!routeSnap.exists) return { ok: false, error: 'Rota não encontrada.' };
  const route = { id: routeId, ...routeSnap.data() };
  const interested = await getUsersInterestedInRoute(route);
  await notifyVacancy(route, interested);
  await logAction('vacancy_manually_registered', 'dashboard', { routeId, notified: interested.length });
  await sendEmailNotification(
    `🔔 Vaga registrada: ${route.origin} → ${route.destination}`,
    `<p>Vaga confirmada manualmente por um membro da equipe.</p>
     <p><b>Rota:</b> ${escapeHtml(route.origin)} → ${escapeHtml(route.destination)}</p>
     <p><b>Interessados notificados:</b> ${interested.length}</p>`,
    'notifyOnVacancy'
  );
  return { ok: true, notified: interested.length };
}

// ===========================================================================
// [MERGE C] Função C — Handoff humano
// ===========================================================================
let handoffCache = {}; // chatId -> { active, agent, since, reason, resumeStep }

function watchHandoffs() {
  db.collection('handoffs').onSnapshot((snap) => {
    snap.docChanges().forEach((change) => {
      const chatId = change.doc.id;
      if (change.type === 'removed') { delete handoffCache[chatId]; return; }
      handoffCache[chatId] = change.doc.data();
    });
  }, (err) => console.error('❌ Erro no listener de handoffs:', err));
  console.log('🧑‍💼 Handoffs (Função C) sincronizados em tempo real com o painel.');
}

function isHandoffActive(chatId) {
  const h = handoffCache[String(chatId)];
  return !!(h && h.active);
}

async function startHandoff(ctx, reason) {
  const chatId = String(ctx.chat.id);
  const resumeStep = bookingState[chatId] ? bookingState[chatId].step : null;
  await db.collection('handoffs').doc(chatId).set({
    active: true, agent: null, since: new Date().toISOString(),
    reason: reason || 'solicitado pelo usuário', resumeStep,
  }, { merge: true });
  clearBookingState(chatId);

  await ctx.reply('Ok! Um atendente humano vai continuar com você a partir daqui. Pode escrever normalmente. 🧑‍💼');

  const uid = String(ctx.from.id);
  const userSnap = await db.collection('users').doc(uid).get();
  const user = userSnap.exists ? userSnap.data() : { name: ctx.from.first_name };
  if (ADMIN_CHAT_ID) {
    await safeSend(ADMIN_CHAT_ID,
      `🧑‍💼 Handoff solicitado\nUsuário: ${user.name || ''}\nchat_id: ${chatId}\nMotivo: ${reason || 'solicitado pelo usuário'}`);
  }
  await sendEmailNotification(
    `🧑‍💼 Handoff solicitado — chat ${chatId}`,
    `<p><b>Usuário:</b> ${escapeHtml(user.name || '')}</p>
     <p><b>chat_id:</b> ${chatId}</p>
     <p><b>Motivo:</b> ${escapeHtml(reason || 'solicitado pelo usuário')}</p>`,
    'notifyOnHandoff'
  );
}

async function endHandoff(chatId, resumeMode = 'continue') {
  await db.collection('handoffs').doc(String(chatId)).set({
    active: false, endedAt: new Date().toISOString(),
  }, { merge: true });
  if (resumeMode === 'restart') {
    await safeSend(chatId, 'Retomando o atendimento automático do início. Digite agendar quando quiser.');
  } else {
    await safeSend(chatId, 'Retomando o atendimento automático. Digite agendar para continuar seu agendamento.');
  }
}

// ===========================================================================
// [MERGE A] Função A — Coleta guiada e detalhada (roda após escolher slot)
// Perguntas de múltipla escolha aparecem como BOTÕES ESTILIZADOS (inline
// keyboard com emoji), nunca como "digite Sim ou Não".
// ===========================================================================

function parseDDMMYYYY(str) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((str || '').trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  if (d.getFullYear() !== Number(yyyy) || d.getMonth() !== Number(mm) - 1 || d.getDate() !== Number(dd)) return null;
  return d;
}

function validatePhone(value) {
  const v = (value || '').trim().replace(/\s|-/g, '');
  const ok = /^\+(244|351)\d{7,9}$/.test(v);
  return { valid: ok, value: v, error: ok ? null : 'Telefone inválido. Envie com o código do país, ex.: +244923456789 ou +351912345678.' };
}
function validateEmail(value) {
  const v = (value || '').trim();
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  return { valid: ok, value: v, error: ok ? null : 'Email inválido. Envie um email válido (ex.: nome@exemplo.com).' };
}
function validateBirthDate(value) {
  const d = parseDDMMYYYY(value);
  if (!d) return { valid: false, error: 'Não entendi a data. Envie no formato DD/MM/AAAA.' };
  if (d > new Date()) return { valid: false, error: 'Data de nascimento não pode ser no futuro.' };
  return { valid: true, value: value.trim() };
}
function validateDocumentValidity(value) {
  const d = parseDDMMYYYY(value);
  if (!d) return { valid: false, error: 'Não entendi a data. Envie no formato DD/MM/AAAA.' };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (d < today) return { valid: false, error: STANDARD_MESSAGES.documentoExpirado };
  return { valid: true, value: value.trim() };
}
function nonEmpty(minLen, errMsg) {
  return (v) => (v && v.trim().length >= minLen) ? { valid: true, value: v.trim() } : { valid: false, error: errMsg };
}
function optionalText(v) { return { valid: true, value: (v || '').trim() }; }

// Cada passo: { id, kind: 'text'|'buttons', ask, validate?, options?, skip? }
const STEPS = [
  { id: 'nomeCompleto', kind: 'text', ask: () => '👤 Qual o seu nome completo?', validate: nonEmpty(3, 'Por favor, envie seu nome completo.') },
  { id: 'telefone', kind: 'text', ask: () => '📱 Qual o seu telefone? (com código do país, ex.: +244 ou +351)', validate: validatePhone },
  { id: 'email', kind: 'text', ask: () => '✉️ Qual o seu email?', validate: validateEmail },
  {
    id: 'tipoDocumento', kind: 'buttons', ask: () => '🪪 Qual documento vai usar?',
    options: [
      { code: 'pass', label: '📘 Passaporte', value: 'Passaporte' },
      { code: 'bi', label: '🪪 BI', value: 'BI' },
      { code: 'cc', label: '🇵🇹 Cartão de Cidadão', value: 'Cartão de Cidadão' },
    ],
  },
  { id: 'numeroDocumento', kind: 'text', ask: () => '🔢 Qual o número do documento?', validate: nonEmpty(3, 'Por favor, envie o número do documento.') },
  { id: 'validadeDocumento', kind: 'text', ask: () => '📅 Validade do documento? (DD/MM/AAAA)', validate: validateDocumentValidity, skip: (d) => d.tipoDocumento === 'BI' },
  { id: 'orgaoEmissorBI', kind: 'text', ask: () => '🏛️ Qual o órgão emissor do BI?', validate: nonEmpty(2, 'Por favor, informe o órgão emissor.'), skip: (d) => d.tipoDocumento !== 'BI' },
  { id: 'dataNascimento', kind: 'text', ask: () => '🎂 Data de nascimento (DD/MM/AAAA)?', validate: validateBirthDate },
  { id: 'nacionalidade', kind: 'text', ask: () => '🌍 Qual a sua nacionalidade?', validate: nonEmpty(3, 'Por favor, informe sua nacionalidade.') },
  { id: 'localOrigem', kind: 'text', ask: () => '🛫 Cidade e país de origem?', validate: nonEmpty(3, 'Por favor, informe cidade e país de origem.') },
  { id: 'localDestino', kind: 'text', ask: () => '🛬 Cidade e país de destino?', validate: nonEmpty(3, 'Por favor, informe cidade e país de destino.') },
  { id: 'tipoServico', kind: 'text', ask: () => '🗂️ Qual serviço deseja agendar? (visto, marcação consular, recolha de documentos, transporte, consulta, outro)', validate: nonEmpty(3, 'Por favor, escolha um serviço.') },
  { id: 'observacoesEspeciais', kind: 'text', ask: () => '📝 Alguma condição especial? (acompanhante, acessibilidade, urgência — ou "não")', validate: optionalText },
  {
    id: 'canalConfirmacao', kind: 'buttons', ask: () => '📩 Como prefere receber a confirmação?',
    options: [
      { code: 'wa', label: '💬 WhatsApp', value: 'WhatsApp' },
      { code: 'sms', label: '📲 SMS', value: 'SMS' },
      { code: 'em', label: '✉️ Email', value: 'Email' },
    ],
  },
  {
    id: 'processOriginCountry', kind: 'buttons', ask: () => '📍 O processo está sendo iniciado a partir de Angola ou de Portugal?',
    options: [
      { code: 'ao', label: '🇦🇴 Angola', value: 'Angola' },
      { code: 'pt', label: '🇵🇹 Portugal', value: 'Portugal' },
    ],
  },
  { id: 'provinciaComuna', kind: 'text', ask: () => '🏙️ Qual a província/comuna de residência?', validate: nonEmpty(2, 'Por favor, informe província e comuna.'), skip: (d) => d.processOriginCountry !== 'Angola' },
  { id: 'nifAngola', kind: 'text', ask: () => '🧾 Tem NIF? Se sim, informe (ou "não tenho")', validate: optionalText, skip: (d) => d.processOriginCountry !== 'Angola' },
  { id: 'motivoAgendamento', kind: 'text', ask: () => '❓ Qual o motivo do agendamento? (ex.: renovação de BI, serviço consular)', validate: nonEmpty(3, 'Por favor, informe o motivo do agendamento.'), skip: (d) => d.processOriginCountry !== 'Angola' },
  {
    id: 'comprovativoPagamentoAngola', kind: 'buttons', ask: () => '💳 Já tem comprovativo de pagamento de taxas?',
    options: [{ code: 's', label: '✅ Sim', value: 'Sim' }, { code: 'n', label: '❌ Não', value: 'Não' }],
    skip: (d) => d.processOriginCountry !== 'Angola',
  },
  { id: 'nifPortugal', kind: 'text', ask: () => '🧾 Tem NIF português? Se sim, informe (ou "não tenho")', validate: optionalText, skip: (d) => d.processOriginCountry !== 'Portugal' },
  { id: 'numeroUtente', kind: 'text', ask: () => '🏥 Tem número de utente (se aplicável)? (opcional)', validate: optionalText, skip: (d) => d.processOriginCountry !== 'Portugal' },
  { id: 'dadosVistoAtual', kind: 'text', ask: () => '🛂 Se for cidadão angolano: tem visto atual? Descreva (opcional)', validate: optionalText, skip: (d) => d.processOriginCountry !== 'Portugal' },
  { id: 'autorizacaoResidencia', kind: 'text', ask: () => '🏠 Tem Autorização de Residência? Informe o número (opcional)', validate: optionalText, skip: (d) => d.processOriginCountry !== 'Portugal' },
  {
    id: 'consentimentoDados', kind: 'buttons', ask: () => '🔒 Confirma os dados e autoriza o uso das suas informações para este agendamento?',
    options: [{ code: 's', label: '✅ Sim, autorizo', value: 'Sim' }, { code: 'n', label: '❌ Não autorizo', value: 'Não' }],
  },
];

const FIELD_LABELS = Object.fromEntries(STEPS.map(s => [s.id, s.ask().replace(/^[^\wÀ-ú]+/, '').replace(/[?:]$/, '')]));

function activeSteps(data) { return STEPS.filter((s) => !s.skip || !s.skip(data)); }

function buildButtonsKeyboard(step) {
  const rows = step.options.map(o => [Markup.button.callback(o.label, `ext:${step.id}:${o.code}`)]);
  return Markup.inlineKeyboard(rows);
}

function buildSummary(data) {
  const lines = activeSteps(data)
    .filter((s) => s.id !== 'consentimentoDados' && data[s.id] !== undefined && data[s.id] !== '')
    .map((s) => `• ${FIELD_LABELS[s.id] || s.id}: ${data[s.id]}`);
  return `📋 Resumo do seu agendamento:\n\n${lines.join('\n')}`;
}

function buildSummaryKeyboard() {
  return Markup.inlineKeyboard([[
    Markup.button.callback('✅ Confirmar', 'summary:confirm'),
    Markup.button.callback('✏️ Alterar', 'summary:edit'),
  ]]);
}

function buildEditFieldsKeyboard(data) {
  const rows = activeSteps(data)
    .filter(s => s.id !== 'consentimentoDados')
    .map(s => [Markup.button.callback(`✏️ ${FIELD_LABELS[s.id] || s.id}`, `editfield:${s.id}`)]);
  rows.push([Markup.button.callback('⬅️ Voltar ao resumo', 'summary:back')]);
  return Markup.inlineKeyboard(rows);
}

const TRAVEL_DOC_GUIDANCE = {
  'angola-portugal':
    'Para Angola → Portugal, tenha em mãos: página principal do passaporte; páginas com vistos anteriores (se houver); e o título/reserva de transporte de ida e volta. Entregue na candidatura ou no dia do agendamento — nunca depois da viagem já realizada.',
  'angola-brasil':
    'Para Angola → Brasil: página principal do passaporte + páginas com carimbos/vistos anteriores; reserva de passagem aérea de ida e volta anexada ao processo.',
};
function getTravelDocGuidance(localOrigem, localDestino) {
  const o = (localOrigem || '').toLowerCase();
  const d = (localDestino || '').toLowerCase();
  if (o.includes('angola') && d.includes('portugal')) return TRAVEL_DOC_GUIDANCE['angola-portugal'];
  if (o.includes('angola') && d.includes('brasil')) return TRAVEL_DOC_GUIDANCE['angola-brasil'];
  return null;
}

// ---- Estado do fluxo de agendamento (Telegram) -----------------------------
const bookingState = {};
function clearBookingState(chatId) {
  if (bookingState[chatId] && bookingState[chatId].timer) clearTimeout(bookingState[chatId].timer);
  delete bookingState[chatId];
}
function touchBookingState(chatId, replyFn) {
  const st = bookingState[chatId];
  if (!st) return;
  if (st.timer) clearTimeout(st.timer);
  st.timer = setTimeout(() => {
    clearBookingState(chatId);
    replyFn('⏱️ Agendamento cancelado por inatividade. Digite agendar para começar de novo.').catch(() => {});
  }, BOOKING_TIMEOUT_MIN * 60 * 1000);
}

async function startSlotSelection(ctx) {
  if (ctx.chat.type !== 'private') {
    const uname = ctx.botInfo && ctx.botInfo.username;
    const link = uname ? `https://t.me/${uname}?start=agendar` : 'no privado do bot';
    return ctx.reply(`Para agendar, fale comigo no privado: ${link}`);
  }
  const chatId = ctx.chat.id;
  const byDay = await getAvailableSlotsByDay();
  const days = Object.keys(byDay).sort();
  if (days.length === 0) return ctx.reply('Não há horários livres nos próximos dias. Tente novamente mais tarde.');

  clearBookingState(chatId);
  bookingState[chatId] = { step: 'choose_day', data: {} };
  touchBookingState(chatId, (t) => ctx.reply(t));

  const buttons = days.slice(0, 14).map(dayKey => {
    const label = DateTime.fromFormat(dayKey, 'yyyy-LL-dd').setLocale('pt-BR').toFormat("ccc, dd/LL");
    return [Markup.button.callback(`📅 ${label} (${byDay[dayKey].length} vagas)`, `day:${dayKey}`)];
  });
  await ctx.reply('Escolha um dia:', Markup.inlineKeyboard(buttons));
}

async function advanceExtendedFlow(ctxOrReplyTarget, chatId, isCallback) {
  const st = bookingState[chatId];
  const steps = activeSteps(st.data);
  if (st.extIndex >= steps.length) {
    st.step = 'summary';
    touchBookingState(chatId, (t) => bot.telegram.sendMessage(chatId, t));
    const text = buildSummary(st.data);
    if (isCallback) await safeEditMessageText(ctxOrReplyTarget, text, buildSummaryKeyboard());
    else await bot.telegram.sendMessage(chatId, text, buildSummaryKeyboard());
    return;
  }
  const step = steps[st.extIndex];
  const askText = step.ask(st.data);
  if (step.kind === 'buttons') {
    const kb = buildButtonsKeyboard(step);
    if (isCallback) await safeEditMessageText(ctxOrReplyTarget, askText, kb);
    else await bot.telegram.sendMessage(chatId, askText, kb);
  } else {
    await bot.telegram.sendMessage(chatId, askText);
  }
}

async function finalizeBooking(ctx, chatId) {
  const st = bookingState[chatId];
  const data = st.data;
  const uid = String(chatId);

  await db.collection('users').doc(uid).set({
    consent: data.consentimentoDados === 'Sim',
    booking: { ...data, registeredAt: new Date().toISOString() },
  }, { merge: true });

  if (data.consentimentoDados !== 'Sim') {
    clearBookingState(chatId);
    await ctx.reply(STANDARD_MESSAGES.recusaConsentimento,
      Markup.inlineKeyboard([[Markup.button.callback('🧑‍💼 Falar com atendente', 'go:atendente')]]));
    return;
  }

  try {
    const apptId = await createAppointmentAtomic({
      userUid: uid, dt: st.dt, category: data.tipoServico, notes: data.observacoesEspeciais,
      createdBy: uid, extra: { extended: data },
    });
    await logAction('appointment_created', uid, { appointmentId: apptId });
    clearBookingState(chatId);

    const guidance = getTravelDocGuidance(data.localOrigem, data.localDestino);
    let msg = `✅ Agendamento criado! ID: ${apptId}\nData: ${st.dt.toLocaleString(DateTime.DATETIME_MED)}\n\n` +
      'O agendamento em si precisa ser feito por você diretamente no site oficial, assim que houver vaga — não faço isso automaticamente. Se identificarmos uma vaga compatível com sua rota, você será avisado.';
    if (guidance) msg += `\n\n📄 Documentos de viagem: ${guidance}`;
    msg += `\n\n${STANDARD_MESSAGES.naoSubstituiAconselhamento}`;
    await ctx.reply(msg);
  } catch (err) {
    if (err.message === 'SLOT_TAKEN') {
      clearBookingState(chatId);
      await ctx.reply('⚠️ Esse horário acabou de ser ocupado por outra pessoa. Digite agendar para escolher outro.');
    } else {
      console.error(err);
      await ctx.reply('Erro ao criar agendamento. Tente novamente digitando agendar.');
    }
  }
}

// ---------------------------------------------------------------------------
// Comandos principais (Telegram)
// ---------------------------------------------------------------------------
async function handleWelcome(ctx, showAnalysis) {
  const uid = String(ctx.from.id);
  const userRef = db.collection('users').doc(uid);
  const snap = await userRef.get();
  if (!snap.exists) {
    await userRef.set({
      uid, name: ctx.from.first_name + (ctx.from.last_name ? ' ' + ctx.from.last_name : ''),
      status: 'active', createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await logAction('user_registered', uid, { via: 'start' });
  } else if (snap.data().status === 'blocked') {
    await userRef.update({ status: 'active' });
  }

  await ctx.reply(
    `Olá ${ctx.from.first_name}! 👋 Bem-vindo ao bot de agendamentos.\n\n` +
    'Você pode simplesmente digitar "agendar" para começar, ou usar os botões abaixo.'
  );

  if (showAnalysis) {
    // [MERGE G] "análise" rápida: quantidade de vagas livres nos próximos dias
    // + menu de atalhos em botão, sem precisar decorar comandos.
    const byDay = await getAvailableSlotsByDay();
    const totalSlots = Object.values(byDay).reduce((acc, arr) => acc + arr.length, 0);
    const totalDays = Object.keys(byDay).length;
    await ctx.reply(
      `📊 Análise rápida:\n• ${totalSlots} horário(s) livre(s) em ${totalDays} dia(s) nos próximos ${DAYS_AHEAD} dias.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('📅 Agendar', 'go:agendar')],
        [Markup.button.callback('🗓️ Ver calendário', 'go:calendario')],
        [Markup.button.callback('🧑‍💼 Falar com atendente', 'go:atendente')],
      ])
    );
  }
}

bot.start(async (ctx) => {
  await handleWelcome(ctx, true);
  if (ctx.startPayload === 'agendar') await startSlotSelection(ctx);
});

bot.command('help', (ctx) => ctx.reply(
  'Comandos:\n' +
  '• agendar — criar agendamento (ou use /agendar)\n' +
  '• atendente — falar com um humano (ou use /atendente)\n' +
  '/calendario - calendário navegável dos agendamentos\n' +
  '/myappointments - ver meus agendamentos\n' +
  '/cancel <id> - cancelar agendamento\n' +
  '/reschedule <id> - cancela e reagenda\n' +
  '/profile - ver dados de cadastro\n' +
  '/vincular - (dentro de um grupo) vincula o grupo ao seu perfil\n' +
  '/meugrupo - ver seu grupo vinculado'
));

bot.command(['agendar', 'book'], (ctx) => startSlotSelection(ctx));
bot.command('atendente', (ctx) => startHandoff(ctx, 'comando /atendente'));

// [MERGE G] Atalhos de botão (menu da "análise" do /start)
bot.action('go:agendar', safeAction(async (ctx) => { await ctx.answerCbQuery(); await startSlotSelection(ctx); }));
bot.action('go:calendario', safeAction(async (ctx) => { await ctx.answerCbQuery(); await showCalendar(ctx, DateTime.now().setZone(TIMEZONE).toFormat('yyyy-LL')); }));
bot.action('go:atendente', safeAction(async (ctx) => { await ctx.answerCbQuery(); await startHandoff(ctx, 'botão "Falar com atendente"'); }));

bot.action(/^day:(.+)$/, safeAction(async (ctx) => {
  const chatId = ctx.chat.id;
  const dayKey = ctx.match[1];
  const st = bookingState[chatId];
  if (!st || st.step !== 'choose_day') return ctx.answerCbQuery('Sessão expirada. Digite agendar de novo.');

  const byDay = await getAvailableSlotsByDay();
  const slots = byDay[dayKey] || [];
  if (slots.length === 0) {
    await ctx.answerCbQuery();
    return safeEditMessageText(ctx, 'Esse dia não tem mais vagas. Digite agendar de novo.');
  }
  st.step = 'choose_time';
  st.dayKey = dayKey;
  touchBookingState(chatId, (t) => ctx.reply(t));

  const buttons = [];
  for (let i = 0; i < slots.length; i += 3) {
    buttons.push(slots.slice(i, i + 3).map(dt => Markup.button.callback(`🕐 ${dt.toFormat('HH:mm')}`, `time:${dt.toISO()}`)));
  }
  await ctx.answerCbQuery();
  await safeEditMessageText(ctx, `Dia ${dayKey} — escolha o horário:`, Markup.inlineKeyboard(buttons));
}));

bot.action(/^time:(.+)$/, safeAction(async (ctx) => {
  const chatId = ctx.chat.id;
  const iso = ctx.match[1];
  const st = bookingState[chatId];
  if (!st || st.step !== 'choose_time') return ctx.answerCbQuery('Sessão expirada. Digite agendar de novo.');

  const dt = DateTime.fromISO(iso, { zone: TIMEZONE });
  st.dt = dt;
  st.step = 'extended';
  st.extIndex = 0;
  touchBookingState(chatId, (t) => ctx.reply(t));

  await ctx.answerCbQuery();
  await safeEditMessageText(ctx, `Horário escolhido: ${dt.toLocaleString(DateTime.DATETIME_MED)}\n\nAgora vou te fazer algumas perguntas rápidas para preparar seu agendamento.`);
  await advanceExtendedFlow(ctx, chatId, false);
}));

// [MERGE A] Botões de múltipla escolha da coleta guiada
bot.action(/^ext:([a-zA-Z]+):(.+)$/, safeAction(async (ctx) => {
  const chatId = ctx.chat.id;
  const [, stepId, code] = ctx.match;
  const st = bookingState[chatId];
  if (!st || st.step !== 'extended') return ctx.answerCbQuery('Sessão expirada. Digite agendar de novo.');

  const steps = activeSteps(st.data);
  const step = steps[st.extIndex];
  if (!step || step.id !== stepId) return ctx.answerCbQuery('Essa pergunta já foi respondida.');

  const option = step.options.find(o => o.code === code);
  if (!option) return ctx.answerCbQuery('Opção inválida.');

  st.data[stepId] = option.value;
  st.extIndex += 1;
  touchBookingState(chatId, (t) => ctx.reply(t));
  await ctx.answerCbQuery(`Selecionado: ${option.value}`);
  await advanceExtendedFlow(ctx, chatId, true);
}));

// [MERGE A] Edição de campo específico a partir do resumo (via botões)
bot.action('summary:edit', safeAction(async (ctx) => {
  const chatId = ctx.chat.id;
  const st = bookingState[chatId];
  if (!st || st.step !== 'summary') return ctx.answerCbQuery('Sessão expirada.');
  await ctx.answerCbQuery();
  await safeEditMessageText(ctx, 'Qual campo deseja alterar?', buildEditFieldsKeyboard(st.data));
}));

bot.action('summary:back', safeAction(async (ctx) => {
  const chatId = ctx.chat.id;
  const st = bookingState[chatId];
  if (!st) return ctx.answerCbQuery('Sessão expirada.');
  await ctx.answerCbQuery();
  await safeEditMessageText(ctx, buildSummary(st.data), buildSummaryKeyboard());
}));

bot.action(/^editfield:(.+)$/, safeAction(async (ctx) => {
  const chatId = ctx.chat.id;
  const fieldId = ctx.match[1];
  const st = bookingState[chatId];
  if (!st) return ctx.answerCbQuery('Sessão expirada.');
  const step = STEPS.find(s => s.id === fieldId);
  if (!step) return ctx.answerCbQuery('Campo não encontrado.');

  st.step = 'editing';
  st.editingFieldId = fieldId;
  touchBookingState(chatId, (t) => ctx.reply(t));
  await ctx.answerCbQuery();

  if (step.kind === 'buttons') {
    await safeEditMessageText(ctx, step.ask(st.data), buildButtonsKeyboard(step));
  } else {
    await safeEditMessageText(ctx, step.ask(st.data));
  }
}));

// Botões de múltipla escolha durante EDIÇÃO de campo (a partir do resumo)
bot.action(/^editval:([a-zA-Z]+):(.+)$/, safeAction(async (ctx) => {
  const chatId = ctx.chat.id;
  const [, stepId, code] = ctx.match;
  const st = bookingState[chatId];
  if (!st || st.step !== 'editing' || st.editingFieldId !== stepId) return ctx.answerCbQuery('Sessão expirada.');
  const step = STEPS.find(s => s.id === stepId);
  const option = step.options.find(o => o.code === code);
  if (!option) return ctx.answerCbQuery('Opção inválida.');
  st.data[stepId] = option.value;
  st.step = 'summary';
  st.editingFieldId = null;
  await ctx.answerCbQuery(`Atualizado: ${option.value}`);
  await safeEditMessageText(ctx, buildSummary(st.data), buildSummaryKeyboard());
}));

bot.action('summary:confirm', safeAction(async (ctx) => {
  const chatId = ctx.chat.id;
  const st = bookingState[chatId];
  if (!st || st.step !== 'summary') return ctx.answerCbQuery('Sessão expirada.');
  await ctx.answerCbQuery();
  await finalizeBooking(ctx, chatId);
}));

// [FIX 1 mantido] Comando digitado no meio do fluxo cancela o agendamento em
// andamento e deixa o comando real ser processado. Também trata o texto
// livre da coleta guiada (Função A) e o "editingFieldId" quando o campo
// atual é do tipo texto (kind: 'text').
// [FIX 6] Se o handoff está ativo para o chat, a mensagem de texto do
// usuário é salva em "handoff_messages" (para o atendente ver no painel)
// e o fluxo automático NÃO responde — o atendente conduz a conversa.
bot.on('text', async (ctx, next) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();

  // [MERGE C] Se o handoff está ativo, o fluxo automático não responde —
  // o atendente conduz a conversa pelo painel.
  if (ctx.chat.type === 'private' && isHandoffActive(chatId)) {
    // [FIX 6] salva a mensagem do usuário para o atendente ver no painel
    try {
      await db.collection('handoff_messages').add({
        chatId: String(chatId),
        from: 'user',
        text,
        fromId: ctx.from.id,
        fromName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '),
        username: ctx.from.username || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.error('❌ Erro ao salvar mensagem de handoff:', err);
      await logAction('handoff_message_save_error', String(ctx.from.id), { chatId: String(chatId), error: err.message }).catch(() => {});
    }
    return;
  }

  const st = bookingState[chatId];

  if (text.startsWith('/')) {
    if (st) {
      clearBookingState(chatId);
      await ctx.reply('⚠️ Agendamento em andamento foi cancelado porque você enviou um comando. Digite agendar para começar de novo, se quiser.').catch(() => {});
    }
    return next();
  }

  if (!st) return next();
  touchBookingState(chatId, (t) => ctx.reply(t));

  // Edição de campo de texto a partir do resumo
  if (st.step === 'editing') {
    const step = STEPS.find(s => s.id === st.editingFieldId);
    if (step.kind === 'buttons') return; // aguardando clique no botão, ignora texto
    const result = step.validate(text, st.data);
    if (!result.valid) return ctx.reply(result.error);
    st.data[step.id] = result.value;
    st.step = 'summary';
    st.editingFieldId = null;
    return ctx.reply(buildSummary(st.data), buildSummaryKeyboard());
  }

  // Fluxo normal da coleta guiada (Função A) — só passos de texto chegam aqui
  if (st.step === 'extended') {
    const steps = activeSteps(st.data);
    const step = steps[st.extIndex];
    if (!step) return advanceExtendedFlow(ctx, chatId, false);
    if (step.kind === 'buttons') return ctx.reply('Por favor, use os botões acima para responder. 👆');
    const result = step.validate(text, st.data);
    if (!result.valid) return ctx.reply(result.error);
    st.data[step.id] = result.value;
    st.extIndex += 1;
    return advanceExtendedFlow(ctx, chatId, false);
  }

  return next();
});

// [MERGE G] Gatilhos de texto SEM barra: "agendar", "start", "atendente"
// + Função B: detecção de pedido de automação no site oficial.
bot.on('text', async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  const chatId = ctx.chat.id;
  if (bookingState[chatId] || isHandoffActive(chatId)) return next(); // já tratado acima
  const norm = ctx.message.text.trim().toLowerCase();

  if (looksLikeAutomationRequest(norm)) {
    return ctx.reply(STANDARD_MESSAGES.pedidoAutomacaoSiteOficial);
  }
  if (['agendar', 'book', 'marcar'].includes(norm)) return startSlotSelection(ctx);
  if (['start', 'oi', 'olá', 'ola', 'menu'].includes(norm)) return handleWelcome(ctx, true);
  if (['atendente', 'humano', 'falar com atendente'].includes(norm)) return startHandoff(ctx, 'texto "atendente"');

  return next();
});

bot.action('confirm_no', safeAction(async (ctx) => {
  clearBookingState(ctx.chat.id);
  await ctx.answerCbQuery();
  await safeEditMessageText(ctx, 'Agendamento cancelado. Digite agendar para começar de novo.');
}));

bot.command('myappointments', async (ctx) => {
  try {
    const uid = String(ctx.from.id);
    const snaps = await db.collection('appointments')
      .where('userUid', '==', uid).where('status', 'in', ['scheduled', 'confirmed'])
      .orderBy('datetime', 'asc').limit(20).get();
    if (snaps.empty) return ctx.reply('Nenhum agendamento encontrado.');
    const lines = snaps.docs.map(d => {
      const a = d.data();
      const dt = DateTime.fromJSDate(a.datetime.toDate()).setZone(TIMEZONE).toLocaleString(DateTime.DATETIME_MED);
      return `ID: ${d.id}\n${dt}\nCat: ${a.category || '—'}\nStatus: ${a.status}`;
    });
    await ctx.reply(lines.join('\n---\n'));
  } catch (err) {
    console.error('Erro em /myappointments:', err);
    await ctx.reply('⚠️ Erro ao buscar seus agendamentos. Tente novamente em instantes.');
  }
});

bot.command('cancel', async (ctx) => {
  try {
    const parts = ctx.message.text.split(/\s+/).filter(Boolean);
    if (parts.length < 2) return ctx.reply('Use /cancel <appointmentId>\n\nDica: pegue o ID em /myappointments.');
    const id = parts[1].trim();
    const doc = await db.collection('appointments').doc(id).get();
    if (!doc.exists) return ctx.reply('Compromisso não encontrado. Confira o ID em /myappointments.');
    const appt = doc.data();
    const uid = String(ctx.from.id);
    if (appt.userUid !== uid && !isAdmin(uid)) return ctx.reply('Você não tem permissão para cancelar este compromisso.');
    if (appt.status === 'cancelled') return ctx.reply('Esse compromisso já estava cancelado.');
    await db.collection('appointments').doc(id).update({ status: 'cancelled', cancelledAt: admin.firestore.FieldValue.serverTimestamp() });
    await logAction('appointment_cancelled', uid, { appointmentId: id });
    await ctx.reply('✅ Compromisso cancelado. O horário voltou a ficar disponível.');
  } catch (err) {
    console.error('Erro em /cancel:', err);
    await ctx.reply('⚠️ Erro ao cancelar. Tente novamente em instantes.');
  }
});

bot.command('reschedule', async (ctx) => {
  try {
    const parts = ctx.message.text.split(/\s+/).filter(Boolean);
    if (parts.length < 2) return ctx.reply('Use /reschedule <appointmentId>\n\nIsso cancela o agendamento antigo e abre a escolha de um novo horário.');
    const id = parts[1].trim();
    const doc = await db.collection('appointments').doc(id).get();
    if (!doc.exists) return ctx.reply('Compromisso não encontrado. Confira o ID em /myappointments.');
    const appt = doc.data();
    const uid = String(ctx.from.id);
    if (appt.userUid !== uid && !isAdmin(uid)) return ctx.reply('Sem permissão para remarcar este compromisso.');
    if (appt.status === 'cancelled') return ctx.reply('Esse compromisso já está cancelado. Digite agendar para criar um novo.');

    await db.collection('appointments').doc(id).update({ status: 'cancelled', cancelledAt: admin.firestore.FieldValue.serverTimestamp() });
    await logAction('appointment_rescheduled_old_cancelled', uid, { appointmentId: id });
    await ctx.reply('🔁 Compromisso antigo cancelado. Escolha o novo horário abaixo:');
    await startSlotSelection(ctx);
  } catch (err) {
    console.error('Erro em /reschedule:', err);
    await ctx.reply('⚠️ Erro ao remarcar. Tente novamente em instantes.');
  }
});

bot.command('confirm', async (ctx) => {
  try {
    const uid = String(ctx.from.id);
    if (!isAdmin(uid)) return ctx.reply('Somente admins podem confirmar agendamentos.');
    const parts = ctx.message.text.split(/\s+/).filter(Boolean);
    if (parts.length < 2) return ctx.reply('Uso: /confirm <appointmentId>');
    const id = parts[1].trim();
    const doc = await db.collection('appointments').doc(id).get();
    if (!doc.exists) return ctx.reply('Compromisso não encontrado.');
    const appt = doc.data();
    if (appt.status === 'cancelled') return ctx.reply('Esse compromisso está cancelado, não é possível confirmar.');
    if (appt.status === 'confirmed') return ctx.reply('Esse compromisso já está confirmado.');
    await db.collection('appointments').doc(id).update({ status: 'confirmed', confirmedAt: admin.firestore.FieldValue.serverTimestamp() });
    await logAction('appointment_confirmed', uid, { appointmentId: id });
    await ctx.reply('✅ Compromisso marcado como confirmado.');
  } catch (err) {
    console.error('Erro em /confirm:', err);
    await ctx.reply('⚠️ Erro ao confirmar. Tente novamente em instantes.');
  }
});

bot.command('profile', async (ctx) => {
  const uid = String(ctx.from.id);
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return ctx.reply('Perfil não encontrado. Digite start para registrar.');
  const u = snap.data();
  await ctx.reply(`UID: ${u.uid}\nNome: ${u.name}\nStatus: ${u.status || '—'}\nGrupo vinculado: ${u.linkedGroupId || '—'}\nDocumentos enviados: ${(u.documents || []).length}`);
});

// [MERGE E] Upload de mídia → Supabase (fallback: link do Telegram)
bot.on('photo', async (ctx) => {
  const uid = String(ctx.from.id);
  try {
    const sizes = ctx.message.photo;
    const fileId = sizes[sizes.length - 1].file_id;
    const result = await saveUploadedDocument(uid, 'photo', fileId);
    await ctx.reply(`📷 Foto recebida e salva (${result.storage === 'supabase' ? 'Supabase' : 'link direto'}).`);
  } catch (err) {
    console.error('Erro ao salvar foto:', err);
    await ctx.reply('Erro ao salvar foto.');
  }
});

bot.on('document', async (ctx) => {
  const uid = String(ctx.from.id);
  try {
    const fileId = ctx.message.document.file_id;
    const result = await saveUploadedDocument(uid, 'document', fileId, { fileName: ctx.message.document.file_name || null });
    await ctx.reply(`📄 Documento recebido e salvo (${result.storage === 'supabase' ? 'Supabase' : 'link direto'}).`);
  } catch (err) {
    console.error('Erro ao salvar documento:', err);
    await ctx.reply('Erro ao salvar documento.');
  }
});

bot.on('video', async (ctx) => {
  const uid = String(ctx.from.id);
  try {
    const fileId = ctx.message.video.file_id;
    const result = await saveUploadedDocument(uid, 'video', fileId);
    await ctx.reply(`🎥 Vídeo recebido e salvo (${result.storage === 'supabase' ? 'Supabase' : 'link direto'}).`);
  } catch (err) {
    console.error('Erro ao salvar vídeo:', err);
    await ctx.reply('Erro ao salvar vídeo.');
  }
});

// ---------------------------------------------------------------------------
// Calendário navegável (Telegram)
// ---------------------------------------------------------------------------
function buildCalendarKeyboard(year, month, markedDays) {
  const first = DateTime.fromObject({ year, month, day: 1 }, { zone: TIMEZONE });
  const daysInMonth = first.daysInMonth;
  const startWeekday = first.weekday;
  const rows = [];
  let row = [];
  for (let i = 1; i < startWeekday; i++) row.push(Markup.button.callback(' ', 'noop'));
  for (let day = 1; day <= daysInMonth; day++) {
    const key = first.set({ day }).toFormat('yyyy-LL-dd');
    const label = markedDays.has(key) ? `•${day}` : `${day}`;
    row.push(Markup.button.callback(label, `cal_day:${key}`));
    if (row.length === 7) { rows.push(row); row = []; }
  }
  if (row.length) { while (row.length < 7) row.push(Markup.button.callback(' ', 'noop')); rows.push(row); }
  rows.push([
    Markup.button.callback('‹ Anterior', `cal_month:${first.minus({ months: 1 }).toFormat('yyyy-LL')}`),
    Markup.button.callback('Seguinte ›', `cal_month:${first.plus({ months: 1 }).toFormat('yyyy-LL')}`)
  ]);
  return rows;
}

async function showCalendar(ctx, yearMonth) {
  const [year, month] = yearMonth.split('-').map(Number);
  const uid = String(ctx.from.id);
  const admin_ = isAdmin(uid);
  const start = DateTime.fromObject({ year, month, day: 1 }, { zone: TIMEZONE }).startOf('day').toJSDate();
  const end = DateTime.fromObject({ year, month, day: 1 }, { zone: TIMEZONE }).endOf('month').toJSDate();

  let q = db.collection('appointments').where('status', 'in', ['scheduled', 'confirmed'])
    .where('datetime', '>=', start).where('datetime', '<=', end);
  if (!admin_) q = q.where('userUid', '==', uid);
  const snap = await q.get();
  const marked = new Set(snap.docs.map(d => DateTime.fromJSDate(d.data().datetime.toDate()).setZone(TIMEZONE).toFormat('yyyy-LL-dd')));

  const kb = buildCalendarKeyboard(year, month, marked);
  const text = `📅 ${DateTime.fromObject({ year, month }, { zone: TIMEZONE }).setLocale('pt-BR').toFormat('LLLL yyyy')}` +
    (admin_ ? ' (visão admin — todos os agendamentos)' : '');

  if (ctx.updateType === 'callback_query') await safeEditMessageText(ctx, text, Markup.inlineKeyboard(kb));
  else await ctx.reply(text, Markup.inlineKeyboard(kb));
}

bot.command('calendario', async (ctx) => {
  try { await showCalendar(ctx, DateTime.now().setZone(TIMEZONE).toFormat('yyyy-LL')); }
  catch (err) { console.error('Erro em /calendario:', err); await ctx.reply('⚠️ Erro ao carregar o calendário.'); }
});

bot.action(/^cal_month:(.+)$/, safeAction(async (ctx) => { await ctx.answerCbQuery(); await showCalendar(ctx, ctx.match[1]); }));
bot.action('noop', safeAction(async (ctx) => ctx.answerCbQuery()));

bot.action(/^cal_day:(.+)$/, safeAction(async (ctx) => {
  const dayKey = ctx.match[1];
  const uid = String(ctx.from.id);
  const admin_ = isAdmin(uid);
  const dayStart = DateTime.fromFormat(dayKey, 'yyyy-LL-dd', { zone: TIMEZONE }).startOf('day').toJSDate();
  const dayEnd = DateTime.fromFormat(dayKey, 'yyyy-LL-dd', { zone: TIMEZONE }).endOf('day').toJSDate();
  let q = db.collection('appointments').where('status', 'in', ['scheduled', 'confirmed'])
    .where('datetime', '>=', dayStart).where('datetime', '<=', dayEnd);
  if (!admin_) q = q.where('userUid', '==', uid);
  const snap = await q.get();
  await ctx.answerCbQuery();
  if (snap.empty) return ctx.reply(`Nenhum agendamento em ${dayKey}.`);
  const lines = snap.docs.map(d => {
    const a = d.data();
    const t = DateTime.fromJSDate(a.datetime.toDate()).setZone(TIMEZONE).toFormat('HH:mm');
    return `${t} — ${a.category || '—'} (ID: ${d.id})` + (admin_ ? ` [uid:${a.userUid}]` : '');
  });
  await ctx.reply(`📅 Agendamentos em ${dayKey}:\n\n${lines.join('\n')}`);
}));

// ---------------------------------------------------------------------------
// Comandos ADMIN (Telegram) — postar mensagens
// ---------------------------------------------------------------------------
bot.command('notify_uid', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!isAdmin(uid)) return ctx.reply('Somente admins.');
  const parts = ctx.message.text.split(' ').filter(Boolean);
  if (parts.length < 3) return ctx.reply('Uso: /notify_uid <telegramUid> <mensagem>');
  const res = await safeSend(parts[1], parts.slice(2).join(' '));
  if (res === true) {
    await db.collection('notifications').add({
      type: 'direct', message: parts.slice(2).join(' '), target: { uid: parts[1] },
      sentAt: admin.firestore.FieldValue.serverTimestamp(), createdBy: uid
    });
    await logAction('notify_uid_sent', uid, { targetUid: parts[1] });
  }
  await ctx.reply(res === true ? 'Notificação enviada ao usuário.' : 'Falha ao enviar notificação.');
});

bot.command('notify_all', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!isAdmin(uid)) return ctx.reply('Somente admins.');
  const message = ctx.message.text.split(' ').slice(1).join(' ');
  if (!message) return ctx.reply('Uso: /notify_all <mensagem>');
  const usersSnap = await db.collection('users').where('status', '==', 'active').get();
  let sent = 0, fail = 0;
  for (const doc of usersSnap.docs) {
    const res = await safeSend(doc.data().uid, message);
    if (res === true) sent++; else fail++;
  }
  await db.collection('notifications').add({
    type: 'broadcast', message, target: { all: true },
    sentAt: admin.firestore.FieldValue.serverTimestamp(), createdBy: uid, stats: { sent, fail }
  });
  await logAction('broadcast_sent', uid, { sent, fail });
  await ctx.reply(`Enviado para ${sent} usuário(s), falhou em ${fail}.`);
});

bot.command('post_group', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!isAdmin(uid)) return ctx.reply('Somente admins.');
  const parts = ctx.message.text.split(' ').filter(Boolean);
  if (parts.length < 3) return ctx.reply('Uso: /post_group <chatId> <mensagem>');
  const chatId = parts[1];
  const message = escapeHtml(parts.slice(2).join(' '));
  const res = await safeSend(chatId, message, { parse_mode: 'HTML' });
  if (res === true) {
    await db.collection('notifications').add({
      type: 'group_post', message, target: { groupId: chatId },
      sentAt: admin.firestore.FieldValue.serverTimestamp(), createdBy: uid
    });
    await logAction('group_post', uid, { chatId });
  }
  await ctx.reply(res === true ? 'Mensagem postada no grupo.' : 'Falha ao postar no grupo: ' + res.error.message);
});

bot.command('post_group_of', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!isAdmin(uid)) return ctx.reply('Somente admins.');
  const parts = ctx.message.text.split(' ').filter(Boolean);
  if (parts.length < 3) return ctx.reply('Uso: /post_group_of <telegramUid> <mensagem>');
  const targetUid = parts[1];
  const userSnap = await db.collection('users').doc(targetUid).get();
  const groupId = userSnap.exists ? userSnap.data().linkedGroupId : null;
  if (!groupId) return ctx.reply('Esse usuário não tem grupo vinculado.');
  const message = escapeHtml(parts.slice(2).join(' '));
  const res = await safeSend(groupId, message, { parse_mode: 'HTML' });
  await ctx.reply(res === true ? 'Mensagem postada no grupo do usuário.' : 'Falha ao postar: ' + res.error.message);
});

bot.command('post_all_groups', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!isAdmin(uid)) return ctx.reply('Somente admins.');
  const message = ctx.message.text.split(' ').slice(1).join(' ');
  if (!message) return ctx.reply('Uso: /post_all_groups <mensagem>');
  const stats = await broadcastToGroups(escapeHtml(message), uid);
  await ctx.reply(`Enviado para ${stats.sent} grupo(s), falhou em ${stats.fail}.`);
});

bot.command('listar_grupos', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!isAdmin(uid)) return ctx.reply('Somente admins.');
  const snap = await db.collection('groups').where('status', '==', 'active').get();
  if (snap.empty) return ctx.reply('Nenhum grupo ativo registrado.');
  const lines = snap.docs.map(d => {
    const g = d.data();
    return `${g.title || '(sem título)'} — ID: ${g.chatId}${g.linkedUserUid ? ` — vinculado a uid:${g.linkedUserUid}` : ''}`;
  });
  await ctx.reply(lines.join('\n'));
});

bot.command('stats', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!isAdmin(uid)) return ctx.reply('Somente admins.');
  const [usersSnap, upcomingSnap, groupsSnap] = await Promise.all([
    db.collection('users').where('status', '==', 'active').get(),
    db.collection('appointments').where('status', 'in', ['scheduled', 'confirmed']).get(),
    db.collection('groups').where('status', '==', 'active').get(),
  ]);
  await ctx.reply(`👥 Usuários ativos: ${usersSnap.size}\n👨‍👩‍👧 Grupos ativos: ${groupsSnap.size}\n📅 Agendamentos futuros: ${upcomingSnap.size}`);
});

// [MERGE B] Admin dispara manualmente a checagem de vaga (equivalente ao
// endpoint do painel, disponível também por comando de conveniência).
bot.command('vaga_detectada', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!isAdmin(uid)) return ctx.reply('Somente admins.');
  const parts = ctx.message.text.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return ctx.reply('Uso: /vaga_detectada <routeId>\n\nUse só depois de checar o site oficial pessoalmente.');
  const result = await registerVacancySeenManually(parts[1]);
  if (!result.ok) return ctx.reply('Erro: ' + result.error);
  await ctx.reply(`✅ Alerta enviado a ${result.notified} interessado(s).`);
});

// [MERGE C] Admin encerra handoff manualmente pelo Telegram (além do painel)
bot.command('encerrar_atendimento', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!isAdmin(uid)) return ctx.reply('Somente admins.');
  const parts = ctx.message.text.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return ctx.reply('Uso: /encerrar_atendimento <chatId> [restart]');
  await endHandoff(parts[1], parts[2] === 'restart' ? 'restart' : 'continue');
  await ctx.reply('✅ Atendimento encerrado, fluxo automático retomado para o usuário.');
});

// ---------------------------------------------------------------------------
// Comandos ADMIN (Telegram) — configurar mensagens automáticas diárias
// ---------------------------------------------------------------------------
function parsePeriod(text) { return PERIODS.includes(text) ? text : null; }

bot.command('daily_status', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!isAdmin(uid)) return ctx.reply('Somente admins.');
  const cfg = await getDailyConfig();
  const lines = PERIODS.map(p => {
    const c = cfg[p];
    return `${PERIOD_LABEL[p]} — ${c.hour}:${String(c.minute).padStart(2, '0')} — alvo: ${c.target} — ${c.enabled ? 'ATIVO' : 'desativado'}\n"${c.text}"`;
  });
  await ctx.reply(lines.join('\n\n'));
});

bot.command('set_daily_text', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!isAdmin(uid)) return ctx.reply('Somente admins.');
  const parts = ctx.message.text.split(' ');
  const period = parsePeriod(parts[1]);
  const text = parts.slice(2).join(' ');
  if (!period || !text) return ctx.reply('Uso: /set_daily_text <manha|tarde|noite> <texto>');
  await updateDailyConfig(period, { text });
  const cfg = await getDailyConfig();
  scheduleDailyJob(period, cfg[period]);
  await logAction('daily_config_text_changed', uid, { period, text });
  await ctx.reply(`Texto de "${period}" atualizado.`);
});

bot.command('set_daily_time', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!isAdmin(uid)) return ctx.reply('Somente admins.');
  const parts = ctx.message.text.split(' ').filter(Boolean);
  const period = parsePeriod(parts[1]);
  const time = parts[2];
  if (!period || !time || !/^\d{1,2}:\d{2}$/.test(time)) return ctx.reply('Uso: /set_daily_time <manha|tarde|noite> <HH:mm>');
  const [hour, minute] = time.split(':').map(Number);
  await updateDailyConfig(period, { hour, minute });
  const cfg = await getDailyConfig();
  scheduleDailyJob(period, cfg[period]);
  await logAction('daily_config_time_changed', uid, { period, hour, minute });
  await ctx.reply(`Horário de "${period}" atualizado para ${time} (${TIMEZONE}).`);
});

bot.command('set_daily_target', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!isAdmin(uid)) return ctx.reply('Somente admins.');
  const parts = ctx.message.text.split(' ').filter(Boolean);
  const period = parsePeriod(parts[1]);
  const target = parts[2];
  if (!period || !['usuarios', 'grupos', 'todos'].includes(target)) {
    return ctx.reply('Uso: /set_daily_target <manha|tarde|noite> <usuarios|grupos|todos>');
  }
  await updateDailyConfig(period, { target });
  await logAction('daily_config_target_changed', uid, { period, target });
  await ctx.reply(`Público-alvo de "${period}" definido como "${target}".`);
});

bot.command('set_daily_on', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!isAdmin(uid)) return ctx.reply('Somente admins.');
  const period = parsePeriod(ctx.message.text.split(' ')[1]);
  if (!period) return ctx.reply('Uso: /set_daily_on <manha|tarde|noite>');
  await updateDailyConfig(period, { enabled: true });
  const cfg = await getDailyConfig();
  scheduleDailyJob(period, cfg[period]);
  await ctx.reply(`Mensagem automática de "${period}" ATIVADA.`);
});

bot.command('set_daily_off', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!isAdmin(uid)) return ctx.reply('Somente admins.');
  const period = parsePeriod(ctx.message.text.split(' ')[1]);
  if (!period) return ctx.reply('Uso: /set_daily_off <manha|tarde|noite>');
  await updateDailyConfig(period, { enabled: false });
  if (dailyJobs[period]) dailyJobs[period].cancel();
  await ctx.reply(`Mensagem automática de "${period}" DESATIVADA.`);
});

bot.command('test_daily', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!isAdmin(uid)) return ctx.reply('Somente admins.');
  const period = parsePeriod(ctx.message.text.split(' ')[1]);
  if (!period) return ctx.reply('Uso: /test_daily <manha|tarde|noite>');
  await sendDailyMessage(period);
  await ctx.reply(`Mensagem de "${period}" disparada manualmente.`);
});

// ===========================================================================
// PONTE painel -> bot: dashboard_commands
// ===========================================================================
async function executeDashboardCommand(type, payload) {
  switch (type) {
    case 'notify_uid': {
      const res = await safeSend(payload.targetUid, payload.message);
      if (res !== true) throw new Error(res.error.message);
      await db.collection('notifications').add({
        type: 'direct', message: payload.message, target: { uid: payload.targetUid },
        sentAt: admin.firestore.FieldValue.serverTimestamp(), createdBy: 'dashboard',
      });
      await logAction('notify_uid_sent', 'dashboard', { targetUid: payload.targetUid });
      return;
    }
    case 'notify_all': {
      const usersSnap = await db.collection('users').where('status', '==', 'active').get();
      let sent = 0, fail = 0;
      for (const doc of usersSnap.docs) {
        const res = await safeSend(doc.data().uid, payload.message);
        if (res === true) sent++; else fail++;
      }
      await db.collection('notifications').add({
        type: 'broadcast', message: payload.message, target: { all: true },
        sentAt: admin.firestore.FieldValue.serverTimestamp(), createdBy: 'dashboard', stats: { sent, fail },
      });
      await logAction('broadcast_sent', 'dashboard', { sent, fail });
      return;
    }
    case 'post_group': {
      const message = escapeHtml(payload.message);
      const res = await safeSend(payload.chatId, message, { parse_mode: 'HTML' });
      if (res !== true) throw new Error(res.error.message);
      await db.collection('notifications').add({
        type: 'group_post', message, target: { groupId: payload.chatId },
        sentAt: admin.firestore.FieldValue.serverTimestamp(), createdBy: 'dashboard',
      });
      await logAction('group_post', 'dashboard', { chatId: payload.chatId });
      return;
    }
    case 'post_group_of': {
      const userSnap = await db.collection('users').doc(payload.targetUid).get();
      const groupId = userSnap.exists ? userSnap.data().linkedGroupId : null;
      if (!groupId) throw new Error('Esse usuário não tem grupo vinculado.');
      const message = escapeHtml(payload.message);
      const res = await safeSend(groupId, message, { parse_mode: 'HTML' });
      if (res !== true) throw new Error(res.error.message);
      await db.collection('notifications').add({
        type: 'group_post', message, target: { groupId },
        sentAt: admin.firestore.FieldValue.serverTimestamp(), createdBy: 'dashboard',
      });
      return;
    }
    case 'post_all_groups': {
      await broadcastToGroups(escapeHtml(payload.message), 'dashboard');
      return;
    }
    case 'set_daily_time': {
      const { period, hour, minute } = payload;
      if (!PERIODS.includes(period)) throw new Error('Período inválido.');
      await updateDailyConfig(period, { hour, minute });
      const cfg = await getDailyConfig();
      scheduleDailyJob(period, cfg[period]);
      await logAction('daily_config_time_changed', 'dashboard', { period, hour, minute });
      return;
    }
    case 'set_daily_on': {
      if (!PERIODS.includes(payload.period)) throw new Error('Período inválido.');
      await updateDailyConfig(payload.period, { enabled: true });
      const cfg = await getDailyConfig();
      scheduleDailyJob(payload.period, cfg[payload.period]);
      return;
    }
    case 'set_daily_off': {
      if (!PERIODS.includes(payload.period)) throw new Error('Período inválido.');
      await updateDailyConfig(payload.period, { enabled: false });
      if (dailyJobs[payload.period]) dailyJobs[payload.period].cancel();
      return;
    }
    case 'test_daily': {
      if (!PERIODS.includes(payload.period)) throw new Error('Período inválido.');
      await sendDailyMessage(payload.period);
      return;
    }
    // [MERGE B] Painel confirma vaga vista manualmente no site oficial.
    case 'vaga_detectada': {
      const result = await registerVacancySeenManually(payload.routeId);
      if (!result.ok) throw new Error(result.error);
      return;
    }
    // [MERGE C] Painel controla o handoff humano em tempo real.
    case 'handoff_start': {
      await db.collection('handoffs').doc(String(payload.chatId)).set({
        active: true, agent: payload.agent || null, since: new Date().toISOString(),
        reason: payload.reason || 'iniciado pelo painel',
      }, { merge: true });
      await safeSend(payload.chatId, 'Ok! Um atendente humano vai continuar com você a partir daqui. Pode escrever normalmente. 🧑‍💼');
      return;
    }
    case 'handoff_end': {
      await endHandoff(payload.chatId, payload.resumeMode || 'continue');
      return;
    }
    case 'handoff_typing': {
      await bot.telegram.sendChatAction(payload.chatId, 'typing').catch(() => {});
      return;
    }
    case 'handoff_send': {
      // [FIX 6] Ao enviar a resposta do atendente pelo painel, além de
      // mandar ao Telegram, gravamos também em "handoff_messages" com
      // from: 'agent', para que o histórico completo (usuário + atendente)
      // fique disponível num único lugar para o painel renderizar o chat.
      if (!payload.message) throw new Error('Campo "message" é obrigatório.');
      const res = await safeSend(payload.chatId, payload.message);
      if (res !== true) throw new Error(res.error.message);
      await db.collection('handoff_messages').add({
        chatId: String(payload.chatId),
        from: 'agent',
        text: payload.message,
        agent: payload.agent || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch((err) => console.error('❌ Erro ao salvar mensagem do atendente em handoff_messages:', err));
      return;
    }
    // [MERGE D] Painel dispara alerta direcionado para uma subcoleção/lista.
    case 'broadcast_selected': {
      if (!Array.isArray(payload.uids) || !payload.uids.length || !payload.message) {
        throw new Error('Informe "uids" (array) e "message".');
      }
      await sendTargetedAlert(payload.uids.map(String), payload.message);
      return;
    }
    default:
      throw new Error('Tipo de comando desconhecido: ' + type);
  }
}

function watchDashboardCommands() {
  db.collection('dashboard_commands')
    .where('status', '==', 'pending')
    .onSnapshot((snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type !== 'added') return;
        const doc = change.doc;
        const cmd = doc.data();
        try {
          await executeDashboardCommand(cmd.type, cmd.payload || {});
          await doc.ref.update({ status: 'done', processedAt: admin.firestore.FieldValue.serverTimestamp() });
        } catch (err) {
          console.error(`Erro ao processar dashboard_command "${cmd.type}":`, err.message);
          await doc.ref.update({
            status: 'error', error: err.message,
            processedAt: admin.firestore.FieldValue.serverTimestamp(),
          }).catch(() => {});
        }
      });
    }, (err) => console.error('❌ Erro no listener de dashboard_commands:', err));
  console.log('🖥️  Ponte painel → bot (dashboard_commands) ativada.');
}

// ===========================================================================
// PONTE painel -> bot: aprovação de novas contas admin do painel
// ===========================================================================
function watchAdminSignupRequests() {
  db.collection('admin_requests')
    .where('status', '==', 'pending')
    .onSnapshot((snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type !== 'added') return;
        const doc = change.doc;
        const uid = doc.id;
        const data = doc.data();
        try {
          const codeOk = ADMIN_SIGNUP_CODE && data.code === ADMIN_SIGNUP_CODE;
          if (codeOk) {
            await db.collection('panel_admins').doc(uid).set({
              email: data.email || null,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            await doc.ref.update({ status: 'approved', processedAt: admin.firestore.FieldValue.serverTimestamp() });
            await logAction('panel_admin_approved', uid, { email: data.email });
            console.log(`✅ Novo admin do painel aprovado: ${data.email || uid}`);
          } else {
            await doc.ref.update({
              status: 'rejected', error: 'Código de cadastro inválido.',
              processedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            await logAction('panel_admin_rejected', uid, { email: data.email });
            await admin.auth().deleteUser(uid).catch(() => {});
          }
        } catch (err) {
          console.error('Erro ao processar admin_request:', err.message);
          await doc.ref.update({ status: 'error', error: err.message }).catch(() => {});
        }
      });
    }, (err) => console.error('❌ Erro no listener de admin_requests:', err));
  console.log('🔐 Ponte de aprovação de admins do painel ativada.');
}

// ---------------------------------------------------------------------------
// Tratamento global de erros
// ---------------------------------------------------------------------------
bot.catch((err, ctx) => {
  console.error(`Erro não tratado para ${ctx.updateType}:`, err);
  logAction('unhandled_error', ctx.from ? String(ctx.from.id) : null, { error: err.message }).catch(() => {});
});

// [MERGE D] Roteamento de mensagens de GRUPO — só Função D (palavras-chave).
// Precisa do Privacy Mode DESATIVADO no @BotFather (/setprivacy → Disable)
// para o bot enxergar todas as mensagens do grupo, não só comandos/menções.
bot.on('text', async (ctx, next) => {
  if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
    await handleGroupKeywordScan(ctx);
    return; // mensagens de grupo não passam pelo fluxo de agendamento
  }
  return next();
});

// ---------------------------------------------------------------------------
// Startup / shutdown
// ---------------------------------------------------------------------------
(async () => {
  watchAppointmentsForReminders();
  watchDashboardCommands();
  watchAdminSignupRequests();
  watchKeywords();          // [MERGE D]
  watchHandoffs();          // [MERGE C]
  watchEmailSettings();     // [MERGE F]
  await scheduleAllDailyJobs();

  await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch((err) => {
    console.warn('⚠️  Não foi possível limpar webhook residual (seguindo mesmo assim):', err.message);
  });

  bot.launch();
  console.log('🤖 Bot Telegram iniciado (polling).');
  console.log('✅ AgoBra pronto — servidor HTTP + painel + bot + Supabase + email rodando.');
})();

function shutdown(signal) {
  console.log(`\n🛑 ${signal} recebido. Encerrando graciosamente...`);
  bot.stop(signal);
  server.close(() => {
    console.log('✅ Servidor HTTP encerrado.');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));