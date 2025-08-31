// =================================================================
// WEBHOOK PARA AGENDAMENTO DE BARBEARIA (VERSÃO COM LÓGICA DE HORÁRIO CORRIGIDA)
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

// Inicializa Firebase Admin
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(CONFIG.firebaseCreds) });
}

// ====================== FUNÇÃO AJUSTE DE TIMEZONE ======================
function toSaoPauloDate(date) {
    // Converte uma Date para fuso de São Paulo sem alterar o horário esperado
    const options = { timeZone: CONFIG.timezone, hour12: false };
    const formatter = new Intl.DateTimeFormat('pt-BR', {
        ...options,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    const parts = formatter.formatToParts(date);
    const values = {};
    for (const part of parts) {
        if (part.type !== 'literal') values[part.type] = part.value;
    }

    return new Date(
        `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}-03:00`
    );
}

// ====================== ROTA PRINCIPAL ======================
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
                const saoPauloDate = toSaoPauloDate(parsedDate);
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

// ====================== AGENDAMENTO ======================
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

// ====================== HORÁRIOS DE FUNCIONAMENTO ======================
async function checkBusinessHours(date, duracaoMinutos, db) {
    console.log("--- INICIANDO VERIFICAÇÃO DE HORÁRIO (V4 SIMPLIFICADA) ---");

    const dayOfWeek = date.getDay();
    const docRef = db.collection(CONFIG.collections.config).doc(String(dayOfWeek));
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
        const msg = `Desculpe, não funcionamos neste dia (dia da semana: ${dayOfWeek}).`;
        console.log(msg);
        return { isOpen: false, message: msg };
    }

    const dayConfig = docSnap.data();

    // Converte "HH:MM" para minutos
    const timeStringToMinutes = (timeStr) => {
        if (!timeStr || typeof timeStr !== 'string') return null;
        const [hours, minutes] = timeStr.split(':').map(Number);
        return hours * 60 + (minutes || 0);
    };

    const startOfDay = timeStringToMinutes(dayConfig.InicioManha ?? dayConfig.InicioTarde);
    const endOfDay = timeStringToMinutes(dayConfig.FimTarde ?? dayConfig.FimManha);

    const requestedStartMinutes = date.getHours() * 60 + date.getMinutes();
    const requestedEndMinutes = requestedStartMinutes + duracaoMinutos;

    console.log("Valores para verificação:", {
        solicitado: `${requestedStartMinutes} -> ${requestedEndMinutes}`,
        inicioDia: startOfDay,
        fimDia: endOfDay
    });

    const dentroDoHorario = (
        startOfDay !== null &&
        endOfDay !== null &&
        requestedStartMinutes >= startOfDay &&
        requestedEndMinutes <= endOfDay
    );

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

// ====================== CANCELAMENTO ======================
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
    for (const doc of snapshot.docs) {
        await doc.ref.update({ Status: 'Cancelado' });
        count++;
    }
    return { success: true, message: `Tudo certo! Cancelei ${count} agendamento(s) futuro(s) que encontrei.` };
}

// ====================== CONFLITOS ======================
async function checkConflicts(requestedDate, duracaoMinutos, db) {
    console.log("--- INICIANDO VERIFICAÇÃO DE CONFLITOS ---");

    const requestedStart = requestedDate.getTime();
    const requestedEnd = requestedStart + duracaoMinutos * 60 * 1000;

    // Buscar apenas horários próximos
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

// ====================== SALVAR AGENDAMENTO ======================
async function saveAppointment(personInfo, requestedDate, servico, db) {
    const newAppointment = {
        NomeCliente: personInfo.name,
        TelefoneCliente: personInfo.phone,
        DataHoraISO: requestedDate.toISOString(),
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
