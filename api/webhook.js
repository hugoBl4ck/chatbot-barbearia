// =================================================================
// WEBHOOK MULTI-TENANT COM IA GEMINI - VERSÃO PARA SERVIDOR EXPRESS
// =================================================================
const express = require("express");
const admin = require('firebase-admin');
const dayjs = require('dayjs');
const timezone = require('dayjs/plugin/timezone');
const utc = require('dayjs/plugin/utc');
require('dayjs/locale/pt-br');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- CONFIGURAÇÃO ---
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.locale('pt-br');

const app = express();
app.use(express.json());

const CONFIG = {
    // As credenciais agora vêm das variáveis de ambiente da Vercel
    firebaseCreds: JSON.parse(process.env.FIREBASE_CREDENTIALS || '{}'),
    timezone: 'America/Sao_Paulo',
    collections: {
        barbearias: 'barbearias',
        schedules: 'agendamentos',
        config: 'horarios',
        services: 'servicos'
    }
};

// Inicializa o Firebase Admin SDK
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(CONFIG.firebaseCreds) });
}
const db = admin.firestore();

// Inicializa o Google Gemini AI SDK
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- FUNÇÃO COM IA PARA INTERPRETAR O TEXTO ---
async function getIntentAndDateFromGemini(text) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const systemPrompt = `
        Você é um assistente especialista em agendamentos para barbearias. Sua única tarefa é analisar a mensagem do usuário e extrair informações, retornando-as estritamente no formato JSON.
        O JSON de saída deve ter a seguinte estrutura:
        { "intent": "agendarHorario" | "cancelarHorario" | "informacao", "dataHoraISO": "YYYY-MM-DDTHH:mm:ss.sssZ" | null }
        Regras:
        - Analise o texto para determinar a intenção principal.
        - Se a intenção for 'agendarHorario', 'dataHoraISO' é obrigatório. Converta qualquer data/hora relativa (como 'amanhã às 15h', 'sexta que vem 10:30') para o formato ISO 8601 completo, usando o fuso horário '${CONFIG.timezone}'.
        - A data e hora de referência para o cálculo é: ${new Date().toISOString()}.
        - Se a intenção for 'cancelarHorario', 'dataHoraISO' pode ser nulo.
        - Se não for possível determinar uma data clara para o agendamento, retorne o 'intent' como 'informacao' e 'dataHoraISO' como nulo.
        - Responda APENAS com o objeto JSON, sem nenhum texto ou explicação adicional.`;
        
        const prompt = `${systemPrompt}\n\nMensagem do Usuário: "${text}"`;
        const result = await model.generateContent(prompt);
        const responseText = await result.response.text();
        const cleanedJsonString = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleanedJsonString);

    } catch (error) {
        console.error("❌ Erro ao chamar a API Gemini:", error);
        return null;
    }
}

// --- ROTA PRINCIPAL DO WEBHOOK ---
app.post("/api/webhook", async (request, response) => {
    const body = request.body;
    console.log("\n🔄 === NOVO REQUEST WEBHOOK (Express) ===\n", JSON.stringify(body, null, 2));

    try {
        const { nome, telefone, data_hora_texto, servicoId, barbeariaId } = body;
        let resultPayload;

        if (!barbeariaId) {
            console.error("❌ Erro: barbeariaId não fornecido no request.");
            return response.status(400).json({ status: 'error', message: "ID da barbearia não foi fornecido." });
        }
        
        const aiResult = await getIntentAndDateFromGemini(data_hora_texto);

        if (!aiResult) {
            return response.status(500).json({ status: 'error', message: "Desculpe, não consegui processar sua solicitação com a IA." });
        }

        const intent = aiResult.intent;
        const parsedDate = aiResult.dataHoraISO ? dayjs(aiResult.dataHoraISO) : null;

        if (intent === 'agendarHorario') {
            if (!parsedDate) {
                resultPayload = { success: false, message: "Não consegui entender a data e hora. Tente algo como 'amanhã às 16h' ou 'sexta-feira 10:30'." };
            } else {
                const dateForStorage = parsedDate.utc().toDate();
                const dateForValidation = parsedDate.toDate();
                const personInfo = { name: nome, phone: telefone };
                resultPayload = await handleScheduling(barbeariaId, personInfo, dateForStorage, dateForValidation, servicoId);
            }
        } else if (intent === 'cancelarHorario') {
            const personInfo = { phone: telefone };
            resultPayload = await handleCancellation(barbeariaId, personInfo);
        } else {
            resultPayload = { success: false, message: "Desculpe, não entendi o que você quis dizer. Para agendar, por favor, me diga o dia e a hora." };
        }

        const responseData = { status: resultPayload.success ? 'success' : 'error', message: resultPayload.message };
        console.log(`\n📤 RESPOSTA ENVIADA:\n`, JSON.stringify(responseData, null, 2));
        return response.status(200).json(responseData);

    } catch (error) {
        console.error("❌ Erro CRÍTICO no webhook:", error);
        return response.status(500).json({ status: 'error', message: "Desculpe, ocorreu um erro interno." });
    }
});


// =================================================================
// AS FUNÇÕES DE LÓGICA DE NEGÓCIO ABAIXO PERMANECEM AS MESMAS
// =================================================================

async function handleScheduling(barbeariaId, personInfo, requestedDate, localTime, servicoId) {
    if (!personInfo.name || !personInfo.phone) return { success: false, message: "Faltam seus dados pessoais." };
    if (!servicoId) return { success: false, message: "Você precisa selecionar um serviço." };
    if (requestedDate.getTime() <= new Date().getTime()) return { success: false, message: "Não é possível agendar no passado." };

    const servicoRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.services).doc(servicoId);
    const servicoSnap = await servicoRef.get();
    if (!servicoSnap.exists) return { success: false, message: "O serviço selecionado não foi encontrado para esta barbearia." };
    
    const servico = { id: servicoSnap.id, ...servicoSnap.data() };
    const duracao = parseInt(servico.duracaoMinutos, 10) || 30;

    const businessHoursCheck = await checkBusinessHours(barbeariaId, localTime, duracao);
    if (!businessHoursCheck.isOpen) return { success: false, message: businessHoursCheck.message };

    const hasConflict = await checkConflicts(barbeariaId, requestedDate, duracao);
    if (hasConflict) {
        console.log("⚠️ Conflito detectado, buscando horários alternativos...");
        const suggestions = await getAvailableSlots(barbeariaId, requestedDate, duracao);
        return { success: false, message: suggestions };
    }

    await saveAppointment(barbeariaId, personInfo, requestedDate, servico);
    
    const formattedDateForUser = dayjs(requestedDate).tz(CONFIG.timezone).format('dddd, DD [de] MMMM [às] HH:mm');
    return { success: true, message: `Perfeito, ${personInfo.name}! Seu agendamento de ${servico.nome} foi confirmado para ${formattedDateForUser}.` };
}

async function checkBusinessHours(barbeariaId, date, duracaoMinutos) {
    const dayOfWeek = date.getDay();
    const docRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.config).doc(String(dayOfWeek));
    const docSnap = await docRef.get();
    if (!docSnap.exists || !docSnap.data().aberto) return { isOpen: false, message: `Desculpe, não funcionamos neste dia.` };
    
    const dayConfig = docSnap.data();
    const timeToMinutes = (str) => {
        if (!str) return null;
        const [h, m] = str.split(':').map(Number);
        return (h * 60) + (m || 0);
    };
    
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

async function getAvailableSlots(barbeariaId, requestedDate, duracaoMinutos) {
    try {
        const requestedDateDayjs = dayjs(requestedDate).tz(CONFIG.timezone);
        let availableSlots = await findAvailableSlotsForDay(barbeariaId, requestedDateDayjs, duracaoMinutos);
        
        if (availableSlots.length > 0) {
            const dateStr = requestedDateDayjs.format('DD/MM');
            const slotsText = availableSlots.slice(0, 3).join(', ');
            return `Este horário já está ocupado. Que tal um destes para ${dateStr}? ${slotsText}`;
        }
        
        const tomorrow = requestedDateDayjs.add(1, 'day');
        availableSlots = await findAvailableSlotsForDay(barbeariaId, tomorrow, duracaoMinutos);
        
        if (availableSlots.length > 0) {
            const dateStr = tomorrow.format('DD/MM');
            const slotsText = availableSlots.slice(0, 3).join(', ');
            return `Este horário já está ocupado e não há mais vagas hoje. Que tal para ${dateStr}? Horários: ${slotsText}`;
        }
        
        return "Este horário já está ocupado. Infelizmente não encontrei horários disponíveis para hoje nem amanhã. Tente outro dia.";
    } catch (error) {
        console.error("Erro ao buscar horários disponíveis:", error);
        return "Este horário já está ocupado. Tente outro horário.";
    }
}

async function findAvailableSlotsForDay(barbeariaId, dayDate, duracaoMinutos) {
    const dayOfWeek = dayDate.day();
    const docRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.config).doc(String(dayOfWeek));
    const docSnap = await docRef.get();
    if (!docSnap.exists || !docSnap.data().aberto) return [];
    
    const dayConfig = docSnap.data();
    const timeToMinutes = (str) => {
        if (!str) return null;
        const [h, m] = str.split(':').map(Number);
        return (h * 60) + (m || 0);
    };

    const morningStart = timeToMinutes(dayConfig.InicioManha);
    const morningEnd = timeToMinutes(dayConfig.FimManha);
    const afternoonStart = timeToMinutes(dayConfig.InicioTarde);
    const afternoonEnd = timeToMinutes(dayConfig.FimTarde);
    
    const startOfDay = dayDate.startOf('day').toDate();
    const endOfDay = dayDate.endOf('day').toDate();
    
    const schedulesRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.schedules);
    const q = schedulesRef
        .where('Status', '==', 'Agendado')
        .where('DataHoraISO', '>=', startOfDay.toISOString())
        .where('DataHoraISO', '<=', endOfDay.toISOString());
        
    const snapshot = await q.get();
    const busySlots = [];
    snapshot.docs.forEach(doc => {
        const data = doc.data();
        const startTime = dayjs(data.DataHoraISO).tz(CONFIG.timezone);
        const serviceDuration = data.duracaoMinutos || 30;
        const endTime = startTime.add(serviceDuration, 'minutes');
        busySlots.push({
            start: startTime.hour() * 60 + startTime.minute(),
            end: endTime.hour() * 60 + endTime.minute()
        });
    });
    
    const availableSlots = [];
    const currentTime = dayjs().tz(CONFIG.timezone);
    const isToday = dayDate.isSame(currentTime, 'day');
    
    const addSlotsFromPeriod = (startMinutes, endMinutes) => {
        if (startMinutes === null || endMinutes === null) return;
        for (let time = startMinutes; time + duracaoMinutos <= endMinutes; time += 30) {
            const slotDate = dayDate.hour(Math.floor(time / 60)).minute(time % 60);
            if (isToday && slotDate.isBefore(currentTime.add(1, 'hour'))) {
                continue;
            }
            const hasConflict = busySlots.some(busy => (time < busy.end && (time + duracaoMinutos) > busy.start));
            if (!hasConflict) {
                availableSlots.push(slotDate.format('HH:mm'));
            }
        }
    };
    
    addSlotsFromPeriod(morningStart, morningEnd);
    addSlotsFromPeriod(afternoonStart, afternoonEnd);
    
    return availableSlots;
}

async function handleCancellation(barbeariaId, personInfo) {
    if (!personInfo.phone) return { success: false, message: "Para cancelar, preciso do seu telefone." };
    const schedulesRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.schedules);
    const q = schedulesRef
        .where('TelefoneCliente', '==', personInfo.phone)
        .where('Status', '==', 'Agendado')
        .where('DataHoraISO', '>', new Date().toISOString());
    const snapshot = await q.get();
    if (snapshot.empty) return { success: false, message: `Não encontrei nenhum agendamento futuro no seu telefone.` };
    
    let count = 0;
    for (const doc of snapshot.docs) {
        await doc.ref.update({ Status: 'Cancelado' });
        count++;
    }
    return { success: true, message: `Tudo certo! Cancelei ${count} agendamento(s) futuro(s) que encontrei.` };
}

async function checkConflicts(barbeariaId, requestedDate, duracaoMinutos) {
    const serviceDurationMs = duracaoMinutos * 60 * 1000;
    const requestedStart = requestedDate.getTime();
    const requestedEnd = requestedStart + serviceDurationMs;
    
    const searchStart = new Date(requestedStart - 2 * 60 * 60 * 1000);
    const searchEnd = new Date(requestedStart + 2 * 60 * 60 * 1000);
    
    const schedulesRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.schedules);
    const q = schedulesRef
        .where('DataHoraISO', '>=', searchStart.toISOString())
        .where('DataHoraISO', '<=', searchEnd.toISOString());
    
    const snapshot = await q.get();
    
    for (const doc of snapshot.docs) {
        const existingData = doc.data();
        if (existingData.Status !== 'Agendado') {
            continue;
        }
        const existingStart = new Date(existingData.DataHoraISO).getTime();
        const existingEnd = existingStart + ((existingData.duracaoMinutos || 30) * 60 * 1000);
        if (requestedStart < existingEnd && requestedEnd > existingStart) {
            return true;
        }
    }
    return false;
}

async function saveAppointment(barbeariaId, personInfo, requestedDate, servico) {
    const schedulesRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.schedules);
    const newAppointment = {
        NomeCliente: personInfo.name,
        TelefoneCliente: personInfo.phone,
        DataHoraISO: requestedDate.toISOString(),
        Status: 'Agendado',
        TimestampAgendamento: new Date().toISOString(),
        servicoId: servico.id,
        servicoNome: servico.nome,
        preco: servico.preco,
        duracaoMinutos: servico.duracaoMinutos || 30,
    };
    await schedulesRef.add(newAppointment);
}

// Exporta o app para a Vercel conseguir usá-lo como uma Serverless Function
module.exports = app;
