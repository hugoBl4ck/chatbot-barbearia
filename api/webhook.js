// =================================================================
// WEBHOOK MULTI-TENANT COM IA PERPLEXITY - VERSÃO 4.1 (COMPLETA E OTIMIZADA)
// =================================================================
const express = require('express');
const admin = require('firebase-admin');
const dayjs = require('dayjs');
const timezone = require('dayjs/plugin/timezone');
const utc = require('dayjs/plugin/utc');
require('dayjs/locale/pt-br');

// --- CONFIGURAÇÃO ---
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.locale('pt-br');

const app = express();
app.use(express.json());

const CONFIG = {
    firebaseCreds: JSON.parse(process.env.FIREBASE_CREDENTIALS || '{}'),
    perplexityApiKey: process.env.PERPLEXITY_API_KEY,
    timezone: 'America/Sao_Paulo',
    collections: {
        barbearias: 'barbearias',
        schedules: 'agendamentos',
        config: 'horarios',
        services: 'servicos'
    }
};

if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(CONFIG.firebaseCreds) });
}
const db = admin.firestore();

// --- FUNÇÃO COM IA PERPLEXITY ---
async function getIntentWithPerplexity(text, servicesList) {
    if (!CONFIG.perplexityApiKey) {
        console.error("❌ Chave da API do Perplexity não configurada.");
        return { success: false, message: "O serviço de IA não está configurado." };
    }
    try {
        const serviceNames = servicesList.map(s => `"${s.nome}"`).join(', ');
        const currentLocalTime = dayjs().tz(CONFIG.timezone).format('dddd, DD/MM/YYYY HH:mm');
        
        const systemPrompt = `Você é um assistente de agendamento para uma barbearia no Brasil (fuso horário: America/Sao_Paulo). A data/hora atual de referência é ${currentLocalTime}.
SERVIÇOS DISPONÍVEIS: [${serviceNames}].
Sua tarefa é analisar a mensagem do usuário e retornar APENAS um objeto JSON válido com a estrutura:
{"intent": "agendarHorario" | "cancelarHorario" | "informacao", "dataHoraISO": "YYYY-MM-DDTHH:mm:ss-03:00" | null, "servicoNome": "Nome Exato do Serviço" | null}
Se o serviço não for claro, retorne null. Se a data/hora não for clara, retorne null. Seja preciso com a data e hora no fuso brasileiro.`;
        
        const response = await fetch("https://api.perplexity.ai/chat/completions", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.perplexityApiKey}` },
            body: JSON.stringify({
                model: 'sonar',
                messages: [ { role: 'system', content: systemPrompt }, { role: 'user', content: text } ],
                max_tokens: 200,
                temperature: 0.1
            })
        });

        if (!response.ok) throw new Error(`API Perplexity falhou com status ${response.status}`);
        
        const data = await response.json();
        const responseText = data.choices[0].message.content;
        console.log("🔍 Resposta bruta da IA:", responseText);
        
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("A resposta da IA não continha um JSON válido.");

        return { success: true, data: JSON.parse(jsonMatch[0]) };

    } catch (error) {
        console.error("❌ Erro ao chamar a API Perplexity:", error);
        return { success: false, message: "Não consegui entender sua solicitação no momento." };
    }
}

// --- ROTA PRINCIPAL DO WEBHOOK ---
app.post("/api/webhook", async (request, response) => {
    const { nome, telefone, data_hora_texto, barbeariaId } = request.body;
    console.log("\n📄 === NOVO REQUEST WEBHOOK ===\n", JSON.stringify(request.body, null, 2));

    try {
        if (!barbeariaId || !data_hora_texto) return response.status(400).json({ status: 'error', message: 'Dados insuficientes.' });

        const barbeariaRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId);
        const barbeariaSnap = await barbeariaRef.get();
        if (!barbeariaSnap.exists) return response.status(200).json({ status: 'error', message: 'Barbearia não encontrada.' });

        const servicesSnapshot = await barbeariaRef.collection(CONFIG.collections.services).where('ativo', '==', true).get();
        const servicesList = servicesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        if (servicesList.length === 0) return response.status(200).json({ status: 'error', message: 'Nenhum serviço configurado.' });

        const aiResponse = await getIntentWithPerplexity(data_hora_texto, servicesList);
        if (!aiResponse.success) return response.status(200).json({ status: 'error', message: aiResponse.message });

        const { intent, dataHoraISO, servicoNome } = aiResponse.data;
        
        const parsedDate = dataHoraISO ? dayjs.tz(dataHoraISO, CONFIG.timezone) : null;

        let resultPayload;
        const personInfo = { name: nome, phone: telefone };

        if (intent === 'agendarHorario') {
            if (!parsedDate || !parsedDate.isValid()) {
                resultPayload = { success: false, message: "Não consegui entender a data e hora. Tente algo como 'amanhã às 16h'." };
            } else {
                const servicoEncontrado = servicoNome ? servicesList.find(s => s.nome.toLowerCase() === servicoNome.toLowerCase()) : servicesList[0];
                if (!servicoEncontrado) {
                    resultPayload = { success: false, message: `Não encontrei o serviço "${servicoNome}".` };
                } else {
                    resultPayload = await handleScheduling(barbeariaId, personInfo, parsedDate, servicoEncontrado.id);
                }
            }
        } else if (intent === 'cancelarHorario') {
            resultPayload = await handleCancellation(barbeariaId, personInfo);
        } else {
            resultPayload = { success: false, message: 'Não entendi o que você quer fazer.' };
        }
        
        const responseData = { status: resultPayload.success ? 'success' : 'error', message: resultPayload.message, type: resultPayload.type || null };
        console.log(`\n📤 RESPOSTA ENVIADA:\n`, JSON.stringify(responseData, null, 2));
        return response.status(200).json(responseData);
    } catch (error) {
        console.error("❌ Erro CRÍTICO no webhook:", error);
        return response.status(200).json({ status: 'error', message: 'Desculpe, ocorreu um erro interno.' });
    }
});

// --- FUNÇÕES DE LÓGICA DE NEGÓCIOS ---
async function handleScheduling(barbeariaId, personInfo, requestedDateDayjs, servicoId) {
    if (!personInfo.name || !personInfo.phone) return { success: false, message: 'Para agendar, preciso do seu nome e telefone.' };
    if (requestedDateDayjs.isBefore(dayjs().tz(CONFIG.timezone))) return { success: false, message: 'Não é possível agendar no passado.' };

    const servicoRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.services).doc(servicoId);
    const servicoSnap = await servicoRef.get();
    if (!servicoSnap.exists) return { success: false, message: 'O serviço selecionado não foi encontrado.' };
    
    const servico = { id: servicoSnap.id, ...servicoSnap.data() };
    const duracao = servico.duracaoMinutos || 30;

    const businessHoursCheck = await checkBusinessHours(barbeariaId, requestedDateDayjs, duracao);
    if (!businessHoursCheck.isOpen) return { success: false, message: businessHoursCheck.message };

    const hasConflict = await checkConflicts(barbeariaId, requestedDateDayjs.toDate(), duracao);
    if (hasConflict) {
        const suggestions = await getAvailableSlots(barbeariaId, requestedDateDayjs.toDate(), duracao);
        return { success: false, type: 'suggestion', message: suggestions };
    }

    await saveAppointment(barbeariaId, personInfo, requestedDateDayjs.toDate(), servico);
    
    const formattedDateForUser = requestedDateDayjs.format('dddd, DD [de] MMMM [às] HH:mm');
    return { success: true, message: `Perfeito, ${personInfo.name}! Seu agendamento de ${servico.nome} foi confirmado para ${formattedDateForUser}.` };
}

async function getAvailableSlots(barbeariaId, requestedDate, duracaoMinutos) {
    try {
        const requestedDateDayjs = dayjs(requestedDate).tz(CONFIG.timezone);
        let availableSlots = await findAvailableSlotsForDay(barbeariaId, requestedDateDayjs, duracaoMinutos);
        if (availableSlots.length > 0) {
            return `O horário solicitado está ocupado. 😔\nMas tenho estes horários livres hoje: ${availableSlots.slice(0, 3).join(', ')}. Algum desses funciona?`;
        }
        const tomorrow = requestedDateDayjs.add(1, 'day');
        availableSlots = await findAvailableSlotsForDay(barbeariaId, tomorrow, duracaoMinutos);
        if (availableSlots.length > 0) {
            return `Não tenho mais vagas para hoje. 😔\nPara amanhã, tenho estes horários: ${availableSlots.slice(0, 3).join(', ')}. Quer marcar um desses?`;
        }
        return "Este horário já está ocupado e não encontrei outras vagas próximas. 😔 Por favor, tente outro dia.";
    } catch (error) {
        console.error("❌ Erro ao buscar horários disponíveis:", error);
        return "Este horário está ocupado. Tente outro ou entre em contato conosco.";
    }
}

async function findAvailableSlotsForDay(barbeariaId, dayDate, duracaoMinutos) {
    const dayOfWeek = dayDate.day();
    const docRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.config).doc(String(dayOfWeek));
    const docSnap = await docRef.get();
    if (!docSnap.exists() || !docSnap.data().aberto) return [];
    
    const dayConfig = docSnap.data();
    const timeToMinutes = (str) => { if (!str) return null; const [h, m] = str.split(':').map(Number); return (h * 60) + (m || 0); };
    const formatTime = (totalMinutes) => `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
    const morningStart = timeToMinutes(dayConfig.InicioManha);
    const morningEnd = timeToMinutes(dayConfig.FimManha);
    const afternoonStart = timeToMinutes(dayConfig.InicioTarde);
    const afternoonEnd = timeToMinutes(dayConfig.FimTarde);
    
    const startOfDay = dayDate.startOf('day').toDate();
    const endOfDay = dayDate.endOf('day').toDate();
    const schedulesRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.schedules);
    const q = query(schedulesRef, where('Status', '==', 'Agendado'), where('DataHoraISO', '>=', startOfDay.toISOString()), where('DataHoraISO', '<=', endOfDay.toISOString()));
    const snapshot = await q.get();
    const busySlots = snapshot.docs.map(doc => {
        const data = doc.data();
        const startTime = dayjs(data.DataHoraISO).tz(CONFIG.timezone);
        return { start: startTime.hour() * 60 + startTime.minute(), end: startTime.hour() * 60 + startTime.minute() + data.duracaoMinutos };
    });
    
    const availableSlots = [];
    const currentTime = dayjs().tz(CONFIG.timezone);
    const isToday = dayDate.isSame(currentTime, 'day');
    
    const addSlotsFromPeriod = (start, end) => {
        if (start === null || end === null) return;
        for (let time = start; time + duracaoMinutos <= end; time += 15) {
            const slotDate = dayDate.hour(Math.floor(time / 60)).minute(time % 60);
            if (isToday && slotDate.isBefore(currentTime)) continue;
            const hasConflict = busySlots.some(busy => (time < busy.end && (time + duracaoMinutos) > busy.start));
            if (!hasConflict) availableSlots.push(formatTime(time));
        }
    };
    
    addSlotsFromPeriod(morningStart, morningEnd);
    addSlotsFromPeriod(afternoonStart, afternoonEnd);
    
    return availableSlots;
}

async function checkBusinessHours(barbeariaId, dateDayjs, duracaoMinutos) {
    const dayOfWeek = dateDayjs.day();
    const docRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.config).doc(String(dayOfWeek));
    const docSnap = await docRef.get();
    if (!docSnap.exists() || !docSnap.data().aberto) return { isOpen: false, message: `Desculpe, não funcionamos neste dia.` };
    
    const dayConfig = docSnap.data();
    const timeToMinutes = (str) => { if (!str) return null; const [h, m] = str.split(':').map(Number); return (h * 60) + (m || 0); };
    
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

async function handleCancellation(barbeariaId, personInfo) {
    if (!personInfo.phone) return { success: false, message: "Para cancelar, preciso do seu telefone.", type: null };
    const schedulesRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.schedules);
    const q = query(schedulesRef, where('TelefoneCliente', '==', personInfo.phone), where('Status', '==', 'Agendado'), where('DataHoraISO', '>', new Date().toISOString()));
    const snapshot = await q.get();
    if (snapshot.empty) return { success: false, message: `Não encontrei nenhum agendamento futuro no seu telefone.`, type: null };
    
    let count = 0;
    for (const doc of snapshot.docs) {
        await doc.ref.update({ Status: 'Cancelado' });
        count++;
    }
    return { success: true, message: `Tudo certo! Cancelei ${count} agendamento(s) futuro(s) que encontrei.`, type: null };
}

async function checkConflicts(barbeariaId, requestedDate, duracaoMinutos) {
    const serviceDurationMs = duracaoMinutos * 60 * 1000;
    const requestedStart = requestedDate.getTime();
    const requestedEnd = requestedStart + serviceDurationMs;
    const searchStart = new Date(requestedStart - 2 * 60 * 60 * 1000);
    const searchEnd = new Date(requestedStart + 2 * 60 * 60 * 1000);
    const schedulesRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.schedules);
    const q = query(schedulesRef, where('Status', '==', 'Agendado'), where('DataHoraISO', '>=', searchStart.toISOString()), where('DataHoraISO', '<=', searchEnd.toISOString()));
    
    const snapshot = await q.get();
    
    for (const doc of snapshot.docs) {
        const existingData = doc.data();
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
