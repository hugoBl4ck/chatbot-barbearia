// =================================================================
// WEBHOOK OTIMIZADO V6 - COMPLETO COM GEMINI API
// =================================================================
const express = require('express');
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
    // A chave da Perplexity não é mais necessária, mas a do Gemini sim
    geminiApiKey: process.env.GEMINI_API_TYPEBOT,
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

// =================================================================
// OTIMIZAÇÃO: CACHE EM MEMÓRIA PARA DADOS ESTÁTICOS
// =================================================================
const servicesCache = new Map();
const businessHoursCache = new Map();

async function cacheBarbeariaData(barbeariaId) {
    try {
        console.log(`Caching data for barbeariaId: ${barbeariaId}...`);
        const barbeariaRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId);

        const servicesSnapshot = await barbeariaRef.collection(CONFIG.collections.services).where('ativo', '==', true).get();
        const servicesList = servicesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        servicesCache.set(barbeariaId, servicesList);
        console.log(`✅ Serviços em cache para ${barbeariaId}: ${servicesList.length} itens.`);

        const hoursMap = new Map();
        for (let i = 0; i < 7; i++) {
            const docSnap = await barbeariaRef.collection(CONFIG.collections.config).doc(String(i)).get();
            if (docSnap.exists) {
                hoursMap.set(String(i), docSnap.data());
            }
        }
        businessHoursCache.set(barbeariaId, hoursMap);
        console.log(`✅ Horários em cache para ${barbeariaId}: ${hoursMap.size} dias.`);
        
        return { success: true };
    } catch (error) {
        console.error(`❌ Falha ao carregar cache para barbearia ${barbeariaId}:`, error);
        return { success: false, message: `Não foi possível carregar as configurações para a barbearia ${barbeariaId}.`};
    }
}

async function getServices(barbeariaId) {
    if (servicesCache.has(barbeariaId) && servicesCache.get(barbeariaId).length > 0) {
        return servicesCache.get(barbeariaId);
    }
    await cacheBarbeariaData(barbeariaId);
    return servicesCache.get(barbeariaId) || [];
}

// =================================================================
// FUNÇÕES DE CONTEXTO
// =================================================================
async function saveUserContext(barbeariaId, telefone, servicoId, servicoNome, dataOriginalISO) {
    try {
        const contextRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection('contextos').doc(telefone);
        await contextRef.set({
            servicoId, servicoNome, dataOriginal: dataOriginalISO, dataSugerida: dataOriginalISO,
            criadoEm: new Date().toISOString(),
            expirarEm: new Date(Date.now() + 10 * 60 * 1000).toISOString()
        }, { merge: true });
        console.log(`💾 Contexto salvo para ${telefone}: ${servicoNome} (Data sugerida: ${dataOriginalISO})`);
    } catch (error) { console.error(`❌ Erro ao salvar contexto:`, error); }
}

async function getUserContext(barbeariaId, telefone) {
    try {
        const contextRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection('contextos').doc(telefone);
        const contextSnap = await contextRef.get();
        if (!contextSnap.exists) return null;
        const context = contextSnap.data();
        if (new Date() > new Date(context.expirarEm)) {
            await contextRef.delete();
            return null;
        }
        return context;
    } catch (err) {
        console.error('❌ Erro ao recuperar contexto:', err);
        return null;
    }
}

function clearUserContextAsync(barbeariaId, telefone) {
    setImmediate(async () => {
        try {
            const contextRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection('contextos').doc(telefone);
            await contextRef.delete();
            console.log(`🗑️ Contexto limpo para ${telefone}`);
        } catch (error) { console.error(`❌ Erro ao limpar contexto:`, error); }
    });
}

// =================================================================
// NOVA FUNÇÃO DE IA COM GEMINI
// =================================================================
async function getIntentWithGemini(text, servicesList) {
    if (!CONFIG.geminiApiKey) {
        return { success: false, message: "Chave da API do Gemini não configurada." };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${CONFIG.geminiApiKey}`;
    const serviceNames = servicesList.map(s => `"${s.nome}"`).join(', ');
    const currentLocalTime = dayjs().tz(CONFIG.timezone).format('dddd, DD/MM/YYYY HH:mm');
    const systemPrompt = `Você é um assistente de agendamento para uma barbearia no Brasil (fuso horário: ${CONFIG.timezone}). A data/hora atual de referência é ${currentLocalTime}. Serviços disponíveis: [${serviceNames}]. Sua tarefa é analisar a mensagem do usuário e retornar APENAS um objeto JSON válido com a estrutura: {"intent": "agendarHorario" | "cancelarHorario" | "informacao", "dataHoraISO": "YYYY-MM-DDTHH:mm:ss-03:00" | null, "servicoNome": "Nome Exato do Serviço" | null}.`;
    
    const requestBody = {
        contents: [{ parts: [{ text: systemPrompt + "\n\nUsuário: " + text }] }],
        generationConfig: {
            response_mime_type: "application/json",
            temperature: 0.1,
            maxOutputTokens: 2048,
        }
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorBody = await response.json();
            console.error("❌ API Gemini falhou:", JSON.stringify(errorBody, null, 2));
            throw new Error(`API Gemini falhou com status ${response.status}`);
        }

        const data = await response.json();
        const responseText = data.candidates[0].content.parts[0].text;
        console.log("🔍 Resposta bruta da IA (Gemini):", responseText);
        
        return { success: true, data: JSON.parse(responseText) };

    } catch (error) {
        console.error("❌ Erro ao chamar a API Gemini:", error);
        return { success: false, message: "Não consegui falar com o assistente de IA no momento." };
    }
}

// =================================================================
// ENDPOINT PRINCIPAL OTIMIZADO
// =================================================================
app.post('/api/webhook', async (request, response) => {
    const { nome, telefone, data_hora_texto, barbeariaId } = request.body;
    console.log('\n📄 === NOVO REQUEST WEBHOOK ===\n', JSON.stringify(request.body, null, 2));

    try {
        const servicesList = await getServices(barbeariaId);
        if (!servicesList || servicesList.length === 0) {
            const cacheResult = await cacheBarbeariaData(barbeariaId);
            if (!cacheResult.success || !servicesCache.has(barbeariaId) || servicesCache.get(barbeariaId).length === 0) {
                return response.status(200).json({ status: 'error', message: cacheResult.message || 'Nenhum serviço configurado.' });
            }
        }

        console.log("⏳ Iniciando busca de contexto e IA em paralelo...");
        const [userContext, aiResult] = await Promise.all([
            getUserContext(barbeariaId, telefone),
            getIntentWithGemini(data_hora_texto, servicesList)
        ]);
        console.log("✅ Operações paralelas concluídas.");

        if (!aiResult.success) {
            return response.status(200).json({ status: 'error', message: aiResult.message });
        }
        
        let { intent, dataHoraISO, servicoNome } = aiResult.data;

        if (!intent) {
            return response.status(200).json({ status: 'error', message: 'Não consegui processar seu pedido. Poderia tentar formular a frase de outra forma?' });
        }
        console.log('🤖 Intent processado:', { intent, dataHoraISO, servicoNome });

        let parsedDateDayjs = dataHoraISO ? dayjs(dataHoraISO).tz(CONFIG.timezone) : null;
        const personInfo = { name: nome, phone: telefone };
        let resultPayload;

        if (intent === 'agendarHorario') {
            if (!parsedDateDayjs || !parsedDateDayjs.isValid()) {
                resultPayload = { success: false, message: "Não consegui entender a data e hora. Tente algo como 'amanhã às 16h'." };
            } else {
                if (userContext && userContext.dataSugerida) {
                    const contextDate = dayjs(userContext.dataSugerida).tz(CONFIG.timezone, true);
                    const aiTime = parsedDateDayjs;
                    const today = dayjs().tz(CONFIG.timezone).startOf('day');
                    if (aiTime.startOf('day').isSame(today, 'day') && !contextDate.startOf('day').isSame(today, 'day')) {
                        parsedDateDayjs = contextDate.hour(aiTime.hour()).minute(aiTime.minute()).second(0);
                    }
                }
                let servicoEncontrado = (servicesList || []).find(s => servicoNome && (s.nome.toLowerCase().includes(servicoNome.toLowerCase()) || servicoNome.toLowerCase().includes(s.nome.toLowerCase())));
                if (!servicoEncontrado && userContext) {
                    servicoEncontrado = (servicesList || []).find(s => s.id === userContext.servicoId);
                }
                if (!servicoEncontrado) servicoEncontrado = (servicesList || [])[0];

                if (!servicoEncontrado) {
                    resultPayload = { success: false, message: `Não encontrei o serviço "${servicoNome}".` };
                } else {
                    resultPayload = await handleScheduling(barbeariaId, personInfo, parsedDateDayjs, servicoEncontrado.id, telefone, servicoEncontrado);
                    if (resultPayload.success) {
                        clearUserContextAsync(barbeariaId, telefone);
                    }
                }
            }
        } else if (intent === 'cancelarHorario') {
            resultPayload = await handleCancellation(barbeariaId, personInfo);
            clearUserContextAsync(barbeariaId, telefone);
        } else {
            resultPayload = { success: false, message: 'Não entendi o que você quer fazer. Você quer agendar ou cancelar um horário?' };
        }

        const responseData = { status: resultPayload.success ? 'success' : 'error', message: resultPayload.message, type: resultPayload.type || null };
        console.log('\n📤 RESPOSTA ENVIADA:\n', JSON.stringify(responseData, null, 2));
        return response.status(200).json(responseData);

    } catch (error) {
        console.error('❌ Erro CRÍTICO no webhook:', error);
        return response.status(200).json({ status: 'error', message: 'Desculpe, ocorreu um erro interno.' });
    }
});

// =================================================================
// FUNÇÕES DE AGENDAMENTO E AUXILIARES
// =================================================================
async function handleScheduling(barbeariaId, personInfo, requestedDateDayjs, servicoId, telefone, servicoEncontrado = null) {
    let servico = servicoEncontrado;
    if (!servico) {
        const servicesList = await getServices(barbeariaId); // Usa o cache
        servico = servicesList.find(s => s.id === servicoId);
        if (!servico) return { success: false, message: 'O serviço selecionado não foi encontrado.' };
    }

    const duracao = Number(servico.duracaoMinutos || 30);
    console.log(`🔧 Validando agendamento: ${requestedDateDayjs.format('YYYY-MM-DD HH:mm')} (${duracao}min)`);
    
    const businessHoursCheck = await checkBusinessHours(barbeariaId, requestedDateDayjs, duracao);
    if (!businessHoursCheck.isOpen) return { success: false, message: businessHoursCheck.message };

    const hasConflict = await checkConflicts(barbeariaId, requestedDateDayjs.toDate(), duracao);
    if (hasConflict) {
        await saveUserContext(barbeariaId, telefone, servico.id, servico.nome, requestedDateDayjs.toISOString());
        const suggestions = await getAvailableSlots(barbeariaId, requestedDateDayjs.toDate(), duracao);
        return { success: false, type: 'suggestion', message: suggestions };
    }

    await saveAppointment(barbeariaId, personInfo, requestedDateDayjs.toDate(), servico);
    const formattedDateForUser = requestedDateDayjs.format('dddd, DD [de] MMMM [às] HH:mm');
    return { success: true, message: `Perfeito, ${personInfo.name}! Seu agendamento de ${servico.nome} foi confirmado para ${formattedDateForUser}.` };
}

async function checkBusinessHours(barbeariaId, dateDayjs, duracaoMinutos) {
    const hoursByDay = businessHoursCache.get(barbeariaId);
    if (!hoursByDay) {
        console.warn("Cache de horários não encontrado, buscando no DB...");
        await cacheBarbeariaData(barbeariaId);
        return checkBusinessHours(barbeariaId, dateDayjs, duracaoMinutos);
    }
    const dayOfWeek = dateDayjs.day();
    const dayConfig = hoursByDay.get(String(dayOfWeek));

    if (!dayConfig || !dayConfig.aberto) {
        return { isOpen: false, message: `Desculpe, não funcionamos neste dia da semana.` };
    }
    
    const timeToMinutes = (timeStr) => {
        if (!timeStr) return null; const [h, m] = timeStr.split(':').map(Number); return (h * 60) + (m || 0);
    };

    const requestedStartMinutes = dateDayjs.hour() * 60 + dateDayjs.minute();
    const requestedEndMinutes = requestedStartMinutes + duracaoMinutos;

    const morningStart = timeToMinutes(dayConfig.InicioManha);
    const morningEnd = timeToMinutes(dayConfig.FimManha);
    const afternoonStart = timeToMinutes(dayConfig.InicioTarde);
    const afternoonEnd = timeToMinutes(dayConfig.FimTarde);

    const fitsInMorning = (morningStart !== null && morningEnd !== null) && (requestedStartMinutes >= morningStart && requestedEndMinutes <= morningEnd);
    const fitsInAfternoon = (afternoonStart !== null && afternoonEnd !== null) && (requestedStartMinutes >= afternoonStart && requestedEndMinutes <= afternoonEnd);

    if (fitsInMorning || fitsInAfternoon) return { isOpen: true };

    let horarioMsg = "Nosso horário de funcionamento é";
    const periods = [];
    if (dayConfig.InicioManha && dayConfig.FimManha) periods.push(`das ${dayConfig.InicioManha} às ${dayConfig.FimManha}`);
    if (dayConfig.InicioTarde && dayConfig.FimTarde) periods.push(`das ${dayConfig.InicioTarde} às ${dayConfig.FimTarde}`);

    if (periods.length === 2) horarioMsg += ` ${periods[0]} e ${periods[1]}`;
    else if (periods.length === 1) horarioMsg += ` ${periods[0]}`;
    else horarioMsg = "Não há horários de funcionamento configurados";

    return { isOpen: false, message: `${horarioMsg}. O serviço solicitado (${duracaoMinutos} minutos) não se encaixa.` };
}

async function getAvailableSlots(barbeariaId, requestedDate, duracaoMinutos) {
    try {
        const requestedDateDayjs = dayjs(requestedDate).tz(CONFIG.timezone);
        let availableSlots = await findAvailableSlotsForDay(barbeariaId, requestedDateDayjs, duracaoMinutos);
        if (availableSlots.length > 0) {
            const dateStr = requestedDateDayjs.isSame(dayjs(), 'day') ? 'hoje' : `no dia ${requestedDateDayjs.format('DD/MM')}`;
            return `O horário solicitado está ocupado. 😓\nMas tenho estes horários livres ${dateStr}: ${availableSlots.slice(0, 3).join(', ')}.\n\n💡 Escolha um dos horários acima.`;
        }
        const tomorrow = requestedDateDayjs.add(1, 'day');
        availableSlots = await findAvailableSlotsForDay(barbeariaId, tomorrow, duracaoMinutos);
        if (availableSlots.length > 0) {
            const dateStr = tomorrow.format('DD/MM');
            return `Não tenho mais vagas para este dia. 😓\nPara o dia seguinte (${dateStr}), tenho estes horários: ${availableSlots.slice(0, 3).join(', ')}.\n\n💡 Escolha um dos horários acima.`;
        }
        return "Este horário já está ocupado e não encontrei outras vagas próximas. 😓 Por favor, tente outro dia.";
    } catch (error) {
        console.error("❌ Erro ao buscar horários disponíveis:", error);
        return "Este horário está ocupado. Tente outro ou entre em contato conosco.";
    }
}

async function findAvailableSlotsForDay(barbeariaId, dayDate, duracaoMinutos) {
    const dayDateTz = dayjs(dayDate).tz(CONFIG.timezone);
    const hoursByDay = businessHoursCache.get(barbeariaId);
    if (!hoursByDay) { await cacheBarbeariaData(barbeariaId); return findAvailableSlotsForDay(barbeariaId, dayDate, duracaoMinutos); }
    
    const dayConfig = hoursByDay.get(String(dayDateTz.day()));
    if (!dayConfig || !dayConfig.aberto) return [];

    const timeToMinutes = (str) => { if (!str) return null; const [h, m] = String(str).split(':').map(Number); return (h * 60) + (m || 0); };
    const workPeriods = [];
    const morningStart = timeToMinutes(dayConfig.InicioManha);
    const morningEnd = timeToMinutes(dayConfig.FimManha);
    if (morningStart !== null && morningEnd !== null) workPeriods.push({ start: morningStart, end: morningEnd });
    const afternoonStart = timeToMinutes(dayConfig.InicioTarde);
    const afternoonEnd = timeToMinutes(dayConfig.FimTarde);
    if (afternoonStart !== null && afternoonEnd !== null) workPeriods.push({ start: afternoonStart, end: afternoonEnd });

    const startOfDayIso = dayDateTz.startOf('day').toISOString();
    const endOfDayIso = dayDateTz.endOf('day').toISOString();
    const snapshot = await db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.schedules)
        .where('Status', '==', 'Agendado').where('DataHoraISO', '>=', startOfDayIso).where('DataHoraISO', '<=', endOfDayIso).get();

    const busySlots = snapshot.docs.map(doc => {
        const data = doc.data();
        const startTime = dayjs(data.DataHoraISO);
        const duration = Number(data.duracaoMinutos || 30);
        return { start: startTime.valueOf(), end: startTime.add(duration, 'minute').valueOf() };
    });

    const availableSlots = [];
    const currentTime = dayjs().tz(CONFIG.timezone);
    for (const period of workPeriods) {
        for (let minuto = period.start; minuto + duracaoMinutos <= period.end; minuto += 30) {
            const slotDate = dayDateTz.startOf('day').add(minuto, 'minute');
            if (slotDate.isBefore(currentTime)) continue;
            const slotStart = slotDate.valueOf();
            const slotEnd = slotDate.add(duracaoMinutos, 'minute').valueOf();
            if (!busySlots.some(busy => (slotStart < busy.end && slotEnd > busy.start))) {
                availableSlots.push(slotDate.format('HH:mm'));
            }
        }
    }
    return [...new Set(availableSlots)];
}

async function handleCancellation(barbeariaId, personInfo) {
    const schedulesRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.schedules);
    const snapshot = await schedulesRef
        .where('TelefoneCliente', '==', personInfo.phone).where('Status', '==', 'Agendado')
        .where('DataHoraISO', '>', new Date().toISOString()).get();
    if (snapshot.empty) return { success: false, message: `Não encontrei nenhum agendamento futuro no seu telefone.` };

    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.update(doc.ref, { Status: 'Cancelado' }));
    await batch.commit();
    return { success: true, message: `Tudo certo! Cancelei ${snapshot.size} agendamento(s) futuro(s) que encontrei.` };
}

async function checkConflicts(barbeariaId, requestedDate, duracaoMinutos) {
    const requestedStart = requestedDate.getTime();
    const requestedEnd = requestedStart + (duracaoMinutos * 60 * 1000);
    const searchStart = new Date(requestedStart - (2 * 60 * 60 * 1000));
    const searchEnd = new Date(requestedStart + (2 * 60 * 60 * 1000));

    const snapshot = await db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.schedules)
        .where('Status', '==', 'Agendado').where('DataHoraISO', '>=', searchStart.toISOString()).where('DataHoraISO', '<=', searchEnd.toISOString()).get();
    
    for (const doc of snapshot.docs) {
        const existingData = doc.data();
        const existingStart = new Date(existingData.DataHoraISO).getTime();
        const existingEnd = existingStart + ((existingData.duracaoMinutos || 30) * 60 * 1000);
        if (requestedStart < existingEnd && requestedEnd > existingStart) return true;
    }
    return false;
}

async function saveAppointment(barbeariaId, personInfo, requestedDate, servico) {
    await db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.schedules).add({
        NomeCliente: personInfo.name, TelefoneCliente: personInfo.phone,
        DataHoraISO: requestedDate.toISOString(), Status: 'Agendado',
        TimestampAgendamento: new Date().toISOString(), servicoId: servico.id,
        servicoNome: servico.nome, preco: servico.preco || 0,
        duracaoMinutos: servico.duracaoMinutos || 30,
    });
}

// =================================================================
// INICIALIZAÇÃO DO SERVIDOR
// =================================================================
const mainBarbeariaId = "hmLpfrXYE3CihDzUh3mT";
cacheBarbeariaData(mainBarbeariaId).then(() => {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => { console.log(`🚀 Webhook rodando na porta ${PORT}`); });
});

module.exports = app;
