// =================================================================
// WEBHOOK MULTI-TENANT COM IA PERPLEXITY - VERSÃO 3.0
// =================================================================
const express = require("express");
const admin = require('firebase-admin');
const dayjs = require('dayjs');
const timezone = require('dayjs/plugin/timezone');
const utc = require('dayjs/plugin/utc');
require('dayjs/locale/pt-br');
// Usaremos o 'fetch' que já é nativo nas versões mais recentes do Node.js
// Se tiver problemas no deploy, pode ser necessário instalar 'node-fetch'

// --- CONFIGURAÇÃO ---
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.locale('pt-br');

const app = express();
app.use(express.json());

const CONFIG = {
    firebaseCreds: JSON.parse(process.env.FIREBASE_CREDENTIALS || '{}'),
    perplexityApiKey: process.env.PERPLEXITY_API_KEY, // Nova chave de API
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

// --- NOVA FUNÇÃO COM IA PERPLEXITY ---
async function getIntentAndDateFromPerplexity(text, servicesList) {
    if (!CONFIG.perplexityApiKey) {
        console.error("❌ Chave da API do Perplexity não configurada.");
        return null;
    }

    try {
        const serviceNames = servicesList.map(s => s.nome).join(', ');

        const systemPrompt = `Você é um assistente de agendamento para barbearias. Sua tarefa é analisar a mensagem do usuário e extrair informações, retornando APENAS um objeto JSON. A lista de serviços válidos é: [${serviceNames}]. A data de referência é ${new Date().toISOString()} no fuso horário ${CONFIG.timezone}. O JSON de saída deve ter a seguinte estrutura: { "intent": "agendarHorario" | "cancelarHorario" | "informacao", "dataHoraISO": "YYYY-MM-DDTHH:mm:ss.sssZ" | null, "servicoNome": "Nome do Serviço" | null }. Se um serviço não for mencionado ou não estiver na lista, retorne "servicoNome" como nulo.`;
        
        const response = await fetch("https://api.perplexity.ai/chat/completions", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CONFIG.perplexityApiKey}`
            },
            body: JSON.stringify({
                model: 'llama-3-sonar-small-32k-online', // Um modelo rápido e poderoso da Perplexity
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: text }
                ],
                max_tokens: 300,
                temperature: 0.1 // Queremos respostas precisas e consistentes
            })
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`❌ Erro da API Perplexity: ${response.status} ${response.statusText}`, errorBody);
            return null;
        }

        const data = await response.json();
        const responseText = data.choices[0].message.content;

        console.log("📝 Resposta bruta da IA (Perplexity):", responseText);
        const cleanedJsonString = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleanedJsonString);

    } catch (error) {
        console.error("❌ Erro ao chamar a API Perplexity:", error);
        return null;
    }
}

// --- ROTA PRINCIPAL DO WEBHOOK (Lógica de chamada ajustada) ---
app.post("/api/webhook", async (request, response) => {
    const body = request.body;
    console.log("\n🔄 === NOVO REQUEST WEBHOOK (Perplexity) ===\n", JSON.stringify(body, null, 2));

    try {
        const { nome, telefone, data_hora_texto, barbeariaId } = body;
        let resultPayload;

        if (!barbeariaId) {
            return response.status(400).json({ status: 'error', message: "ID da barbearia não foi fornecido." });
        }
        
        const servicesSnapshot = await db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.services).get();
        const servicesList = servicesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        if (servicesList.length === 0) {
            const errorResponse = { status: 'error', message: 'Ainda não há serviços configurados para esta barbearia.' };
            console.log(`\n📤 RESPOSTA ENVIADA:\n`, JSON.stringify(errorResponse, null, 2));
            return response.status(200).json(errorResponse);
        }

        const aiResult = await getIntentAndDateFromPerplexity(data_hora_texto, servicesList);

        if (!aiResult) {
            return response.status(500).json({ status: 'error', message: "Desculpe, não consegui processar sua solicitação com a IA." });
        }
        
        const { intent, dataHoraISO, servicoNome } = aiResult;
        const parsedDate = dataHoraISO ? dayjs(dataHoraISO).tz(CONFIG.timezone) : null;
        const servicoEncontrado = servicoNome ? servicesList.find(s => s.nome.toLowerCase() === servicoNome.toLowerCase()) : null;

        if (intent === 'agendarHorario') {
            if (!parsedDate) {
                resultPayload = { success: false, message: "Não consegui entender a data e hora. Tente algo como 'amanhã às 16h'." };
            } else if (!servicoEncontrado) {
                 resultPayload = { success: false, message: `Não consegui identificar o serviço que você pediu. Nossos serviços são: ${servicesList.map(s => s.nome).join(', ')}. Por favor, tente novamente.` };
            } else {
                const dateForStorage = parsedDate.utc().toDate();
                const personInfo = { name: nome, phone: telefone };
                resultPayload = await handleScheduling(barbeariaId, personInfo, dateForStorage, parsedDate, servicoEncontrado.id);
            }
        } else if (intent === 'cancelarHorario') {
            const personInfo = { phone: telefone };
            resultPayload = await handleCancellation(barbeariaId, personInfo);
        } else {
            resultPayload = { success: false, message: "Desculpe, não entendi o que você quis dizer." };
        }
        
        const responseData = { 
            status: resultPayload.success ? 'success' : 'error', 
            message: resultPayload.message,
            type: resultPayload.type || null 
        };
        console.log(`\n📤 RESPOSTA ENVIADA:\n`, JSON.stringify(responseData, null, 2));
        return response.status(200).json(responseData);

    } catch (error) {
        console.error("❌ Erro CRÍTICO no webhook:", error);
        return response.status(500).json({ status: 'error', message: "Desculpe, ocorreu um erro interno." });
    }
});


// ... O restante do seu ficheiro (handleScheduling, checkBusinessHours, etc.) permanece exatamente o mesmo ...
async function handleScheduling(barbeariaId, personInfo, requestedDate, localTimeDayjs, servicoId) {
    if (!personInfo.name || !personInfo.phone) return { success: false, message: "Faltam seus dados pessoais." };
    if (!servicoId) return { success: false, message: "Você precisa selecionar um serviço." };
    if (requestedDate.getTime() <= new Date().getTime()) return { success: false, message: "Não é possível agendar no passado." };

    const servicoRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.services).doc(servicoId);
    const servicoSnap = await servicoRef.get();
    if (!servicoSnap.exists) return { success: false, message: "O serviço selecionado não foi encontrado." };
    
    const servico = { id: servicoSnap.id, ...servicoSnap.data() };
    const duracao = parseInt(servico.duracaoMinutos, 10) || 30;

    const businessHoursCheck = await checkBusinessHours(barbeariaId, localTimeDayjs, duracao);
    if (!businessHoursCheck.isOpen) return { success: false, message: businessHoursCheck.message };

    const hasConflict = await checkConflicts(barbeariaId, requestedDate, duracao);
    if (hasConflict) {
        console.log("⚠️ Conflito detectado, buscando horários alternativos...");
        const suggestions = await getAvailableSlots(barbeariaId, requestedDate, duracao);
        return { success: false, type: 'suggestion', message: suggestions };
    }

    await saveAppointment(barbeariaId, personInfo, requestedDate, servico);
    
    const formattedDateForUser = dayjs(requestedDate).tz(CONFIG.timezone).format('dddd, DD [de] MMMM [às] HH:mm');
    return { success: true, message: `Perfeito, ${personInfo.name}! Seu agendamento de ${servico.nome} foi confirmado para ${formattedDateForUser}.` };
}

async function checkBusinessHours(barbeariaId, dateDayjs, duracaoMinutos) {
    const dayOfWeek = dateDayjs.day();
    const docRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.config).doc(String(dayOfWeek));
    const docSnap = await docRef.get();
    if (!docSnap.exists || !docSnap.data().aberto) return { isOpen: false, message: `Desculpe, não funcionamos neste dia.` };
    
    const dayConfig = docSnap.data();
    const timeToMinutes = (str) => {
        if (!str) return null;
        const [h, m] = str.split(':').map(Number);
        return (h * 60) + (m || 0);
    };
    
    const requestedStartMinutes = dateDayjs.hour() * 60 + dateDayjs.minute();
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

module.exports = app;

