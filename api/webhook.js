// =================================================================
// WEBHOOK MULTI-TENANT COM IA PERPLEXITY - VERSÃO HÍBRIDA (LÓGICA DE DATA ANTIGA + MELHORIAS)
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

// =================================================================
// FUNÇÕES DE CONTEXTO (Com limpeza assíncrona)
// =================================================================
async function saveUserContext(barbeariaId, telefone, servicoId, servicoNome, dataOriginalISO) {
    try {
        const contextRef = db.collection(CONFIG.collections.barbearias)
            .doc(barbeariaId)
            .collection('contextos')
            .doc(telefone);

        await contextRef.set({
            servicoId,
            servicoNome,
            dataOriginal: dataOriginalISO, // Salva a string ISO
            dataSugerida: dataOriginalISO,
            criadoEm: new Date().toISOString(),
            expirarEm: new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10 minutos
        }, { merge: true });

        console.log(`💾 Contexto salvo para ${telefone}: ${servicoNome} (Data sugerida: ${dataOriginalISO})`);
    } catch (error) {
        console.error(`❌ Erro ao salvar contexto:`, error);
    }
}

async function getUserContext(barbeariaId, telefone) {
    try {
        const contextRef = db.collection(CONFIG.collections.barbearias)
            .doc(barbeariaId)
            .collection('contextos')
            .doc(telefone);

        const contextSnap = await contextRef.get();
        if (!contextSnap.exists) {
            console.log(`📭 Nenhum contexto encontrado para ${telefone}`);
            return null;
        }

        const context = contextSnap.data();
        const now = new Date();
        const expiraEm = new Date(context.expirarEm);

        if (now > expiraEm) {
            console.log(`⏰ Contexto expirado para ${telefone}`);
            await contextRef.delete();
            return null;
        }

        console.log(`📬 Contexto recuperado para ${telefone}: ${context.servicoNome} (Data: ${context.dataSugerida})`);
        return context;
    } catch (err) {
        console.error('❌ Erro ao recuperar contexto:', err);
        return null;
    }
}

function clearUserContextAsync(barbeariaId, telefone) {
    setImmediate(async () => {
        try {
            const contextRef = db.collection(CONFIG.collections.barbearias)
                .doc(barbeariaId)
                .collection('contextos')
                .doc(telefone);

            await contextRef.delete();
            console.log(`🗑️ Contexto limpo para ${telefone}`);
        } catch (error) {
            console.error(`❌ Erro ao limpar contexto:`, error);
        }
    });
}

// =================================================================
// FUNÇÃO DE IA PERPLEXITY (Mantida)
// =================================================================
async function getIntentWithPerplexity(text, servicesList) {
    if (!CONFIG.perplexityApiKey) {
        console.error("❌ Chave da API do Perplexity não configurada.");
        return { success: false, message: "O serviço de IA não está configurado." };
    }

    try {
        const serviceNames = servicesList.map(s => `"${s.nome}"`).join(', ');
        const currentLocalTime = dayjs().tz(CONFIG.timezone).format('dddd, DD/MM/YYYY HH:mm');

        const systemPrompt = `Você é um assistente de agendamento para uma barbearia no Brasil (fuso horário: ${CONFIG.timezone}).\nA data/hora atual de referência é ${currentLocalTime}.\nServiços disponíveis: [${serviceNames}].\n\nSua tarefa é analisar a mensagem do usuário e retornar APENAS um objeto JSON válido com a estrutura: {"intent": "agendarHorario" | "cancelarHorario" | "informacao", "dataHoraISO": "YYYY-MM-DDTHH:mm:ss-03:00" | null, "servicoNome": "Nome Exato do Serviço" | null}.`;

        const response = await fetch("https://api.perplexity.ai/chat/completions", {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Authorization': `Bearer ${CONFIG.perplexityApiKey}` 
            },
            body: JSON.stringify({
                model: 'sonar',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: text }
                ],
                max_tokens: 200,
                temperature: 0.1
            })
        });

        if (!response.ok) throw new Error(`API Perplexity falhou com status ${response.status}`);

        const data = await response.json();
        const responseText = data.choices?.[0]?.message?.content || data.choices?.[0]?.text || '';
        console.log("🔍 Resposta bruta da IA:", responseText);

        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("A resposta da IA não continha JSON.");

        const parsedResponse = JSON.parse(jsonMatch[0]);
        return { success: true, data: parsedResponse };

    } catch (error) {
        console.error("❌ Erro ao chamar a API Perplexity:", error);
        return { success: false, message: "Não consegui entender sua solicitação no momento." };
    }
}

// =================================================================
// ENDPOINT PRINCIPAL
// =================================================================
app.post('/api/webhook', async (request, response) => {
    const { nome, telefone, data_hora_texto, barbeariaId } = request.body;
    console.log('\n📄 === NOVO REQUEST WEBHOOK ===\n', JSON.stringify(request.body, null, 2));

    try {
        if (!barbeariaId || !data_hora_texto) {
            return response.status(400).json({ status: 'error', message: 'Dados insuficientes.' });
        }

        const barbeariaRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId);
        const barbeariaSnap = await barbeariaRef.get();
        if (!barbeariaSnap.exists) {
            return response.status(200).json({ status: 'error', message: 'Barbearia não encontrada.' });
        }

        const servicesSnapshot = await barbeariaRef
            .collection(CONFIG.collections.services)
            .where('ativo', '==', true)
            .get();

        const servicesList = servicesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        if (servicesList.length === 0) {
            return response.status(200).json({ status: 'error', message: 'Nenhum serviço configurado.' });
        }

        const userContext = await getUserContext(barbeariaId, telefone);

        const aiResponse = await getIntentWithPerplexity(data_hora_texto, servicesList);
        if (!aiResponse.success) {
            return response.status(200).json({ status: 'error', message: aiResponse.message });
        }

        let { intent, dataHoraISO, servicoNome } = aiResponse.data;
        console.log('🤖 Intent processado:', { intent, dataHoraISO, servicoNome });

        // CORREÇÃO APLICADA AQUI: Adicionado .tz() para garantir o fuso correto
        let parsedDateDayjs = dataHoraISO ? dayjs(dataHoraISO).tz(CONFIG.timezone) : null;
        
        const personInfo = { name: nome, phone: telefone };

        let resultPayload;

        if (intent === 'agendarHorario') {
            if (!parsedDateDayjs || !parsedDateDayjs.isValid()) {
                resultPayload = { success: false, message: "Não consegui entender a data e hora. Tente algo como 'amanhã às 16h' ou 'hoje às 14h30'." };
            } else {
                if (userContext && userContext.dataSugerida) {
                    const contextDate = dayjs(userContext.dataSugerida).tz(CONFIG.timezone, true);
                    const aiTime = parsedDateDayjs;
                    
                    const today = dayjs().tz(CONFIG.timezone).startOf('day');
                    if (aiTime.startOf('day').isSame(today, 'day') && !contextDate.startOf('day').isSame(today, 'day')) {
                        parsedDateDayjs = contextDate.hour(aiTime.hour()).minute(aiTime.minute()).second(0);
                        console.log(`🔄 Usando data do contexto: ${parsedDateDayjs.format('YYYY-MM-DD HH:mm')}`);
                    }
                }

                let servicoEncontrado = null;
                if (servicoNome) {
                    servicoEncontrado = servicesList.find(s => 
                        s.nome.toLowerCase().includes(servicoNome.toLowerCase()) ||
                        servicoNome.toLowerCase().includes(s.nome.toLowerCase())
                    );
                }

                if (!servicoEncontrado && userContext) {
                    servicoEncontrado = servicesList.find(s => s.id === userContext.servicoId);
                    console.log(`🔄 Usando serviço do contexto por ID: ${servicoEncontrado?.nome}`);
                }

                if (!servicoEncontrado) servicoEncontrado = servicesList[0];

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
// FUNÇÕES DE AGENDAMENTO (com lógica de data/hora antiga)
// =================================================================
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
        const servicoRef = db.collection(CONFIG.collections.barbearias)
            .doc(barbeariaId)
            .collection(CONFIG.collections.services)
            .doc(servicoId);
        const servicoSnap = await servicoRef.get();
        if (!servicoSnap.exists) {
            return { success: false, message: 'O serviço selecionado não foi encontrado.' };
        }
        servico = { id: servicoSnap.id, ...servicoSnap.data() };
    }

    const duracao = Number(servico.duracaoMinutos || 30);
    console.log(`🔧 Validando agendamento: ${requestedDateDayjs.format('YYYY-MM-DD HH:mm')} (${duracao}min)`);

    const businessHoursCheck = await checkBusinessHours(barbeariaId, requestedDateDayjs, duracao);
    if (!businessHoursCheck.isOpen) return { success: false, message: businessHoursCheck.message };

    // A lógica de conflito agora usa o objeto Date do JS, como no código antigo
    const hasConflict = await checkConflicts(barbeariaId, requestedDateDayjs.toDate(), duracao);
    if (hasConflict) {
        // Salvar contexto quando houver conflito
        await saveUserContext(barbeariaId, telefone, servico.id, servico.nome, requestedDateDayjs.toISOString());
        
        const suggestions = await getAvailableSlots(barbeariaId, requestedDateDayjs.toDate(), duracao, telefone);
        return { success: false, type: 'suggestion', message: suggestions };
    }

    // Salvar agendamento com o objeto Date do JS, que virará string ISO
    await saveAppointment(barbeariaId, personInfo, requestedDateDayjs.toDate(), servico);

    const formattedDateForUser = requestedDateDayjs.format('dddd, DD [de] MMMM [às] HH:mm');
    return { success: true, message: `Perfeito, ${personInfo.name}! Seu agendamento de ${servico.nome} foi confirmado para ${formattedDateForUser}.` };
}

async function checkBusinessHours(barbeariaId, dateDayjs, duracaoMinutos) {
    // (Esta função não depende do formato do banco de dados, então pode ser mantida como está)
    const dayOfWeek = dateDayjs.day();
    const docRef = db.collection(CONFIG.collections.barbearias)
        .doc(barbeariaId)
        .collection(CONFIG.collections.config)
        .doc(String(dayOfWeek));
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

    return { isOpen: false, message: `${horarioMsg}. O serviço solicitado (${duracaoMinutos} minutos) não se encaixa nesse período.` };
}

async function getAvailableSlots(barbeariaId, requestedDate, duracaoMinutos) {
    try {
        const requestedDateDayjs = dayjs(requestedDate).tz(CONFIG.timezone);
        let availableSlots = await findAvailableSlotsForDay(barbeariaId, requestedDateDayjs, duracaoMinutos);

        if (availableSlots.length > 0) {
            const dateStr = requestedDateDayjs.isSame(dayjs(), 'day') ? 'hoje' : `no dia ${requestedDateDayjs.format('DD/MM')}`;
            const slotsText = availableSlots.slice(0, 3).join(', ');
            return `O horário solicitado está ocupado. 😓\nMas tenho estes horários livres ${dateStr}: ${slotsText}.\n\n💡 Escolha um dos horários acima.`;
        }

        const tomorrow = requestedDateDayjs.add(1, 'day');
        availableSlots = await findAvailableSlotsForDay(barbeariaId, tomorrow, duracaoMinutos);

        if (availableSlots.length > 0) {
            const dateStr = tomorrow.format('DD/MM');
            const slotsText = availableSlots.slice(0, 3).join(', ');
            return `Não tenho mais vagas para este dia. 😓\nPara o dia seguinte (${dateStr}), tenho estes horários: ${slotsText}.\n\n💡 Escolha um dos horários acima.`;
        }

        return "Este horário já está ocupado e não encontrei outras vagas próximas. 😓 Por favor, tente outro dia.";

    } catch (error) {
        console.error("❌ Erro ao buscar horários disponíveis:", error);
        return "Este horário está ocupado. Tente outro ou entre em contato conosco.";
    }
}

async function findAvailableSlotsForDay(barbeariaId, dayDate, duracaoMinutos) {
    const dayDateTz = dayjs(dayDate).tz(CONFIG.timezone);
    const dayOfWeek = dayDateTz.day();

    const docRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.config).doc(String(dayOfWeek));
    const docSnap = await docRef.get();
    if (!docSnap.exists || !docSnap.data().aberto) return [];

    const dayConfig = docSnap.data();
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
    
    const schedulesRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.schedules);
    const snapshot = await schedulesRef
        .where('Status', '==', 'Agendado')
        .where('DataHoraISO', '>=', startOfDayIso)
        .where('DataHoraISO', '<=', endOfDayIso)
        .get();

    const busySlots = snapshot.docs.map(doc => {
        const data = doc.data();
        // Lógica antiga: Assume que DataHoraISO é uma string
        const startTime = dayjs(data.DataHoraISO); 
        const duration = Number(data.duracaoMinutos || data.duracao || 30);
        return { start: startTime.valueOf(), end: startTime.add(duration, 'minute').valueOf() };
    });

    const availableSlots = [];
    const currentTime = dayjs().tz(CONFIG.timezone);
    const INTERVALO_MINUTOS = 30;

    for (const period of workPeriods) {
        for (let minuto = period.start; minuto + duracaoMinutos <= period.end; minuto += INTERVALO_MINUTOS) {
            const slotDate = dayDateTz.startOf('day').add(minuto, 'minute');
            if (slotDate.isBefore(currentTime)) continue;

            const slotStart = slotDate.valueOf();
            const slotEnd = slotDate.add(duracaoMinutos, 'minute').valueOf();

            const hasConflict = busySlots.some(busy => (slotStart < busy.end && slotEnd > busy.start));
            if (!hasConflict) availableSlots.push(slotDate.format('HH:mm'));
        }
    }

    const unique = [...new Set(availableSlots)];
    console.log(`✅ Vagas encontradas para ${dayDateTz.format('DD/MM')}: ${unique.join(', ')}`);
    return unique;
}

async function handleCancellation(barbeariaId, personInfo) {
    if (!personInfo.phone) return { success: false, message: "Para cancelar, preciso do seu telefone.", type: null };

    const schedulesRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.schedules);
    const snapshot = await schedulesRef
        .where('TelefoneCliente', '==', personInfo.phone)
        .where('Status', '==', 'Agendado')
        .where('DataHoraISO', '>', new Date().toISOString()) // Comparando strings
        .get();

    if (snapshot.empty) return { success: false, message: `Não encontrei nenhum agendamento futuro no seu telefone.`, type: null };

    const batch = db.batch();
    let count = 0;
    for (const doc of snapshot.docs) { batch.update(doc.ref, { Status: 'Cancelado' }); count++; }
    await batch.commit();

    return { success: true, message: `Tudo certo! Cancelei ${count} agendamento(s) futuro(s) que encontrei.`, type: null };
}

// =================================================================
// FUNÇÕES DE BANCO DE DADOS (com lógica de data/hora antiga)
// =================================================================
async function checkConflicts(barbeariaId, requestedDate, duracaoMinutos) {
    const serviceDurationMs = duracaoMinutos * 60 * 1000;
    const requestedStart = requestedDate.getTime();
    const requestedEnd = requestedStart + serviceDurationMs;

    const searchStart = new Date(requestedStart - (2 * 60 * 60 * 1000));
    const searchEnd = new Date(requestedStart + (2 * 60 * 60 * 1000));

    const schedulesRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.schedules);
    const snapshot = await schedulesRef
        .where('Status', '==', 'Agendado')
        .where('DataHoraISO', '>=', searchStart.toISOString()) // Query com string
        .where('DataHoraISO', '<=', searchEnd.toISOString()) // Query com string
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
        NomeCliente: personInfo.name,
        TelefoneCliente: personInfo.phone,
        DataHoraISO: requestedDate.toISOString(), // Salva como string ISO
        Status: 'Agendado',
        TimestampAgendamento: new Date().toISOString(),
        servicoId: servico.id,
        servicoNome: servico.nome,
        preco: servico.preco || 0,
        duracaoMinutos: servico.duracaoMinutos || 30,
    };

    console.log("💾 Salvando agendamento:", newAppointment);
    await schedulesRef.add(newAppointment);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`🚀 Webhook rodando na porta ${PORT}`); });

module.exports = app;
