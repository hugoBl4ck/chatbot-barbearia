// =================================================================
// WEBHOOK PARA AGENDAMENTO DE BARBEARIA (VERSÃO FIREBASE)
// =================================================================

const express = require("express");
const admin = require('firebase-admin');

// --- Configuração da Aplicação ---
const app = express();
app.use(express.json());

// =================================================================
// CONFIGURAÇÕES GERAIS
// =================================================================
const CONFIG = {
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
// INICIALIZAÇÃO DO FIREBASE E SERVIDOR
// =================================================================
// A inicialização só ocorre se as credenciais existirem
if (CONFIG.firebaseCreds && Object.keys(CONFIG.firebaseCreds).length > 0) {
    admin.initializeApp({
      credential: admin.credential.cert(CONFIG.firebaseCreds)
    });
    const db = admin.firestore();
    console.log('✅ Conectado ao Firebase/Firestore.');
} else {
    console.warn('⚠️  Credenciais do Firebase não encontradas. O webhook funcionará sem conexão com o banco de dados.');
}


validateEnvironment();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook da barbearia rodando na porta ${PORT}`));


// =================================================================
// ROTA PRINCIPAL DO WEBHOOK
// =================================================================
app.post("/webhook", async (request, response) => {
    const startTime = Date.now();
    try {
        console.log("\n🔄 === NOVO REQUEST WEBHOOK ===");
        validateRequest(request.body);

        // Adicionado para depuração fácil
        console.log("DADOS COMPLETOS RECEBIDOS:", JSON.stringify(request.body, null, 2));

        const { intent, parameters, queryText, session, outputContexts } = request.body.queryResult;
        const intentName = intent.displayName;
        const db = admin.firestore(); // Garante que temos a instância do DB
        
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
            resultPayload = { success: true, message: "Webhook contatado, mas sem ação definida." };
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
// LÓGICA DE NEGÓCIOS (ADAPTADA PARA FIRESTORE)
// =================================================================

async function handleScheduling(personInfo, dateTimeParam, db) {
    if (!personInfo.name || !personInfo.phone) return { success: false, message: "Não consegui identificar seu nome e telefone. Poderia informá-los novamente?" };
    const requestedDate = extractDateFromDialogflow(dateTimeParam);
    if (!requestedDate) return { success: false, message: "Não consegui entender a data e hora. Tente um formato como 'amanhã às 14h'." };
    if (requestedDate <= new Date()) return { success: false, message: "Não é possível agendar no passado. Por favor, escolha uma data e hora futura." };

    const businessHoursCheck = await checkBusinessHours(requestedDate, db);
    if (!businessHoursCheck.isOpen) return { success: false, message: businessHoursCheck.message };

    const hasConflict = await checkConflicts(requestedDate, db);
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
        console.log(`- Nenhum agendamento futuro encontrado para o telefone ${personInfo.phone}.`);
        return { success: false, message: `Não encontrei nenhum agendamento futuro no seu nome para cancelar.` };
    }

    const appointmentToCancel = snapshot.docs[0];
    await appointmentToCancel.ref.update({ Status: 'Cancelado' });
    
    const formattedDate = appointmentToCancel.data().DataHoraFormatada;
    console.log(`✅ Agendamento de ${formattedDate} cancelado.`);
    return { success: true, message: `Tudo bem. Seu agendamento de ${formattedDate} foi cancelado.` };
}


// =================================================================
// FUNÇÕES UTILITÁRIAS (ADAPTADAS PARA FIRESTORE)
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

    if (!doc.exists) {
        return { isOpen: false, message: `Desculpe, não funcionamos em ${dayName}.` };
    }
    
    const dayConfig = doc.data();
    const timeToDecimal = (str) => { if (!str) return 0; const [h, m] = str.split(':').map(Number); return h + (m || 0) / 60; };

    const isWithinHours = (time, start, end) => time >= timeToDecimal(start) && time < timeToDecimal(end);
    if (isWithinHours(requestedTime, dayConfig.InicioManha, dayConfig.FimManha) || isWithinHours(requestedTime, dayConfig.InicioTarde, dayConfig.FimTarde)) {
        return { isOpen: true };
    } else {
        const morning = `das ${dayConfig.InicioManha} às ${dayConfig.FimManha}`;
        const afternoon = dayConfig.InicioTarde ? ` e das ${dayConfig.InicioTarde} às ${dayConfig.FimTarde}` : '';
        return { isOpen: false, message: `Estamos abertos em ${dayName}, mas nosso horário é ${morning}${afternoon}.` };
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

    if (snapshot.empty) {
        console.log("✅ Nenhum conflito em potencial encontrado. Horário disponível.");
        return false;
    }

    const requestedEnd = requestedStart + serviceDurationMs;
    for (const doc of snapshot.docs) {
        const existingStart = new Date(doc.data().DataHoraISO).getTime();
        const existingEnd = existingStart + serviceDurationMs;
        if ((requestedStart < existingEnd) && (requestedEnd > existingStart)) {
            console.log(`💥 CONFLITO ENCONTRADO com agendamento das ${doc.data().DataHoraISO}`);
            return true;
        }
    }
    
    console.log("✅ Nenhum conflito real encontrado após verificação. Horário disponível.");
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

// Funções que não mudam
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
function createResponse(text) { return { fulfillmentMessages: [{ text: { text: [text] } }] }; }
function validateRequest(body) { if (!body?.queryResult?.intent?.displayName) { throw new Error("Requisição do Dialogflow inválida."); } }
function validateEnvironment() { if (!process.env.FIREBASE_CREDENTIALS) { console.error('❌ Variável de ambiente FIREBASE_CREDENTIALS faltando.'); } try { JSON.parse(process.env.FIREBASE_CREDENTIALS || '{}'); } catch (e) { console.error('❌ FIREBASE_CREDENTIALS não é um JSON válido.'); } }
