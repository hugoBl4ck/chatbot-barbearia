// =================================================================
// WEBHOOK PARA AGENDAMENTO DE BARBEARIA (VERSÃO LANDBOT COM CORREÇÃO FINAL)
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

app.post("/api/webhook", async (request, response) => {
    const body = request.body;
    console.log("\n🔄 === NOVO REQUEST WEBHOOK (LANDBOT) ===", JSON.stringify(body, null, 2));

    try {
        const { intent, nome, telefone, data_hora_texto, servicoId } = body;
        const db = admin.firestore();
        let resultPayload;

        if (intent === 'agendarHorario') {
            const parsedDate = chrono.pt.parseDate(data_hora_texto, new Date(), { forwardDate: true });
            if (!parsedDate) {
                resultPayload = { success: false, message: "Não consegui entender a data e hora." };
            } else {
                const personInfo = { name: nome, phone: telefone };
                resultPayload = await handleScheduling(personInfo, parsedDate, servicoId, db);
            }
        } else if (intent === 'cancelarHorario') {
             const personInfo = { name: nome, phone: telefone };
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

    if (!servicoSnap.exists) { 
        return { success: false, message: "O serviço selecionado não foi encontrado." };
    }
    const servico = { id: servicoSnap.id, ...servicoSnap.data() };

    const businessHoursCheck = await checkBusinessHours(requestedDate, servico.duracaoMinutos, db);
    if (!businessHoursCheck.isOpen) return { success: false, message: businessHoursCheck.message };

    const hasConflict = await checkConflicts(requestedDate, servico.duracaoMinutos, db);
    if (hasConflict) return { success: false, message: "Este horário já está ocupado. Por favor, escolha outro." };

    await saveAppointment(personInfo, requestedDate, servico, db);
    
    const formattedDateForUser = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'short', timeZone: CONFIG.timezone }).format(requestedDate);
    return { success: true, message: `Perfeito, ${personInfo.name}! Seu agendamento de ${servico.nome} foi confirmado para ${formattedDateForUser}.` };
}

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

async function checkBusinessHours(date, duracaoMinutos, db) {
    const dayOfWeek = date.getDay();
    const docRef = db.collection(CONFIG.collections.config).doc(String(dayOfWeek));
    const docSnap = await docRef.get();
    
    // =========================================================
    // CORREÇÃO APLICADA AQUI
    // =========================================================
    if (!docSnap.exists) return { isOpen: false, message: `Desculpe, não funcionamos neste dia.` };
    
    const dayConfig = docSnap.data();
    const timeToDecimal = (str) => { if (!str) return 0; const [h, m] = str.split(':').map(Number); return h + (m || 0) / 60; };
    const requestedTime = date.getHours() + date.getMinutes() / 60;
    const serviceDurationInHours = duracaoMinutos / 60;
    const isWithinHours = (time, start, end) => { if (!start || !end) return false; return time >= timeToDecimal(start) && (time + serviceDurationInHours) <= timeToDecimal(end); };
    if (isWithinHours(requestedTime, dayConfig.InicioManha, dayConfig.FimManha) || isWithinHours(requestedTime, dayConfig.InicioTarde, dayConfig.FimTarde)) {
        return { isOpen: true };
    } else { return { isOpen: false, message: "O horário solicitado, considerando a duração do serviço, está fora do nosso expediente." }; }
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