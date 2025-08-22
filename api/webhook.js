// =================================================================
// WEBHOOK PARA AGENDAMENTO DE BARBEARIA (VERSÃO FINAL PARA VERCEL)
// =================================================================

const express = require("express");
const admin = require('firebase-admin');

// Inicializa o app Express
const app = express();
// Garante que o corpo da requisição (JSON) seja interpretado
app.use(express.json());

// =================================================================
// CONFIGURAÇÕES GERAIS
// =================================================================
const CONFIG = {
    // As credenciais são puxadas das Variáveis de Ambiente do Vercel
    firebaseCreds: JSON.parse(process.env.FIREBASE_CREDENTIALS || '{}'),
    timezone: 'America/Sao_Paulo',
    serviceDurationMinutes: 60,
    collections: {
        schedules: 'Agendamentos',
        config: 'Horarios',
    },
    contexts: {
        awaitingReschedule: 'aguardando_novo_horario'
    }
};

// =================================================================
// INICIALIZAÇÃO DO FIREBASE
// =================================================================
// Verifica se as credenciais existem e se o app já não foi inicializado
// (Importante para ambientes serverless como o Vercel)
if (CONFIG.firebaseCreds && Object.keys(CONFIG.firebaseCreds).length > 0) {
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(CONFIG.firebaseCreds)
        });
        console.log('Firebase Admin SDK inicializado com sucesso.');
    }
} else {
    console.warn('⚠️  Credenciais do Firebase não encontradas nas variáveis de ambiente.');
}

// =================================================================
// ROTA "HEALTH CHECK" (Para testes e monitoramento)
// =================================================================
app.get("/api/webhook", (request, response) => {
    console.log("PING [GET] recebido!");
    return response.status(200).send("Webhook está ativo e pronto para receber POST do Dialogflow.");
});

// =================================================================
// ROTA PRINCIPAL DO WEBHOOK (Onde o Dialogflow se conecta)
// =================================================================
app.post("/api/webhook", async (request, response) => {
    const startTime = Date.now();
    try {
        console.log("\n🔄 === NOVO REQUEST WEBHOOK [POST] ===");
        
        const body = request.body;
        validateRequest(body);
        
        const { intent, parameters, queryText, session, outputContexts } = body.queryResult;
        const intentName = intent.displayName;
        const db = admin.firestore();
        
        console.log(`🎯 Intent: ${intentName} | 💬 Texto: "${queryText}"`);

        let resultPayload;

        if (intentName.startsWith("AgendarHorario")) {
            const dateTimeParam = parameters['date-time'];
            if (!dateTimeParam) return response.json(createResponse("Não entendi a data. Por favor, diga o dia e a hora."));
            
            const personInfo = getPersonInfo(outputContexts);
            resultPayload = await handleScheduling(personInfo, dateTimeParam, db);

        } else if (intentName === "CancelarAgendamento") {
            const personInfo = getPersonInfo(outputContexts);
            resultPayload = await handleCancellation(personInfo, db);

        } else {
            resultPayload = { success: true, message: "Webhook contatado, mas sem ação definida para esta intent." };
        }
        
        const responseData = createResponse(resultPayload.message);

        if (resultPayload.success === false && intentName.startsWith("AgendarHorario")) {
            const personInfo = getPersonInfo(outputContexts);
            const contextName = `${session}/contexts/${CONFIG.contexts.awaitingReschedule}`;
            responseData.outputContexts = [{
                name: contextName,
                lifespanCount: 2,
                parameters: { nome: personInfo.name, telefone: personInfo.phone }
            }];
            console.log(`▶️ Contexto '${CONFIG.contexts.awaitingReschedule}' ativado.`);
        }
        
        const duration = (Date.now() - startTime) / 1000;
        console.log(`⏱️ Tempo de Execução: ${duration.toFixed(2)} segundos`);
        console.log(`📤 Resposta Enviada: "${resultPayload.message}"`);
        return response.json(responseData);

    } catch (error) {
        console.error("❌ Erro CRÍTICO no webhook:", error);
        return response.json(createResponse("Desculpe, ocorreu um erro interno. Tente novamente."));
    } finally {
        console.log("=== FIM REQUEST ===\n");
    }
});


// =================================================================
// LÓGICA DE NEGÓCIOS
// =================================================================
async function handleScheduling(personInfo, dateTimeParam, db) {
    if (!personInfo.name || !personInfo.phone) return { success: false, message: "Não consegui identificar seu nome e telefone. Poderia informá-los novamente?" };
    const requestedDate = extractDateFromDialogflow(dateTimeParam);
    if (!requestedDate) return { success: false, message: "Não consegui entender a data e hora. Tente um formato como 'amanhã às 14h'." };
    if (requestedDate <= new Date()) return { success: false, message: "Não é possível agendar no passado. Por favor, escolha uma data e hora futura." };

    const [businessHoursCheck, hasConflict] = await Promise.all([
        checkBusinessHours(requestedDate, db),
        checkConflicts(requestedDate, db)
    ]);

    if (!businessHoursCheck.isOpen) return { success: false, message: businessHoursCheck.message };
    if (hasConflict) return { success: false, message: "Este horário já está ocupado. Por favor, escolha outro." };

    await saveAppointment(personInfo, requestedDate, db);
    
    const formattedDateForUser = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'short', timeZone: CONFIG.timezone }).format(requestedDate);
    return { success: true, message: `Perfeito, ${personInfo.name}! Seu agendamento foi confirmado para ${formattedDateForUser}. Te vejo em breve!` };
}

async function handleCancellation(personInfo, db) {
    if (!personInfo.phone) return { success: false, message: "Para cancelar, preciso do seu telefone. Você pode me informar?" };

    const schedulesRef = db.collection(CONFIG.collections.schedules);
    const snapshot = await schedulesRef
        .where('TelefoneCliente', '==', personInfo.phone)
        .where('Status', '==', 'Agendado')
        .where('DataHoraISO', '>', new Date().toISOString())
        .orderBy('DataHoraISO', 'desc')
        .limit(1)
        .get();

    if (snapshot.empty) {
        return { success: false, message: `Não encontrei nenhum agendamento futuro no seu nome para cancelar.` };
    }

    const appointmentToCancel = snapshot.docs[0];
    await appointmentToCancel.ref.update({ Status: 'Cancelado' });
    
    const formattedDate = appointmentToCancel.data().DataHoraFormatada;
    return { success: true, message: `Tudo bem. Seu agendamento de ${formattedDate} foi cancelado.` };
}

// =================================================================
// FUNÇÕES UTILITÁRIAS
// =================================================================
async function checkBusinessHours(date, db) {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.timezone, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false });
    const parts = formatter.formatToParts(date);
    const getValue = type => parts.find(p => p.type === type)?.value;
    const dayMap = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
    const dayOfWeek = dayMap[getValue('weekday')];
    const requestedTime = parseInt(getValue('hour')) + parseInt(getValue('minute')) / 60;
    const dayName = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: CONFIG.timezone }).format(date);
    
    const docRef = db.collection(CONFIG.collections.config).doc(String(dayOfWeek));
    const doc = await docRef.get();

    if (!doc.exists) return { isOpen: false, message: `Desculpe, não funcionamos em ${dayName}.` };
    
    const dayConfig = doc.data();
    const timeToDecimal = (str) => { if (!str) return 0; const [h, m] = str.split(':').map(Number); return h + (m || 0) / 60; };

    const serviceDurationInHours = CONFIG.serviceDurationMinutes / 60;
    const isWithinHours = (time, start, end) => {
        if (!start || !end) return false;
        const startTime = timeToDecimal(start);
        const endTime = timeToDecimal(end);
        return time >= startTime && (time + serviceDurationInHours) <= endTime;
    };
    
    if (isWithinHours(requestedTime, dayConfig.InicioManha, dayConfig.FimManha) || isWithinHours(requestedTime, dayConfig.InicioTarde, dayConfig.FimTarde)) {
        return { isOpen: true };
    } else {
        const morning = `das ${dayConfig.InicioManha} às ${dayConfig.FimManha}`;
        const afternoon = dayConfig.InicioTarde ? ` e das ${dayConfig.InicioTarde} às ${dayConfig.FimTarde}` : '';
        const message = `O horário que você sugeriu está fora do nosso expediente. Em ${dayName}, nosso horário é ${morning}${afternoon}. Qual horário nesse período você gostaria de marcar?`;
        return { isOpen: false, message: message };
    }
}

async function checkConflicts(requestedDate, db) {
    const serviceDurationMs = CONFIG.serviceDurationMinutes * 60 * 1000;
    const requestedStart = requestedDate.getTime();
    
    const searchStart = new Date(requestedStart - serviceDurationMs);
    const searchEnd = new Date(requestedStart + serviceDurationMs);

    const schedulesRef = db.collection(CONFIG.collections.schedules);
    const snapshot = await schedulesRef
        .where('Status', '==', 'Agendado')
        .where('DataHoraISO', '>=', searchStart.toISOString())
        .where('DataHoraISO', '<=', searchEnd.toISOString())
        .get();

    if (snapshot.empty) return false;

    const requestedEnd = requestedStart + serviceDurationMs;
    for (const doc of snapshot.docs) {
        const existingStart = new Date(doc.data().DataHoraISO).getTime();
        const existingEnd = existingStart + serviceDurationMs;
        if ((requestedStart < existingEnd) && (requestedEnd > existingStart)) {
            console.log(`💥 CONFLITO ENCONTRADO com agendamento das ${doc.data().DataHoraISO}`);
            return true;
        }
    }
    
    return false;
}

async function saveAppointment(personInfo, requestedDate, db) {
    const newAppointment = {
        NomeCliente: personInfo.name,
        TelefoneCliente: personInfo.phone,
        DataHoraISO: requestedDate.toISOString(),
        DataHoraFormatada: new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short', timeZone: CONFIG.timezone }).format(requestedDate),
        Status: 'Agendado',
        TimestampAgendamento: new Date().toISOString()
    };
    
    await db.collection(CONFIG.collections.schedules).add(newAppointment);
    console.log(`✅ Agendamento salvo no Firestore para: ${personInfo.name}`);
}

function getPersonInfo(contexts) {
    const info = { name: null, phone: null };
    if (!contexts) return info;
    for (const context of contexts) {
        const params = context.parameters;
        if (params) {
            info.name = info.name || params.person?.name || params.nome;
            info.phone = info.phone || params.telefone || params['phone-number'];
        }
    }
    return info;
}

function extractDateFromDialogflow(param) {
    if (!param) return null;
    let dateString = '';
    if (typeof param === 'string') { dateString = param; } 
    else if (typeof param === 'object' && param !== null) { dateString = param.date_time || param.startDateTime; }
    if (dateString) { const date = new Date(dateString); return isNaN(date.getTime()) ? null : date; }
    return null;
}
function createResponse(text) {
    const responsePayload = {
        // Este é um campo legado, mas ainda muito útil para garantir compatibilidade.
        fulfillmentText: text,

        // Este é o formato moderno e correto.
        fulfillmentMessages: [{
            text: {
                text: [text]
            }
        }],

        // Especifica a fonte da resposta. Ajuda a evitar conflitos.
        source: "webhook-barbearia-vercel"
    };
    return responsePayload;
}


function validateRequest(body) { 
    if (!body || !body.queryResult || !body.queryResult.intent || !body.queryResult.intent.displayName) { 
        throw new Error("Requisição do Dialogflow inválida."); 
    } 
}

// =================================================================
// EXPORTA O APP PARA SER USADO PELO VERCEL
// =================================================================
module.exports = app;
