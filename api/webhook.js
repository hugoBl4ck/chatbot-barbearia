// =================================================================
// WEBHOOK MULTI-TENANT COM IA PERPLEXITY - VERSÃO 3.1 CORRIGIDA
// =================================================================
const express = require("express");
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

// Inicializa o Firebase Admin SDK
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(CONFIG.firebaseCreds) });
}
const db = admin.firestore();

// --- FUNÇÃO COM IA PERPLEXITY MELHORADA ---
async function getIntentAndDateFromPerplexity(text, servicesList) {
    if (!CONFIG.perplexityApiKey) {
        console.error("❌ Chave da API do Perplexity não configurada.");
        // FALLBACK: Retorna intent básico para não quebrar o fluxo
        return {
            intent: 'agendarHorario',
            dataHoraISO: null,
            servicoNome: servicesList.length > 0 ? servicesList[0].nome : null
        };
    }

    try {
        const serviceNames = servicesList.map(s => s.nome).join(', ');
        const currentDate = new Date().toISOString();

        const systemPrompt = `Você é um assistente de agendamento para barbearias. Sua tarefa é analisar a mensagem do usuário e extrair informações, retornando APENAS um objeto JSON válido. 

A lista de serviços válidos é: [${serviceNames}]. 
A data de referência é ${currentDate} no fuso horário ${CONFIG.timezone}. 

IMPORTANTE: Retorne SEMPRE um JSON válido com esta estrutura exata:
{
  "intent": "agendarHorario" | "cancelarHorario" | "informacao",
  "dataHoraISO": "YYYY-MM-DDTHH:mm:ss.sssZ" | null,
  "servicoNome": "Nome do Serviço" | null
}

Se um serviço não for mencionado, use o primeiro da lista. Se a data/hora não for clara, retorne null para dataHoraISO.`;
        
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
                max_tokens: 300,
                temperature: 0.1
            })
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`❌ Erro da API Perplexity: ${response.status} ${response.statusText}`, errorBody);
            throw new Error('API Perplexity falhou');
        }

        const data = await response.json();
        const responseText = data.choices[0].message.content;

        console.log("🔍 Resposta bruta da IA (Perplexity):", responseText);
        
        // Limpeza mais robusta do JSON
        let cleanedJsonString = responseText
            .replace(/```json/g, '')
            .replace(/```/g, '')
            .replace(/^[^{]*/, '') // Remove texto antes do primeiro {
            .replace(/[^}]*$/, '') // Remove texto depois do último }
            .trim();

        return JSON.parse(cleanedJsonString);

    } catch (error) {
        console.error("❌ Erro ao chamar a API Perplexity:", error);
        // FALLBACK melhorado: Tenta extrair informação básica
        return {
            intent: text.toLowerCase().includes('cancel') ? 'cancelarHorario' : 'agendarHorario',
            dataHoraISO: null,
            servicoNome: servicesList.length > 0 ? servicesList[0].nome : null
        };
    }
}

// --- ROTA PRINCIPAL DO WEBHOOK CORRIGIDA ---
app.post("/api/webhook", async (request, response) => {
    const body = request.body;
    console.log("\n📄 === NOVO REQUEST WEBHOOK (Perplexity) ===\n", JSON.stringify(body, null, 2));

    try {
        const { nome, telefone, data_hora_texto, barbeariaId: slugOrId } = body;
        let resultPayload;

        console.log(`🏪 Barbearia recebida: "${slugOrId}"`);

        if (!slugOrId) {
            return response.status(400).json({ 
                status: 'error', 
                message: "ID da barbearia não foi fornecido.",
                type: null 
            });
        }

        // Busca a barbearia pelo slug ou pelo ID do documento
        let barbeariaDocId = null;
        
        try {
            // Primeiro tenta como ID direto (caso seja "01", etc)
            const directDocRef = db.collection(CONFIG.collections.barbearias).doc(slugOrId);
            const directDocSnap = await directDocRef.get();
            
            if (directDocSnap.exists) {
                barbeariaDocId = slugOrId;
                console.log(`✅ Barbearia encontrada por ID direto: ${barbeariaDocId}`);
            } else {
                // Se não encontrou, busca pelo campo slug
                const querySnapshot = await db.collection(CONFIG.collections.barbearias)
                    .where('slug', '==', slugOrId)
                    .limit(1)
                    .get();
                
                if (!querySnapshot.empty) {
                    barbeariaDocId = querySnapshot.docs[0].id;
                    console.log(`✅ Barbearia encontrada por slug: ${slugOrId} → ID: ${barbeariaDocId}`);
                } else {
                    console.log(`❌ Barbearia não encontrada: ${slugOrId}`);
                    return response.status(200).json({ 
                        status: 'error', 
                        message: "Barbearia não encontrada. Verifique o ID/slug informado.",
                        type: null 
                    });
                }
            }
        } catch (error) {
            console.error("❌ Erro ao buscar barbearia:", error);
            return response.status(500).json({ 
                status: 'error', 
                message: "Erro interno ao buscar barbearia.",
                type: null 
            });
        }

        if (!data_hora_texto || data_hora_texto.trim() === '') {
            return response.status(200).json({ 
                status: 'error', 
                message: "Por favor, me diga o que você gostaria de fazer. Exemplo: 'Quero agendar um corte para amanhã às 15h'",
                type: null 
            });
        }
        
        // Busca serviços usando o ID real do documento
        const servicesSnapshot = await db.collection(CONFIG.collections.barbearias)
            .doc(barbeariaDocId)
            .collection(CONFIG.collections.services)
            .get();
            
        const servicesList = servicesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        if (servicesList.length === 0) {
            const errorResponse = { 
                status: 'error', 
                message: 'Ainda não há serviços configurados para esta barbearia.',
                type: null 
            };
            console.log(`\n📤 RESPOSTA ENVIADA:\n`, JSON.stringify(errorResponse, null, 2));
            return response.status(200).json(errorResponse);
        }

        // Chama a IA
        const aiResult = await getIntentAndDateFromPerplexity(data_hora_texto, servicesList);
        console.log("🤖 Resultado da IA:", aiResult);
        
        // DEBUG: Vamos ver todas as configurações de horários
        console.log("🔍 DEBUG: Listando TODOS os documentos de horários:");
        const horariosSnapshot = await db.collection(CONFIG.collections.barbearias)
            .doc(barbeariaId)
            .collection(CONFIG.collections.config)
            .get();
            
        console.log(`📄 Total de documentos encontrados: ${horariosSnapshot.docs.length}`);
        horariosSnapshot.docs.forEach(doc => {
            console.log(`   Documento ID: "${doc.id}" -> Dados:`, doc.data());
        });

        if (!aiResult) {
            return response.status(200).json({ 
                status: 'error', 
                message: "Desculpe, não consegui processar sua solicitação. Tente ser mais específico.",
                type: null 
            });
        }
        
        const { intent, dataHoraISO, servicoNome } = aiResult;
        const parsedDate = dataHoraISO ? dayjs(dataHoraISO).tz(CONFIG.timezone) : null;
        const servicoEncontrado = servicoNome ? 
            servicesList.find(s => s.nome.toLowerCase() === servicoNome.toLowerCase()) : 
            servicesList[0]; // Usa o primeiro serviço como padrão

        console.log("📅 DEBUG COMPLETO DA DATA:");
        console.log("   - dataHoraISO recebido da IA:", dataHoraISO);
        console.log("   - parsedDate após conversão:", parsedDate ? parsedDate.format('DD/MM/YYYY HH:mm dddd') : 'null');
        console.log("   - parsedDate.day():", parsedDate ? parsedDate.day() : 'null');
        console.log("   - Timezone configurado:", CONFIG.timezone);
        console.log("   - Data atual para referência:", dayjs().tz(CONFIG.timezone).format('DD/MM/YYYY HH:mm dddd'));
        console.log("🔧 Serviço encontrado:", servicoEncontrado?.nome);

        if (intent === 'agendarHorario') {
            if (!parsedDate || !parsedDate.isValid()) {
                resultPayload = { 
                    success: false, 
                    message: "Não consegui entender a data e hora. Tente algo como 'amanhã às 16h' ou 'segunda-feira às 14h30'.",
                    type: null 
                };
            } else if (!servicoEncontrado) {
                resultPayload = { 
                    success: false, 
                    message: `Não consegui identificar o serviço. Nossos serviços são: ${servicesList.map(s => s.nome).join(', ')}. Por favor, tente novamente.`,
                    type: null 
                };
            } else {
                // Validação de dados pessoais
                if (!nome || !telefone) {
                    resultPayload = { 
                        success: false, 
                        message: "Para fazer o agendamento, preciso do seu nome e telefone.",
                        type: null 
                    };
                } else {
                    const dateForStorage = parsedDate.utc().toDate();
                    const personInfo = { name: nome, phone: telefone };
                    resultPayload = await handleScheduling(barbeariaDocId, personInfo, dateForStorage, parsedDate, servicoEncontrado.id);
                }
            }
        } else if (intent === 'cancelarHorario') {
            if (!telefone) {
                resultPayload = { 
                    success: false, 
                    message: "Para cancelar um agendamento, preciso do seu telefone.",
                    type: null 
                };
            } else {
                const personInfo = { phone: telefone };
                resultPayload = await handleCancellation(barbeariaDocId, personInfo);
            }
        } else {
            resultPayload = { 
                success: false, 
                message: "Não entendi o que você quer fazer. Você pode agendar um horário ou cancelar um agendamento existente.",
                type: null 
            };
        }
        
        // Formatação da resposta final
        const responseData = { 
            status: resultPayload.success ? 'success' : 'error', 
            message: resultPayload.message || "Ocorreu um erro inesperado.",
            type: resultPayload.type || null 
        };
        
        console.log(`\n📤 RESPOSTA ENVIADA PARA O TYPEBOT:\n`, JSON.stringify(responseData, null, 2));
        console.log(`\n🔍 VARIÁVEIS QUE DEVERIAM SER DEFINIDAS:`);
        console.log(`   - @webhook_status: "${responseData.status}"`);
        console.log(`   - @webhook_message: "${responseData.message}"`);
        console.log(`   - @webhook_type: "${responseData.type}"`);
        
        return response.status(200).json(responseData);

    } catch (error) {
        console.error("❌ Erro CRÍTICO no webhook:", error);
        return response.status(200).json({ 
            status: 'error', 
            message: "Desculpe, ocorreu um erro interno. Tente novamente em alguns instantes.",
            type: null 
        });
    }
});

// --- FUNÇÃO DE AGENDAMENTO MELHORADA ---
async function handleScheduling(barbeariaId, personInfo, requestedDate, localTimeDayjs, servicoId) {
    try {
        // Validações básicas
        if (!personInfo.name || !personInfo.phone) {
            return { success: false, message: "Faltam seus dados pessoais.", type: null };
        }
        
        if (!servicoId) {
            return { success: false, message: "Você precisa selecionar um serviço.", type: null };
        }
        
        if (requestedDate.getTime() <= new Date().getTime()) {
            return { success: false, message: "Não é possível agendar no passado.", type: null };
        }

        // Busca dados do serviço
        const servicoRef = db.collection(CONFIG.collections.barbearias)
            .doc(barbeariaId)
            .collection(CONFIG.collections.services)
            .doc(servicoId);
            
        const servicoSnap = await servicoRef.get();
        if (!servicoSnap.exists) {
            return { success: false, message: "O serviço selecionado não foi encontrado.", type: null };
        }
        
        const servico = { id: servicoSnap.id, ...servicoSnap.data() };
        const duracao = parseInt(servico.duracaoMinutos, 10) || 30;

        // Verifica horário de funcionamento
        const businessHoursCheck = await checkBusinessHours(barbeariaId, localTimeDayjs, duracao);
        if (!businessHoursCheck.isOpen) {
            return { success: false, message: businessHoursCheck.message, type: null };
        }

        // Verifica conflitos
        const hasConflict = await checkConflicts(barbeariaId, requestedDate, duracao);
        if (hasConflict) {
            console.log("⚠️ Conflito detectado, buscando horários alternativos...");
            const suggestions = await getAvailableSlots(barbeariaId, requestedDate, duracao);
            return { 
                success: false, 
                type: 'suggestion', 
                message: suggestions 
            };
        }

        // Salva o agendamento
        await saveAppointment(barbeariaId, personInfo, requestedDate, servico);
        
        const formattedDateForUser = dayjs(requestedDate).tz(CONFIG.timezone).format('dddd, DD [de] MMMM [às] HH:mm');
        return { 
            success: true, 
            message: `Perfeito, ${personInfo.name}! Seu agendamento de ${servico.nome} foi confirmado para ${formattedDateForUser}.`,
            type: null 
        };
        
    } catch (error) {
        console.error("❌ Erro no handleScheduling:", error);
        return { 
            success: false, 
            message: "Ocorreu um erro ao processar seu agendamento. Tente novamente.",
            type: null 
        };
    }
}

// --- FUNÇÃO DE SUGESTÕES MELHORADA ---
async function getAvailableSlots(barbeariaId, requestedDate, duracaoMinutos) {
    try {
        const requestedDateDayjs = dayjs(requestedDate).tz(CONFIG.timezone);
        let availableSlots = await findAvailableSlotsForDay(barbeariaId, requestedDateDayjs, duracaoMinutos);
        
        // Tenta para o mesmo dia
        if (availableSlots.length > 0) {
            const dateStr = requestedDateDayjs.format('DD/MM');
            const slotsText = availableSlots.slice(0, 3).join(', ');
            return `Este horário já está ocupado. 😔\n\nQue tal um destes horários para ${dateStr}? ${slotsText}`;
        }
        
        // Tenta para o dia seguinte
        const tomorrow = requestedDateDayjs.add(1, 'day');
        availableSlots = await findAvailableSlotsForDay(barbeariaId, tomorrow, duracaoMinutos);
        
        if (availableSlots.length > 0) {
            const dateStr = tomorrow.format('DD/MM');
            const slotsText = availableSlots.slice(0, 3).join(', ');
            return `Este horário já está ocupado e não há mais vagas hoje. 😔\n\nQue tal para ${dateStr}? Horários: ${slotsText}`;
        }
        
        // Tenta próximos 3 dias
        for (let i = 2; i <= 4; i++) {
            const futureDay = requestedDateDayjs.add(i, 'day');
            availableSlots = await findAvailableSlotsForDay(barbeariaId, futureDay, duracaoMinutos);
            
            if (availableSlots.length > 0) {
                const dateStr = futureDay.format('DD/MM');
                const slotsText = availableSlots.slice(0, 3).join(', ');
                return `Este horário já está ocupado. 😔\n\nEncontrei horários para ${dateStr}: ${slotsText}`;
            }
        }
        
        return "Este horário já está ocupado. 😔\n\nInfelizmente não encontrei horários disponíveis nos próximos dias. Entre em contato conosco para mais opções.";
        
    } catch (error) {
        console.error("❌ Erro ao buscar horários disponíveis:", error);
        return "Este horário já está ocupado. 😔\n\nTente outro horário ou entre em contato conosco.";
    }
}

// Mantém todas as outras funções iguais (checkBusinessHours, findAvailableSlotsForDay, handleCancellation, checkConflicts, saveAppointment)
async function checkBusinessHours(barbeariaId, dateDayjs, duracaoMinutos) {
    const dayOfWeek = dateDayjs.day();
    
    // DEBUG: Vamos ver o que está acontecendo
    console.log("🔍 DEBUG checkBusinessHours:");
    console.log("   - Data recebida:", dateDayjs.format('DD/MM/YYYY HH:mm dddd'));
    console.log("   - Dia da semana (dayjs.day()):", dayOfWeek);
    console.log("   - Buscando documento:", String(dayOfWeek));
    
    const docRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.config).doc(String(dayOfWeek));
    const docSnap = await docRef.get();
    
    console.log("   - Documento existe?", docSnap.exists);
    if (docSnap.exists) {
        console.log("   - Dados do documento:", docSnap.data());
    }
    
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
    if (!personInfo.phone) return { success: false, message: "Para cancelar, preciso do seu telefone.", type: null };
    const schedulesRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.schedules);
    const q = schedulesRef
        .where('TelefoneCliente', '==', personInfo.phone)
        .where('Status', '==', 'Agendado')
        .where('DataHoraISO', '>', new Date().toISOString());
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
