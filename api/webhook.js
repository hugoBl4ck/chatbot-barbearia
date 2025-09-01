// =================================================================
// WEBHOOK FINAL COM SUGESTÃO DE HORÁRIOS
// =================================================================

const express = require("express");
const admin = require('firebase-admin');
const dayjs = require('dayjs');
const timezone = require('dayjs/plugin/timezone');
const utc = require('dayjs/plugin/utc');
require('dayjs/locale/pt-br');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.locale('pt-br');

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

// Sua função de parsing de data (está ótima)
function parseDateTime(texto) {
    const lower = texto.toLowerCase();
    let date = dayjs().tz(CONFIG.timezone);
    if (lower.includes('amanhã')) { date = date.add(1, 'day'); }
    // ... (outras lógicas de parsing podem ser adicionadas aqui)
    const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?/);
    if (timeMatch) {
        const hora = parseInt(timeMatch[1], 10);
        const minuto = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
        date = date.hour(hora).minute(minuto).second(0).millisecond(0);
    } else { return null; }
    return date.toDate();
}


app.post("/api/webhook", async (request, response) => {
    // ... (Sua rota principal está ótima e não precisa de mudanças) ...
});
    
// =================================================================
// FUNÇÃO DE AGENDAMENTO MODIFICADA
// =================================================================
async function handleScheduling(personInfo, requestedDate, servicoId, db) {
    if (!personInfo.name || !personInfo.phone) return { success: false, message: "Faltam seus dados pessoais." };
    if (!servicoId) return { success: false, message: "Você precisa selecionar um serviço." };
    if (requestedDate.getTime() <= new Date().getTime()) return { success: false, message: "Não é possível agendar no passado." };

    const servicoRef = db.collection(CONFIG.collections.services).doc(servicoId);
    const servicoSnap = await servicoRef.get();
    if (!servicoSnap.exists) return { success: false, message: "O serviço não foi encontrado." };
    
    const servico = { id: servicoSnap.id, ...servicoSnap.data() };

    const businessHoursCheck = await checkBusinessHours(requestedDate, servico.duracaoMinutos, db);
    if (!businessHoursCheck.isOpen) return { success: false, message: businessHoursCheck.message };

    const hasConflict = await checkConflicts(requestedDate, servico.duracaoMinutos, db);
    
    // ===== INÍCIO DA NOVA LÓGICA DE SUGESTÃO =====
    if (hasConflict) {
        console.log("Conflito encontrado. Buscando horários alternativos...");
        const suggestions = await findAvailableSlots(requestedDate, db);
        
        if (suggestions.length > 0) {
            const suggestionsText = suggestions.slice(0, 3).join(', ');
            const message = `O horário das ${dayjs(requestedDate).tz(CONFIG.timezone).format('HH:mm')} já está ocupado. Mas tenho vagas hoje às ${suggestionsText}. Algum desses funciona?`;
            return { success: false, message: message };
        } else {
            const tomorrow = dayjs(requestedDate).add(1, 'day').toDate();
            const nextDaySuggestions = await findAvailableSlots(tomorrow, db);
            if (nextDaySuggestions.length > 0) {
                const suggestionsText = nextDaySuggestions.slice(0, 3).join(', ');
                const message = `Não tenho mais vagas para hoje. Para amanhã, tenho horários às ${suggestionsText}. Quer marcar um desses?`;
                return { success: false, message: message };
            } else {
                return { success: false, message: "Este horário está ocupado e não encontrei outras vagas próximas. Por favor, tente outro dia." };
            }
        }
    }
    // ===== FIM DA NOVA LÓGICA DE SUGESTÃO =====

    await saveAppointment(personInfo, requestedDate, servico, db);
    
    const formattedDateForUser = dayjs(requestedDate).tz(CONFIG.timezone).format('dddd, DD [de] MMMM [às] HH:mm');
    return { success: true, message: `Perfeito, ${personInfo.name}! Seu agendamento de ${servico.nome} foi confirmado para ${formattedDateForUser}.` };
}

// =================================================================
// NOVA FUNÇÃO PARA ENCONTRAR HORÁRIOS VAGOS
// =================================================================
async function findAvailableSlots(date, db) {
    const dayOfWeek = date.getDay();
    const docRef = db.collection(CONFIG.collections.config).doc(String(dayOfWeek));
    const docSnap = await docRef.get();
    if (!docSnap.exists) return [];

    const dayConfig = docSnap.data();
    const timeToMinutes = (str) => { if (!str) return null; const [h, m] = str.split(':').map(Number); return (h * 60) + (m || 0); };
    const formatTime = (totalMinutes) => `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
    
    const inicioDia = timeToMinutes(dayConfig.InicioManha);
    const fimDia = timeToMinutes(dayConfig.FimTarde || dayConfig.FimManha);
    
    const inicioDiaDate = dayjs(date).startOf('day').toDate();
    const fimDiaDate = dayjs(date).endOf('day').toDate();
    const q = query(collection(db, "Agendamentos"), 
        where('DataHoraISO', '>=', inicioDiaDate.toISOString()), 
        where('DataHoraISO', '<=', fimDiaDate.toISOString()),
        where('Status', '==', 'Agendado')
    );
    const snapshot = await getDocs(q);
    const agendamentos = snapshot.docs.map(doc => doc.data());

    const availableSlots = [];
    let minutoAtual = inicioDia;
    const agoraEmMinutos = dayjs().tz(CONFIG.timezone).hour() * 60 + dayjs().tz(CONFIG.timezone).minute();

    while (minutoAtual < fimDia) {
        const dataSlot = dayjs(date).startOf('day').add(minutoAtual, 'minute');

        // Pula se o horário já passou (apenas para o dia de hoje)
        if (dayjs(date).isSame(dayjs(), 'day') && minutoAtual < agoraEmMinutos) {
            minutoAtual += 30;
            continue;
        }

        let hasConflict = false;
        for (const ag of agendamentos) {
            const existingStart = dayjs(ag.DataHoraISO).tz(CONFIG.timezone);
            const existingEnd = existingStart.add(ag.duracaoMinutos, 'minute');
            
            if (dataSlot.isBefore(existingEnd) && dataSlot.add(30, 'minute').isAfter(existingStart)) {
                hasConflict = true;
                break;
            }
        }
        
        if (!hasConflict) {
            availableSlots.push(dataSlot.format('HH:mm'));
        }
        minutoAtual += 30;
    }
    return availableSlots;
}

// O restante do seu código (checkBusinessHours, checkConflicts, etc.) permanece o mesmo.
// ...

// =================================================================
// CÓDIGO COMPLETO (COM TODAS AS FUNÇÕES)
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
async function handleCancellation(personInfo, db) {
    if (!personInfo.phone) return { success: false, message: "Para cancelar, preciso do seu telefone." };
    const schedulesRef = db.collection(CONFIG.collections.schedules);
    const q = schedulesRef.where('TelefoneCliente', '==', personInfo.phone).where('Status', '==', 'Agendado').where('DataHoraISO', '>', new Date().toISOString());
    const snapshot = await q.get();
    if (snapshot.empty) return { success: false, message: `Não encontrei nenhum agendamento futuro no seu telefone.` };
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
        DataHoraFormatada: dayjs(requestedDate).tz(CONFIG.timezone).format('DD/MM/YYYY HH:mm'),
        Status: 'Agendado', TimestampAgendamento: new Date().toISOString(),
        servicoId: servico.id, servicoNome: servico.nome, duracaoMinutos: servico.duracaoMinutos,
    };
    await db.collection(CONFIG.collections.schedules).add(newAppointment);
}

module.exports = app;