// =================================================================
// WEBHOOK MULTI-TENANT COM IA PERPLEXITY - VERSÃO 3.1 CORRIGIDA
// =================================================================
const express = require("express");
const admin = require('firebase-admin');
const dayjs = require('dayjs');
const timezone = require('dayjs/plugin/timezone');
const utc = require('dayjs/plugin/utc');
const customParseFormat = require('dayjs/plugin/customParseFormat');
require('dayjs/locale/pt-br');

// --- CONFIGURAÇÃO ---
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);
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

// Inicializa o Firebase Admin SDK
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(CONFIG.firebaseCreds) });
}
const db = admin.firestore();

// --- FUNÇÃO MELHORADA COM IA PERPLEXITY ---
async function getIntentAndDateFromPerplexity(text, servicesList) {
    if (!CONFIG.perplexityApiKey) {
        console.error("❌ Chave da API do Perplexity não configurada.");
        return null;
    }

    try {
        const serviceNames = servicesList.map(s => s.nome).join(', ');
        const currentDateTime = dayjs().tz(CONFIG.timezone);
        
        const systemPrompt = `Você é um assistente de agendamento para barbearias no Brasil. 
        Data/hora atual: ${currentDateTime.format('YYYY-MM-DD HH:mm')} (timezone: ${CONFIG.timezone})
        Lista de serviços válidos: [${serviceNames}]
        
        Analise a mensagem do usuário e retorne APENAS um objeto JSON válido:
        {
            "intent": "agendarHorario" | "cancelarHorario" | "informacao",
            "dataHoraISO": "YYYY-MM-DDTHH:mm:ss.sssZ" | null,
            "servicoNome": "Nome do Serviço" | null,
            "confianca": 0.0 a 1.0
        }
        
        REGRAS CRÍTICAS PARA HORÁRIOS:
        - Estamos no fuso horário ${CONFIG.timezone} (GMT-3)
        - Para "hoje às 16h": use ${currentDateTime.format('YYYY-MM-DD')}T16:00:00.000Z mas ajuste para UTC (-3h = 19:00 UTC)
        - Para "amanhã às 14h": use ${currentDateTime.add(1, 'day').format('YYYY-MM-DD')}T14:00:00.000Z mas ajuste para UTC (-3h = 17:00 UTC)
        - SEMPRE converta o horário local brasileiro para UTC adicionando 3 horas
        - Exemplo: 16:00 Brasil = 19:00 UTC
        - Se não conseguir identificar data/hora, retorne null
        - Se serviço não estiver na lista, retorne null para servicoNome
        
        EXEMPLOS DE CONVERSÃO:
        - "hoje às 16h" → "${currentDateTime.format('YYYY-MM-DD')}T19:00:00.000Z"
        - "amanhã às 14h" → "${currentDateTime.add(1, 'day').format('YYYY-MM-DD')}T17:00:00.000Z"`;
        
        const response = await fetch("https://api.perplexity.ai/chat/completions", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CONFIG.perplexityApiKey}`
            },
            body: JSON.stringify({
                model: 'sonar-pro', // Modelo correto da API Perplexity
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: text }
                ],
                max_tokens: 300,
                temperature: 0.1
            })
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`❌ Erro da API Perplexity: ${response.status} ${response.statusText}`, errorBody);
            return null;
        }

        const data = await response.json();
        const responseText = data.choices[0].message.content;

        console.log("🔍 Resposta bruta da IA (Perplexity):", responseText);
        
        // Melhor limpeza do JSON
        let cleanedJsonString = responseText.trim();
        if (cleanedJsonString.startsWith('```json')) {
            cleanedJsonString = cleanedJsonString.replace(/```json\s*/, '').replace(/\s*```$/, '');
        } else if (cleanedJsonString.startsWith('```')) {
            cleanedJsonString = cleanedJsonString.replace(/```\s*/, '').replace(/\s*```$/, '');
        }
        
        const result = JSON.parse(cleanedJsonString);
        
        // Validação adicional da data
        if (result.dataHoraISO) {
            const parsedDate = dayjs(result.dataHoraISO);
            if (!parsedDate.isValid()) {
                console.error("❌ Data inválida retornada pela IA:", result.dataHoraISO);
                result.dataHoraISO = null;
            }
        }
        
        return result;

    } catch (error) {
        console.error("❌ Erro ao chamar a API Perplexity:", error);
        return null;
    }
}

// --- ROTA PRINCIPAL DO WEBHOOK MELHORADA ---
app.post("/api/webhook", async (request, response) => {
    const body = request.body;
    console.log("\n📄 === NOVO REQUEST WEBHOOK (Perplexity) ===\n", JSON.stringify(body, null, 2));

    try {
        const { nome, telefone, data_hora_texto, barbeariaId } = body;
        let resultPayload;

        if (!barbeariaId) {
            return response.status(400).json({ status: 'error', message: "ID da barbearia não foi fornecido." });
        }
        
        const servicesSnapshot = await db.collection(CONFIG.collections.barbearias)
            .doc(barbeariaId)
            .collection(CONFIG.collections.services)
            .get();
            
        const servicesList = servicesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        if (servicesList.length === 0) {
            const errorResponse = { status: 'error', message: 'Ainda não há serviços configurados para esta barbearia.' };
            console.log(`\n📤 RESPOSTA ENVIADA:\n`, JSON.stringify(errorResponse, null, 2));
            return response.status(200).json(errorResponse);
        }

        const aiResult = await getIntentAndDateFromPerplexity(data_hora_texto, servicesList);

        if (!aiResult) {
            return response.status(500).json({ 
                status: 'error', 
                message: "Desculpe, não consegui processar sua solicitação com a IA." 
            });
        }
        
        const { intent, dataHoraISO, servicoNome, confianca } = aiResult;
        console.log("🤖 Resultado da IA:", { intent, dataHoraISO, servicoNome, confianca });
        
        // Melhor tratamento de data com conversão de timezone
        let parsedDate = null;
        if (dataHoraISO) {
            // A IA deve retornar em UTC, convertemos para timezone local
            parsedDate = dayjs.utc(dataHoraISO).tz(CONFIG.timezone);
            
            console.log("🕐 Conversão de timezone:");
            console.log("  Data recebida (UTC):", dataHoraISO);
            console.log("  Data convertida (local):", parsedDate.format('YYYY-MM-DD HH:mm:ss'));
            console.log("  É válida?", parsedDate.isValid());
            
            if (!parsedDate.isValid()) {
                console.error("❌ Data inválida:", dataHoraISO);
                parsedDate = null;
            }
        }
        
        const servicoEncontrado = servicoNome ? 
            servicesList.find(s => s.nome.toLowerCase() === servicoNome.toLowerCase()) : null;

        if (intent === 'agendarHorario') {
            if (!parsedDate) {
                resultPayload = { 
                    success: false, 
                    message: "Não consegui entender a data e hora. Tente algo como 'hoje às 16h' ou 'amanhã às 14h30'." 
                };
            } else if (!servicoEncontrado) {
                resultPayload = { 
                    success: false, 
                    message: `Não consegui identificar o serviço. Nossos serviços são: ${servicesList.map(s => s.nome).join(', ')}. Por favor, tente novamente.` 
                };
            } else {
                // CORREÇÃO PRINCIPAL: Usar UTC para storage mas manter timezone local para validações
                const dateForStorage = parsedDate.utc().toDate();
                const personInfo = { name: nome, phone: telefone };
                resultPayload = await handleScheduling(barbeariaId, personInfo, dateForStorage, parsedDate, servicoEncontrado.id);
            }
        } else if (intent === 'cancelarHorario') {
            const personInfo = { phone: telefone };
            resultPayload = await handleCancellation(barbeariaId, personInfo);
        } else {
            resultPayload = { 
                success: false, 
                message: "Desculpe, não entendi o que você quis dizer. Tente algo como 'quero agendar um corte hoje às 15h'." 
            };
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
        return response.status(500).json({ 
            status: 'error', 
            message: "Desculpe, ocorreu um erro interno. Tente novamente em alguns instantes." 
        });
    }
});

// --- FUNÇÃO MELHORADA DE AGENDAMENTO ---
async function handleScheduling(barbeariaId, personInfo, requestedDate, localTimeDayjs, servicoId) {
    if (!personInfo.name || !personInfo.phone) {
        return { success: false, message: "Faltam seus dados pessoais." };
    }
    
    if (!servicoId) {
        return { success: false, message: "Você precisa selecionar um serviço." };
    }
    
    // CORREÇÃO PRINCIPAL: Comparar com horário local atual com mais tolerância
    const now = dayjs().tz(CONFIG.timezone);
    const requestedDateTime = localTimeDayjs;
    
    console.log("🕐 Comparação de tempo detalhada:");
    console.log("  Agora (local):", now.format('YYYY-MM-DD HH:mm:ss'));
    console.log("  Solicitado (local):", requestedDateTime.format('YYYY-MM-DD HH:mm:ss'));
    console.log("  Diferença em minutos:", requestedDateTime.diff(now, 'minutes'));
    console.log("  É no passado?", requestedDateTime.isBefore(now));
    
    // Permitir agendamento até 15 minutos no passado para compensar delays de processamento
    const marginMinutes = 15;
    if (requestedDateTime.isBefore(now.subtract(marginMinutes, 'minutes'))) {
        const hoursDiff = now.diff(requestedDateTime, 'hours');
        if (hoursDiff > 12) {
            return { 
                success: false, 
                message: `Não é possível agendar para ${requestedDateTime.format('DD/MM/YYYY às HH:mm')}. Esta data já passou. Tente um horário futuro.` 
            };
        } else {
            return { 
                success: false, 
                message: `O horário ${requestedDateTime.format('HH:mm')} já passou. Que tal agendar para mais tarde ou amanhã?` 
            };
        }
    }

    const servicoRef = db.collection(CONFIG.collections.barbearias)
        .doc(barbeariaId)
        .collection(CONFIG.collections.services)
        .doc(servicoId);
        
    const servicoSnap = await servicoRef.get();
    if (!servicoSnap.exists) {
        return { success: false, message: "O serviço selecionado não foi encontrado." };
    }
    
    const servico = { id: servicoSnap.id, ...servicoSnap.data() };
    const duracao = parseInt(servico.duracaoMinutos, 10) || 30;

    const businessHoursCheck = await checkBusinessHours(barbeariaId, requestedDateTime, duracao);
    if (!businessHoursCheck.isOpen) {
        return { success: false, message: businessHoursCheck.message };
    }

    const hasConflict = await checkConflicts(barbeariaId, requestedDate, duracao);
    if (hasConflict) {
        console.log("⚠️ Conflito detectado, buscando horários alternativos...");
        const suggestions = await getAvailableSlots(barbeariaId, requestedDate, duracao);
        return { success: false, type: 'suggestion', message: suggestions };
    }

    await saveAppointment(barbeariaId, personInfo, requestedDate, servico);
    
    const formattedDateForUser = requestedDateTime.format('dddd, DD [de] MMMM [às] HH:mm');
    return { 
        success: true, 
        message: `Perfeito, ${personInfo.name}! Seu agendamento de ${servico.nome} foi confirmado para ${formattedDateForUser}.` 
    };
}

// Resto das funções permanecem iguais...
async function checkBusinessHours(barbeariaId, dateDayjs, duracaoMinutos) {
    const dayOfWeek = dateDayjs.day();
    const docRef = db.collection(CONFIG.collections.barbearias)
        .doc(barbeariaId)
        .collection(CONFIG.collections.config)
        .doc(String(dayOfWeek));
        
    const docSnap = await docRef.get();
    if (!docSnap.exists || !docSnap.data().aberto) {
        return { isOpen: false, message: `Desculpe, não funcionamos neste dia.` };
    }
    
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

    const fitsInMorning = (morningStart !== null && morningEnd !== null) && 
        (requestedStartMinutes >= morningStart && requestedEndMinutes <= morningEnd);
    const fitsInAfternoon = (afternoonStart !== null && afternoonEnd !== null) && 
        (requestedStartMinutes >= afternoonStart && requestedEndMinutes <= afternoonEnd);

    if (fitsInMorning || fitsInAfternoon) {
        return { isOpen: true };
    } else {
        const morning = dayConfig.InicioManha ? `das ${dayConfig.InicioManha} às ${dayConfig.FimManha}` : '';
        const afternoon = dayConfig.InicioTarde ? ` e das ${dayConfig.InicioTarde} às ${dayConfig.FimTarde}` : '';
        return { 
            isOpen: false, 
            message: `Nosso horário de funcionamento é ${morning}${afternoon}. O serviço solicitado não se encaixa nesse período.` 
        };
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
    
    const schedulesRef = db.collection(CONFIG.collections.barbearias)
        .doc(barbeariaId)
        .collection(CONFIG.collections.schedules);
    
    try {
        // Consulta simples por data (sem filtro de Status para evitar índice composto)
        const q = schedulesRef
            .where('DataHoraISO', '>=', startOfDay.toISOString())
            .where('DataHoraISO', '<=', endOfDay.toISOString());
            
        const snapshot = await q.get();
        const busySlots = [];
        
        // Filtrar por Status no código
        snapshot.docs.forEach(doc => {
            const data = doc.data();
            
            // Só considerar agendamentos confirmados
            if (data.Status !== 'Agendado') return;
            
            const startTime = dayjs(data.DataHoraISO).tz(CONFIG.timezone);
            const serviceDuration = data.duracaoMinutos || 30;
            const endTime = startTime.add(serviceDuration, 'minutes');
            busySlots.push({
                start: startTime.hour() * 60 + startTime.minute(),
                end: endTime.hour() * 60 + endTime.minute()
            });
        });
    
    } catch (error) {
        console.error("❌ Erro ao buscar agendamentos:", error);
        // Se der erro, retornar lista vazia (assumir que não há conflitos)
        const busySlots = [];
    }
    
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
    
    // Buscar em uma janela de tempo mais ampla para evitar problemas de índice
    const searchStart = new Date(requestedStart - 4 * 60 * 60 * 1000); // 4 horas antes
    const searchEnd = new Date(requestedStart + 4 * 60 * 60 * 1000);   // 4 horas depois
    
    const schedulesRef = db.collection(CONFIG.collections.barbearias)
        .doc(barbeariaId)
        .collection(CONFIG.collections.schedules);
    
    try {
        // Consulta simples por data primeiro (sem filtro de Status)
        const q = schedulesRef
            .where('DataHoraISO', '>=', searchStart.toISOString())
            .where('DataHoraISO', '<=', searchEnd.toISOString());
        
        const snapshot = await q.get();
        
        // Filtrar por Status no código (não na query)
        for (const doc of snapshot.docs) {
            const existingData = doc.data();
            
            // Só considerar agendamentos confirmados
            if (existingData.Status !== 'Agendado') {
                continue;
            }
            
            const existingStart = new Date(existingData.DataHoraISO).getTime();
            const existingEnd = existingStart + ((existingData.duracaoMinutos || 30) * 60 * 1000);
            
            // Verificar sobreposição de horários
            if (requestedStart < existingEnd && requestedEnd > existingStart) {
                console.log(`⚠️ Conflito detectado com agendamento ${doc.id}:`, {
                    existingStart: new Date(existingStart),
                    existingEnd: new Date(existingEnd),
                    requestedStart: new Date(requestedStart),
                    requestedEnd: new Date(requestedEnd)
                });
                return true;
            }
        }
        
        return false;
        
    } catch (error) {
        console.error("❌ Erro ao verificar conflitos:", error);
        
        // Fallback: consulta mais simples se houver erro
        try {
            const fallbackQ = schedulesRef
                .where('DataHoraISO', '>=', searchStart.toISOString())
                .limit(50); // Limitar resultados
                
            const fallbackSnapshot = await fallbackQ.get();
            
            for (const doc of fallbackSnapshot.docs) {
                const existingData = doc.data();
                if (existingData.Status !== 'Agendado') continue;
                
                const existingStart = new Date(existingData.DataHoraISO).getTime();
                const existingEnd = existingStart + ((existingData.duracaoMinutos || 30) * 60 * 1000);
                
                if (requestedStart < existingEnd && requestedEnd > existingStart) {
                    return true;
                }
            }
            
            return false;
        } catch (fallbackError) {
            console.error("❌ Erro no fallback também:", fallbackError);
            // Em último caso, assumir que não há conflito
            return false;
        }
    }
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
