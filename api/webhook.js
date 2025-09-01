// =================================================================
// WEBHOOK FINAL - COMBINANDO A LÓGICA DE PARSING QUE FUNCIONOU
// =================================================================

const express = require("express");
const admin = require('firebase-admin');
const dayjs = require('dayjs');
require('dayjs/locale/pt-br');
dayjs.locale('pt-br');

const app = express();
app.use(express.json());

const CONFIG = {
    firebaseCreds: JSON.parse(process.env.FIREBASE_CREDENTIALS || '{}'),
    timezone: 'America/Sao_Paulo',
    collections: { schedules: 'Agendamentos', config: 'Horarios', services: 'Servicos' }
};

if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(CONFIG.firebaseCreds) });
}

// FUNÇÃO DE PARSING DE DATA DO ESPECIALISTA (A QUE FUNCIONOU)
function parseDateTime(texto) {
    const lower = texto.toLowerCase();
    let date = dayjs().startOf('day');

    if (lower.includes('amanhã')) {
        date = date.add(1, 'day');
    } else if (!lower.includes('hoje')) {
        const dateMatch = lower.match(/(\d{1,2})[\/\-](\d{1,2})/);
        if (dateMatch) {
            const dia = parseInt(dateMatch[1], 10);
            const mes = parseInt(dateMatch[2], 10);
            date = date.date(dia).month(mes - 1);
        }
    }

    const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?/);
    if (timeMatch) {
        const hora = parseInt(timeMatch[1], 10);
        const minuto = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
        date = date.hour(hora).minute(minuto).second(0);
    } else {
        return null; // Retorna null se não encontrar a hora
    }

    return date.toDate();
}

app.post("/api/webhook", async (request, response) => {
    // ... (O código da rota principal permanece o mesmo)
});
    
async function handleScheduling(personInfo, requestedDate, servicoId, db) {
    // ... (O código desta função permanece o mesmo)
}

async function checkBusinessHours(date, duracaoMinutos, db) {
    // ... (Vamos usar a nossa última versão desta função, que lida com o almoço)
}

// O resto do código (handleCancellation, checkConflicts, etc.) permanece o mesmo.
// ...

// =================================================================
// CÓDIGO COMPLETO ABAIXO
// =================================================================

app.post("/api/webhook", async (request, response) => {
    const body = request.body;
    console.log("\n🔄 === NOVO REQUEST WEBHOOK (LANDBOT) ===", JSON.stringify(body, null, 2));
    try {
        const { intent, nome, telefone, data_hora_texto, servicoId } = body;
        const db = admin.firestore();
        let resultPayload;
        if (intent === 'agendarHorario') {
            const parsedDate = parseDateTime(data_hora_texto);
            if (!parsedDate || isNaN(parsedDate.getTime())) {
                resultPayload = { success: false, message: "Não consegui entender a data e hora." };
            } else {
                console.log("Data interpretada com dayjs (SIMPLES):", parsedDate.toString());
                const personInfo = { name: nome, phone: telefone };
                resultPayload = await handleScheduling(personInfo, parsedDate, servicoId, db);
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
async function checkBusinessHours(date, duracaoMinutos, db) {
    const dayOfWeek = date.getDay();
    const docRef = db.collection(CONFIG.collections.config).doc(String(dayOfWeek));
    const docSnap = await docRef.get();
    if (!docSnap.exists) return { isOpen: false, message: `Desculpe, não funcionamos neste dia.` };
    const dayConfig = docSnap.data();
    const timeToMinutes = (str) => { if (!str) return null; const [h, m] = str.split(':').map(Number); return (h * 60) + (m || 0); };
    const requestedStartMinutes = date.getHours() * 60 + date.getMinutes();
    const requestedEndMinutes = requestedStartMinutes + duracaoMinutos;
    const morningStart = timeToMinutes(dayConfig.InicioManha);
    const morningEnd = timeToMinutes(dayConfig.FimManha);
    const afternoonStart = timeToMinutes(dayConfig.InicioTarde);
    const afternoonEnd = timeToMinutes(dayConfig.FimTarde);
    const fitsInMorning = (morningStart !== null && morningEnd !== null) && (requestedStartMinutes >= morningStart && requestedEndMinutes <= morningEnd);
    const fitsInAfternoon = (afternoonStart !== null && afternoonEnd !== null) && (requestedStartMinutes >= afternoonStart && requestedEndMinutes <= afternoonEnd);
    if (fitsInMorning || fitsInAfternoon) {
        return { isOpen: true };
    } else {
        const morning = dayConfig.InicioManha ? `das ${dayConfig.InicioManha} às ${dayConfig.FimManha}` : '';
        const afternoon = dayConfig.InicioTarde ? ` e das ${dayConfig.InicioTarde} às ${dayConfig.FimTarde}` : '';
        return { isOpen: false, message: `Nosso horário de funcionamento é ${morning}${afternoon}. O serviço solicitado não se encaixa nesse período.` };
    }
}
async function handleCancellation(personInfo, db) { /* ... */ }
async function checkConflicts(requestedDate, duracaoMinutos, db) { /* ... */ }
async function saveAppointment(personInfo, requestedDate, servico, db) { /* ... */ }

// Cole o restante das funções aqui
async function handleCancellation(personInfo, db) {
    if (!personInfo.phone) return { success: false, message: "Para cancelar, preciso do seu telefone." };
    const schedulesRef = db.collection(CONFIG.collections.schedules);
    const q = schedulesRef.where('TelefoneCliente', '==', personInfo.phone).where('Status', '==', 'Agendado').where('DataHoraISO', '>', new Date().toISOString());
    const snapshot = await q.get();
    if (snapshot.empty) return { success: false, message: `Não encontrei nenhum agendamento futuro no seu telefone para cancelar.` };
    let count = 0;
    for (const doc of snapshot.docs) { await doc.ref.update({ Status: 'Cancelado' }); count++; }
    return { success: true, message: `Tudo certo! Cancelei ${count} agendamento(s) futuro(s) que encontrei.` };
}
async function checkConflicts(requestedDate, duracaoMinutos, db) {
    const serviceDurationMs = duracaoMinutos * 60 * 1000;
    const requestedStart = requestedDate.getTime();
    const requestedEnd = requestedStart + serviceDurationMs;
    const searchStart = new Date(requestedStart - 2 * 60 * 60 * 1000);
    const searchEnd = new Date(requestedStart + 2 * 60 * 60 * 1000);
    const schedulesRef = db.collection(CONFIG.collections.schedules);
    const q = schedulesRef.where('Status', '==', 'Agendado').where('DataHoraISO', '>=', searchStart.toISOString()).where('DataHoraISO', '<=', searchEnd.toISOString());
    const snapshot = await q.get();
    for (const doc of snapshot.docs) {
        const existingData = doc.data();
        const existingStart = new Date(existingData.DataHoraISO).getTime();
        const existingEnd = existingStart + ((existingData.duracaoMinutos || 60) * 60 * 1000);
        if (requestedStart < existingEnd && requestedEnd > existingStart) { return true; }
    }
    return false;
}
async function saveAppointment(personInfo, requestedDate, servico, db) {
    const newAppointment = {
        NomeCliente: personInfo.name, TelefoneCliente: personInfo.phone, DataHoraISO: requestedDate.toISOString(),
        DataHoraFormatada: new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short', timeZone: CONFIG.timezone }).format(requestedDate),
        Status: 'Agendado', TimestampAgendamento: new Date().toISOString(),
        servicoId: servico.id, servicoNome: servico.nome, duracaoMinutos: servico.duracaoMinutos,
    };
    await db.collection(CONFIG.collections.schedules).add(newAppointment);
}

module.exports = app;