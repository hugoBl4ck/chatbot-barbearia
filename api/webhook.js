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
        
        const systemPrompt = `Você é um assistente de agendamento para barbearias. 
        Data/hora atual: ${currentDateTime.format('YYYY-MM-DD HH:mm')} (${CONFIG.timezone})
        Lista de serviços válidos: [${serviceNames}]
        
        Analise a mensagem do usuário e retorne APENAS um objeto JSON válido:
        {
            "intent": "agendarHorario" | "cancelarHorario" | "informacao",
            "dataHoraISO": "YYYY-MM-DDTHH:mm:ss.sssZ" | null,
            "servicoNome": "Nome do Serviço" | null,
            "confianca": 0.0 a 1.0
        }
        
        REGRAS IMPORTANTES:
        - Para "hoje", use a data atual: ${currentDateTime.format('YYYY-MM-DD')}
        - Para "amanhã", use: ${currentDateTime.add(1, 'day').format('YYYY-MM-DD')}
        - Sempre retorne dataHoraISO no formato ISO com timezone UTC
        - Se não conseguir identificar data/hora, retorne null
        - Se serviço não estiver na lista, retorne null para servicoNome`;
        
        const response = await fetch("https://api.perplexity.ai/chat/completions", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CONFIG.perplexityApiKey}`
            },
            body: JSON.stringify({
                model: 'llama-3.1-sonar-small-128k-online', // Modelo mais atual
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
        
        // Melhor tratamento de data
        let parsedDate = null;
        if (dataHoraISO) {
            parsedDate = dayjs(dataHoraISO).tz(CONFIG.timezone);
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
    
    // CORREÇÃO PRINCIPAL: Comparar com horário local atual
    const now = dayjs().tz(CONFIG.timezone);
    const requestedDateTime = localTimeDayjs;
    
    console.log("🕐 Comparação de tempo:");
    console.log("  Agora (local):", now.format('YYYY-MM-DD HH:mm:ss'));
    console.log("  Solicitado (local):", requestedDateTime.format('YYYY-MM-DD HH:mm:ss'));
    console.log("  É no passado?", requestedDateTime.isBefore(now));
    
    // Permitir agendamento até 30 minutos no passado para compensar delays
    if (requestedDateTime.isBefore(now.subtract(30, 'minutes'))) {
        return { 
            success: false, 
            message: `Não é possível agendar para ${requestedDateTime.format('DD/MM às HH:mm')}. Este horário já passou. Tente um horário futuro.` 
        };
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

// Demais funções permanecem iguais (getAvailableSlots, findAvailableSlotsForDay, handleCancellation, checkConflicts, saveAppointment)

module.exports = app;
