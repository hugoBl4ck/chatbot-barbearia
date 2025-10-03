// =================================================================
// WEBHOOK V4.3 MELHORADO - SEM CACHE, COM CONTEXTO E GEMINI
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
    geminiApiKey: process.env.GEMINI_API_TYPEBOT, // Usando Gemini
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
// MELHORIA: FUNÇÕES DE CONTEXTO ADICIONADAS
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
        if (!contextSnap.exists) { return null; }
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
// MELHORIA: IA TROCADA PARA GEMINI
// =================================================================
async function getIntentWithGemini(text, servicesList) {
    if (!CONFIG.geminiApiKey) {
        return { success: false, message: "Chave da API do Gemini não configurada." };
    }
    const modelName = 'gemini-pro-latest';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${CONFIG.geminiApiKey}`;
    const serviceNames = servicesList.map(s => `"${s.nome}"`).join(', ');
    const currentLocalTime = dayjs().tz(CONFIG.timezone).format('dddd, DD/MM/YYYY HH:mm');
    const systemPrompt = `Você é um assistente de agendamento para uma barbearia no Brasil (fuso horário: ${CONFIG.timezone}). A data/hora atual de referência é ${currentLocalTime}. Serviços disponíveis: [${serviceNames}]. Sua tarefa é analisar a mensagem do usuário e retornar APENAS um objeto JSON válido com a estrutura: {"intent": "agendarHorario" | "cancelarHorario" | "informacao", "dataHoraISO": "YYYY-MM-DDTHH:mm:ss-03:00" | null, "servicoNome": "Nome Exato do Serviço" | null}.`;
    
    const requestBody = {
        contents: [{ parts: [{ text: systemPrompt + "\n\nUsuário: " + text }] }],
        generationConfig: {
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
            throw new Error(`API Gemini falhou: ${JSON.stringify(errorBody)}`);
        }

        const data = await response.json();
        const responseText = data.candidates[0].content.parts[0].text;
        console.log("🔍 Resposta bruta da IA (Gemini):", responseText);

        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error("A resposta da IA (Gemini) não continha um JSON válido.");
        }

        return { success: true, data: JSON.parse(jsonMatch[0]) };

    } catch (error) {
        console.error("❌ Erro ao chamar a API Gemini:", error);
        return { success: false, message: "Não consegui falar com o assistente de IA no momento." };
    }
}


// =================================================================
// ENDPOINT PRINCIPAL COM MELHORIAS DE FLUXO
// =================================================================
app.post("/api/webhook", async (request, response) => {
    const { nome, telefone, data_hora_texto, barbeariaId } = request.body;
    console.log("\n📄 === NOVO REQUEST WEBHOOK ===\n", JSON.stringify(request.body, null, 2));
    
    try {
        if (!barbeariaId || !data_hora_texto) {
            return response.status(400).json({ status: 'error', message: 'Dados insuficientes.' });
        }

        const barbeariaRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId);
        const barbeariaSnap = await barbeariaRef.get();
        
        if (!barbeariaSnap.exists) {
            return response.status(200).json({ status: 'error', message: 'Barbearia não encontrada.' });
        }

        const servicesSnapshot = await barbeariaRef.collection(CONFIG.collections.services).where('ativo', '==', true).get();
        const servicesList = servicesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        
        if (servicesList.length === 0) {
            return response.status(200).json({ status: 'error', message: 'Nenhum serviço configurado.' });
        }

        // MELHORIA: Execução paralela
        const [userContext, aiResult] = await Promise.all([
            getUserContext(barbeariaId, telefone),
            getIntentWithGemini(data_hora_texto, servicesList)
        ]);

        if (!aiResult.success) {
            return response.status(200).json({ status: 'error', message: aiResult.message });
        }

        let { intent, dataHoraISO, servicoNome } = aiResult.data;
        console.log("🤖 Intent processado:", { intent, dataHoraISO, servicoNome });
        
        const parsedDateDayjs = dataHoraISO ? dayjs(dataHoraISO).tz(CONFIG.timezone) : null;
        const personInfo = { name: nome, phone: telefone };
        let resultPayload;

        if (intent === 'agendarHorario') {
            if (!parsedDateDayjs || !parsedDateDayjs.isValid()) {
                resultPayload = { success: false, message: "Não consegui entender a data e hora. Tente algo como 'amanhã às 16h' ou 'hoje às 14h30'." };
            } else {
                 // MELHORIA: Lógica de contexto para data/hora
                if (userContext && userContext.dataSugerida) {
                    const contextDate = dayjs(userContext.dataSugerida).tz(CONFIG.timezone, true);
                    const aiTime = parsedDateDayjs;
                    const today = dayjs().tz(CONFIG.timezone).startOf('day');
                    if (aiTime.startOf('day').isSame(today, 'day') && !contextDate.startOf('day').isSame(today, 'day')) {
                        parsedDateDayjs = contextDate.hour(aiTime.hour()).minute(aiTime.minute()).second(0);
                    }
                }

                let servicoEncontrado = servicesList.find(s => servicoNome && (s.nome.toLowerCase().includes(servicoNome.toLowerCase()) || servicoNome.toLowerCase().includes(s.nome.toLowerCase())));
                
                // MELHORIA: Lógica de contexto para serviço
                if (!servicoEncontrado && userContext) {
                    servicoEncontrado = servicesList.find(s => s.id === userContext.servicoId);
                }

                if (!servicoEncontrado) {
                    servicoEncontrado = servicesList[0];
                }

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
            clearUserContextAsync(barbeariaId, telefone); // MELHORIA: Limpa contexto no cancelamento
        } else {
            resultPayload = { success: false, message: 'Não entendi o que você quer fazer. Você quer agendar ou cancelar um horário?' };
        }
        
        const responseData = { status: resultPayload.success ? 'success' : 'error', message: resultPayload.message, type: resultPayload.type || null };
        console.log(`\n📤 RESPOSTA ENVIADA:\n`, JSON.stringify(responseData, null, 2));
        return response.status(200).json(responseData);
        
    } catch (error) {
        console.error("❌ Erro CRÍTICO no webhook:", error);
        return response.status(200).json({ status: 'error', message: 'Desculpe, ocorreu um erro interno.' });
    }
});
    
// handleScheduling adaptado para receber os novos parâmetros
async function handleScheduling(barbeariaId, personInfo, requestedDateDayjs, servicoId, telefone, servicoEncontrado = null) {
    if (!personInfo.name || !personInfo.phone) {
        return { success: false, message: 'Para agendar, preciso do seu nome e telefone.' };
    }
    
    const currentTime = dayjs().tz(CONFIG.timezone);
    if (requestedDateDayjs.isBefore(currentTime)) {
        return { success: false, message: 'Não é possível agendar no passado.' };
    }

    let servico = servicoEncontrado;
    if (!servico) {
        const servicoRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.services).doc(servicoId);
        const servicoSnap = await servicoRef.get();
        if (!servicoSnap.exists) {
            return { success: false, message: 'O serviço selecionado não foi encontrado.' };
        }
        servico = { id: servicoSnap.id, ...servicoSnap.data() };
    }
    
    const duracao = servico.duracaoMinutos || 30;
    console.log(`🔧 Validando agendamento: ${requestedDateDayjs.format('YYYY-MM-DD HH:mm')} (${duracao}min)`);

    const businessHoursCheck = await checkBusinessHours(barbeariaId, requestedDateDayjs, duracao);
    if (!businessHoursCheck.isOpen) {
        return { success: false, message: businessHoursCheck.message };
    }

    const hasConflict = await checkConflicts(barbeariaId, requestedDateDayjs.toDate(), duracao);
    if (hasConflict) {
        // MELHORIA: Salva contexto apenas no conflito
        await saveUserContext(barbeariaId, telefone, servico.id, servico.nome, requestedDateDayjs.toISOString());
        const suggestions = await getAvailableSlots(barbeariaId, requestedDateDayjs.toDate(), duracao);
        return { success: false, type: 'suggestion', message: suggestions };
    }

    await saveAppointment(barbeariaId, personInfo, requestedDateDayjs.toDate(), servico);
    const formattedDateForUser = requestedDateDayjs.format('dddd, DD [de] MMMM [às] HH:mm');
    return { success: true, message: `Perfeito, ${personInfo.name}! Seu agendamento de ${servico.nome} foi confirmado para ${formattedDateForUser}.` };
}

// O restante das funções permanece como no seu arquivo original, pois não precisavam de alteração

async function checkBusinessHours(barbeariaId, dateDayjs, duracaoMinutos) {
    const dayOfWeek = dateDayjs.day();
    const docRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.config).doc(String(dayOfWeek));
    const docSnap = await docRef.get();

    if (!docSnap.exists || !docSnap.data().aberto) {
        return { isOpen: false, message: `Desculpe, não funcionamos neste dia da semana.` };
    }
    
    const dayConfig = docSnap.data();
    const timeToMinutes = (timeStr) => {
        if (!timeStr || typeof timeStr !== 'string') return null;
        const [hours, minutes] = timeStr.split(':').map(Number);
        if (isNaN(hours) || isNaN(minutes)) return null;
        return (hours * 60) + (minutes || 0);
    };

    const requestedStartMinutes = dateDayjs.hour() * 60 + dateDayjs.minute();
    const requestedEndMinutes = requestedStartMinutes + duracaoMinutos;
    const morningStart = timeToMinutes(dayConfig.InicioManha);
    const morningEnd = timeToMinutes(dayConfig.FimManha);
    const afternoonStart = timeToMinutes(dayConfig.InicioTarde);
    const afternoonEnd = timeToMinutes(dayConfig.FimTarde);

    console.log("🕐 === VERIFICAÇÃO DE HORÁRIO DE FUNCIONAMENTO ===");
    console.log(`📅 Data/hora solicitada: ${dateDayjs.format('YYYY-MM-DD HH:mm')} (${duracaoMinutos}min)`);
    console.log(`⏰ Horário solicitado (minutos): ${requestedStartMinutes} até ${requestedEndMinutes}`);
    console.log(`🌅 Manhã: ${morningStart} até ${morningEnd} (${dayConfig.InicioManha} às ${dayConfig.FimManha})`);
    console.log(`🌆 Tarde: ${afternoonStart} até ${afternoonEnd} (${dayConfig.InicioTarde} às ${dayConfig.FimTarde})`);

    const fitsInMorning = (morningStart !== null && morningEnd !== null) && (requestedStartMinutes >= morningStart && requestedEndMinutes <= morningEnd);
    const fitsInAfternoon = (afternoonStart !== null && afternoonEnd !== null) && (requestedStartMinutes >= afternoonStart && requestedEndMinutes <= afternoonEnd);
    
    console.log(`✅ Cabe na manhã? ${fitsInMorning}`);
    console.log(`✅ Cabe na tarde? ${fitsInAfternoon}`);

    if (fitsInMorning || fitsInAfternoon) {
        console.log("🎉 APROVADO: Horário está dentro do funcionamento!");
        return { isOpen: true };
    } else {
        let horarioMsg = "Nosso horário de funcionamento é";
        const periods = [];
        if (dayConfig.InicioManha && dayConfig.FimManha) { periods.push(`das ${dayConfig.InicioManha} às ${dayConfig.FimManha}`); }
        if (dayConfig.InicioTarde && dayConfig.FimTarde) { periods.push(`das ${dayConfig.InicioTarde} às ${dayConfig.FimTarde}`); }
        if (periods.length === 2) { horarioMsg += ` ${periods[0]} e ${periods[1]}`; } 
        else if (periods.length === 1) { horarioMsg += ` ${periods[0]}`; } 
        else { horarioMsg = "Não há horários de funcionamento configurados"; }
        
        const msg = `${horarioMsg}. O serviço solicitado (${duracaoMinutos} minutos) não se encaixa nesse período.`;
        console.log(`❌ REJEITADO: ${msg}`);
        return { isOpen: false, message: msg };
    }
}

async function getAvailableSlots(barbeariaId, requestedDate, duracaoMinutos) {
    const requestedDateDayjs = dayjs(requestedDate).tz(CONFIG.timezone);
    
    let availableSlots = await findAvailableSlotsForDay(barbeariaId, requestedDateDayjs, duracaoMinutos);
    if (availableSlots.length > 0) {
        return `O horário solicitado está ocupado. 😔\nMas tenho estes horários livres hoje: ${availableSlots.slice(0, 3).join(', ')}.`;
    }
    
    const tomorrow = requestedDateDayjs.add(1, 'day');
    availableSlots = await findAvailableSlotsForDay(barbeariaId, tomorrow, duracaoMinutos);
    if (availableSlots.length > 0) {
        return `Não tenho mais vagas para hoje. 😔\nPara amanhã, tenho estes horários: ${availableSlots.slice(0, 3).join(', ')}.`;
    }
    
    return "Este horário já está ocupado e não encontrei outras vagas próximas. 😔";
}

async function findAvailableSlotsForDay(barbeariaId, dayDate, duracaoMinutos) {
    const dayOfWeek = dayDate.day();
    const docRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.config).doc(String(dayOfWeek));
    const docSnap = await docRef.get();
    if (!docSnap.exists || !docSnap.data().aberto) { return []; }
    
    const dayConfig = docSnap.data();
    const timeToMinutes = (str) => { 
        if (!str) return null; 
        const [h, m] = str.split(':').map(Number); 
        return (h * 60) + (m || 0); 
    };
    const formatTime = (totalMinutes) => `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
    
    const morningStart = timeToMinutes(dayConfig.InicioManha);
    const morningEnd = timeToMinutes(dayConfig.FimManha);
    const afternoonStart = timeToMinutes(dayConfig.InicioTarde);
    const afternoonEnd = timeToMinutes(dayConfig.FimTarde);
    
    const startOfDay = dayDate.startOf('day').toDate();
    const endOfDay = dayDate.endOf('day').toDate();
    const schedulesRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.schedules);
    
    const snapshot = await schedulesRef
        .where('Status', '==', 'Agendado')
        .where('DataHoraISO', '>=', startOfDay.toISOString())
        .where('DataHoraISO', '<=', endOfDay.toISOString())
        .get();
    
    const busySlots = snapshot.docs.map(doc => {
        const data = doc.data();
        const startTime = dayjs(data.DataHoraISO).tz(CONFIG.timezone);
        return { 
            start: startTime.hour() * 60 + startTime.minute(), 
            end: startTime.hour() * 60 + startTime.minute() + (data.duracaoMinutos || 30) 
        };
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
            if (!hasConflict) {
                availableSlots.push(formatTime(time));
            }
        }
    };
    
    addSlotsFromPeriod(morningStart, morningEnd);
    addSlotsFromPeriod(afternoonStart, afternoonEnd);
    
    return availableSlots;
}

async function handleCancellation(barbeariaId, personInfo) {
    if (!personInfo.phone) {
        return { success: false, message: "Para cancelar, preciso do seu telefone.", type: null };
    }
    
    const schedulesRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.schedules);
    const snapshot = await schedulesRef
        .where('TelefoneCliente', '==', personInfo.phone)
        .where('Status', '==', 'Agendado')
        .where('DataHoraISO', '>', new Date().toISOString())
        .get();
    
    if (snapshot.empty) {
        return { success: false, message: `Não encontrei nenhum agendamento futuro no seu telefone.`, type: null };
    }
    
    let count = 0;
    const batch = db.batch();
    for (const doc of snapshot.docs) {
        batch.update(doc.ref, { Status: 'Cancelado' });
        count++;
    }
    await batch.commit();
    
    return { success: true, message: `Tudo certo! Cancelei ${count} agendamento(s) futuro(s) que encontrei.`, type: null };
}

async function checkConflicts(barbeariaId, requestedDate, duracaoMinutos) {
    const serviceDurationMs = duracaoMinutos * 60 * 1000;
    const requestedStart = requestedDate.getTime();
    const requestedEnd = requestedStart + serviceDurationMs;
    
    const searchStart = new Date(requestedStart - (2 * 60 * 60 * 1000));
    const searchEnd = new Date(requestedStart + (2 * 60 * 60 * 1000));
    
    const schedulesRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.schedules);
    const snapshot = await schedulesRef
        .where('Status', '==', 'Agendado')
        .where('DataHoraISO', '>=', searchStart.toISOString())
        .where('DataHoraISO', '<=', searchEnd.toISOString())
        .get();
    
    for (const doc of snapshot.docs) {
        const existingData = doc.data();
        const existingStart = new Date(existingData.DataHoraISO).getTime();
        const existingDuration = existingData.duracaoMinutos || 30;
        const existingEnd = existingStart + (existingDuration * 60 * 1000);
        
        if (requestedStart < existingEnd && requestedEnd > existingStart) {
            console.log(`⚠️ Conflito detectado com agendamento existente:`, {
                existing: { start: new Date(existingStart), end: new Date(existingEnd) },
                requested: { start: new Date(requestedStart), end: new Date(requestedEnd) }
            });
            return true;
        }
    }
    return false;
}

async function saveAppointment(barbeariaId, personInfo, requestedDate, servico) {
    const schedulesRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.schedules);
    const newAppointment = {
        NomeCliente: personInfo.name, TelefoneCliente: personInfo.phone,
        DataHoraISO: requestedDate.toISOString(), Status: 'Agendado',
        TimestampAgendamento: new Date().toISOString(), servicoId: servico.id,
        servicoNome: servico.nome, preco: servico.preco || 0,
        duracaoMinutos: servico.duracaoMinutos || 30,
    };
    
    console.log("💾 Salvando agendamento:", newAppointment);
    await schedulesRef.add(newAppointment);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Webhook rodando na porta ${PORT}`);
});

module.exports = app;
