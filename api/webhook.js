// =================================================================
// WEBHOOK PARA AGENDAMENTO DE BARBEARIA (FUSO CORRIGIDO + LÓGICA AJUSTADA)
// =================================================================

const express = require("express");
const admin = require('firebase-admin');
const chrono = require('chrono-node');

const app = express();
app.use(express.json());

const CONFIG = {
  firebaseCreds: JSON.parse(process.env.FIREBASE_CREDENTIALS || '{}'),
  timezone: 'America/Sao_Paulo',
  collections: {
    schedules: 'Agendamentos',
    config: 'Horarios',
    services: 'Servicos'
  }
};

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(CONFIG.firebaseCreds) });
}

// ---------- Helpers de fuso/tempo (sempre em America/Sao_Paulo) ----------
function pad2(n) { return String(n).padStart(2, '0'); }

function nowInSaoPaulo() {
  const now = new Date();
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: CONFIG.timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = Object.fromEntries(f.formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return new Date(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}-03:00`);
}

function getDayOfWeekInTZ(date, tz) {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[w];
}

function getHMInTZ(date, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });
  const parts = Object.fromEntries(f.formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return { hour: Number(parts.hour), minute: Number(parts.minute) };
}

function minutesToHHMM(m) {
  if (m == null) return null;
  const h = Math.floor(m / 60), mm = m % 60;
  return `${pad2(h)}:${pad2(mm)}`;
}

// Parse robusto: usa chrono para entender "amanhã", "segunda", etc.,
// mas força timezone SP e zera minutos/segundos se não foram informados.
function parseToSaoPauloZonedDate(text) {
  const ref = nowInSaoPaulo();
  const results = chrono.pt.parse(text, ref, { forwardDate: true });
  if (!results || !results.length) return null;

  const c = results[0].start;

  const year = c.get('year');
  const month = c.get('month');
  const day = c.get('day');

  const hour = c.isCertain('hour') ? c.get('hour') : 0;
  const minute = c.isCertain('minute') ? c.get('minute') : 0; // se não informou, 00
  const second = c.isCertain('second') ? c.get('second') : 0;

  // Brasil não tem DST atualmente; -03:00 é estável.
  const iso = `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}-03:00`;
  return new Date(iso);
}

// =================================================================
// ROTA PRINCIPAL
// =================================================================
app.post("/api/webhook", async (request, response) => {
  const body = request.body;
  console.log("\n🔄 === NOVO REQUEST WEBHOOK (LANDBOT) ===", JSON.stringify(body, null, 2));

  try {
    const { intent, nome, telefone, data_hora_texto, servicoId } = body;
    const db = admin.firestore();
    let resultPayload;

    if (intent === 'agendarHorario') {
      const saoPauloDate = parseToSaoPauloZonedDate(data_hora_texto);
      if (!saoPauloDate) {
        resultPayload = { success: false, message: "Não consegui entender a data e hora." };
      } else {
        const personInfo = { name: nome, phone: telefone };
        resultPayload = await handleScheduling(personInfo, saoPauloDate, servicoId, db);
      }
    } else if (intent === 'cancelarHorario') {
      const personInfo = { phone: telefone };
      resultPayload = await handleCancellation(personInfo, db);
    } else {
      resultPayload = { success: false, message: "Desculpe, não entendi sua intenção." };
    }

    const responseData = { status: resultPayload.success ? 'success' : 'error', message: resultPayload.message };
    console.log(`📤 RESPOSTA ENVIADA:`, JSON.stringify(responseData, null, 2));
    return response.json(responseData);

  } catch (error) {
    console.error("❌ Erro CRÍTICO no webhook:", error);
    return response.json({ status: 'error', message: "Desculpe, ocorreu um erro interno." });
  }
});

// =================================================================
// AGENDAMENTO
// =================================================================
async function handleScheduling(personInfo, requestedDate, servicoId, db) {
  if (!personInfo.name || !personInfo.phone) return { success: false, message: "Faltam seus dados pessoais (nome/telefone)." };
  if (!servicoId) return { success: false, message: "Você precisa selecionar um serviço para agendar." };
  if (requestedDate <= new Date()) return { success: false, message: "Não é possível agendar no passado." };

  const servicoRef = db.collection(CONFIG.collections.services).doc(servicoId);
  const servicoSnap = await servicoRef.get();
  if (!servicoSnap.exists) return { success: false, message: "O serviço selecionado não foi encontrado." };

  const servico = { id: servicoSnap.id, ...servicoSnap.data() };

  const businessHoursCheck = await checkBusinessHours(requestedDate, servico.duracaoMinutos, db);
  if (!businessHoursCheck.isOpen) return { success: false, message: businessHoursCheck.message };

  const hasConflict = await checkConflicts(requestedDate, servico.duracaoMinutos, db);
  if (hasConflict) return { success: false, message: "Este horário já está ocupado. Por favor, escolha outro." };

  await saveAppointment(personInfo, requestedDate, servico, db);

  const formattedDateForUser = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'short', timeZone: CONFIG.timezone }).format(requestedDate);
  return { success: true, message: `Perfeito, ${personInfo.name}! Seu agendamento de ${servico.nome} foi confirmado para ${formattedDateForUser}.` };
}

// =================================================================
// HORÁRIOS DE FUNCIONAMENTO (dia contínuo: início -> fim)
// =================================================================
async function checkBusinessHours(date, duracaoMinutos, db) {
  console.log("--- INICIANDO VERIFICAÇÃO DE HORÁRIO (V4 SIMPLIFICADA) ---");

  const dayOfWeek = getDayOfWeekInTZ(date, CONFIG.timezone); // 0..6 em SP
  const { hour, minute } = getHMInTZ(date, CONFIG.timezone); // HH:MM em SP
  const requestedStartMinutes = hour * 60 + minute;
  const requestedEndMinutes = requestedStartMinutes + duracaoMinutos;

  const docRef = db.collection(CONFIG.collections.config).doc(String(dayOfWeek));
  const docSnap = await docRef.get();

  if (!docSnap.exists) {
    const msg = `Desculpe, não funcionamos neste dia (dia da semana: ${dayOfWeek}).`;
    console.log(msg);
    return { isOpen: false, message: msg };
  }

  const dayConfig = docSnap.data();

  const timeStringToMinutes = (timeStr) => {
    if (!timeStr || typeof timeStr !== 'string') return null;
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + (m || 0);
  };

  // Une os turnos como um intervalo contínuo
  const startOfDay = timeStringToMinutes(dayConfig.InicioManha ?? dayConfig.InicioTarde);
  const endOfDay = timeStringToMinutes(dayConfig.FimTarde ?? dayConfig.FimManha);

  console.log("Valores para verificação:", {
    solicitado: `${requestedStartMinutes} -> ${requestedEndMinutes} (${minutesToHHMM(requestedStartMinutes)} -> ${minutesToHHMM(requestedEndMinutes)})`,
    inicioDia: startOfDay + ` (${minutesToHHMM(startOfDay)})`,
    fimDia: endOfDay + ` (${minutesToHHMM(endOfDay)})`,
    dow: dayOfWeek
  });

  const dentroDoHorario =
    startOfDay !== null &&
    endOfDay !== null &&
    requestedStartMinutes >= startOfDay &&
    requestedEndMinutes <= endOfDay;

  if (dentroDoHorario) {
    console.log("VEREDICTO: Horário VÁLIDO.");
    return { isOpen: true };
  } else {
    const horario = `das ${dayConfig.InicioManha ?? dayConfig.InicioTarde} às ${dayConfig.FimTarde ?? dayConfig.FimManha}`;
    const msg = `Nosso horário de funcionamento é ${horario}. O serviço solicitado não se encaixa nesse período.`;
    console.log("VEREDICTO: Horário INVÁLIDO.");
    return { isOpen: false, message: msg };
  }
}

// =================================================================
// CANCELAMENTO
// =================================================================
async function handleCancellation(personInfo, db) {
  if (!personInfo.phone) return { success: false, message: "Para cancelar, preciso do seu telefone." };
  const schedulesRef = db.collection(CONFIG.collections.schedules);
  const q = schedulesRef
    .where('TelefoneCliente', '==', personInfo.phone)
    .where('Status', '==', 'Agendado')
    .where('DataHoraISO', '>', new Date().toISOString());
  const snapshot = await q.get();
  if (snapshot.empty) return { success: false, message: `Não encontrei nenhum agendamento futuro no seu telefone para cancelar.` };
  let count = 0;
  for (const doc of snapshot.docs) { await doc.ref.update({ Status: 'Cancelado' }); count++; }
  return { success: true, message: `Tudo certo! Cancelei ${count} agendamento(s) futuro(s) que encontrei.` };
}

// =================================================================
// CONFLITOS (sem sobreposição; 30/60 min funcionam certinho)
// =================================================================
async function checkConflicts(requestedDate, duracaoMinutos, db) {
  console.log("--- INICIANDO VERIFICAÇÃO DE CONFLITOS ---");

  const requestedStart = requestedDate.getTime();
  const requestedEnd = requestedStart + duracaoMinutos * 60 * 1000;

  // Janela pequena pra otimizar leitura
  const searchStart = new Date(requestedStart - 3 * 60 * 60 * 1000);
  const searchEnd = new Date(requestedStart + 3 * 60 * 60 * 1000);

  const schedulesRef = db.collection(CONFIG.collections.schedules);
  const q = schedulesRef
    .where('Status', '==', 'Agendado')
    .where('DataHoraISO', '>=', searchStart.toISOString())
    .where('DataHoraISO', '<=', searchEnd.toISOString());

  const snapshot = await q.get();

  for (const doc of snapshot.docs) {
    const existingData = doc.data();
    const existingStart = new Date(existingData.DataHoraISO).getTime();
    const existingEnd = existingStart + ((existingData.duracaoMinutos || 60) * 60 * 1000);

    if (requestedStart < existingEnd && requestedEnd > existingStart) {
      console.log(`⛔ CONFLITO: ${existingData.servicoNome} em ${existingData.DataHoraISO}`);
      return true;
    }
  }

  console.log("✅ SEM CONFLITO.");
  return false;
}

// =================================================================
async function saveAppointment(personInfo, requestedDate, servico, db) {
  const newAppointment = {
    NomeCliente: personInfo.name,
    TelefoneCliente: personInfo.phone,
    DataHoraISO: requestedDate.toISOString(), // UTC ISO – bom pra ordenar
    DataHoraFormatada: new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short', timeZone: CONFIG.timezone }).format(requestedDate),
    Status: 'Agendado',
    TimestampAgendamento: new Date().toISOString(),
    servicoId: servico.id,
    servicoNome: servico.nome,
    duracaoMinutos: servico.duracaoMinutos,
  };
  await db.collection(CONFIG.collections.schedules).add(newAppointment);
}

module.exports = app;
